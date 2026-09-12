/**
 * Setup families that emit zone-cards onto the MAP path.
 * GET /ta stays overlay (signal: false). These detectors write cards, not /ta.
 *
 * PAPER_SETUPS default = sd,breakout,reversal.
 * PAPER_SETUPS=0 or sd → old S/D-only detector (A/B rollback).
 * Discretionary (elliott/moon/harmonic/gann) never emit. ICT stays confirm.
 */
import type { BriefKline } from "../feed/bb/brief";
import { parseZoneSetup, type ZoneCard, type ZoneSetup, type ZoneSide } from "./card";
import {
  ZONE_DETECT,
  atrSma,
  barsFromKlines,
  buildGeometryCard,
  detectZoneCards,
  type DetectBar,
  type DetectOpts,
} from "./detect";

export const SETUP_IDS = ["sd", "breakout", "reversal"] as const;
export type SetupId = ZoneSetup;

const SETUP_ALIASES: Record<string, SetupId> = {
  sd: "sd",
  "supply_demand": "sd",
  "supply-demand": "sd",
  breakout: "breakout",
  breakouts: "breakout",
  bo: "breakout",
  reversal: "reversal",
  rv: "reversal",
};

export const DEFAULT_SETUPS: readonly SetupId[] = ["sd", "breakout", "reversal"];

/** PAPER_SETUPS=0 → sd only. Unset → all three. Comma list intersects known ids. */
export function paperSetups(): SetupId[] {
  const raw = process.env.PAPER_SETUPS?.trim();
  if (raw == null || raw === "") return [...DEFAULT_SETUPS];
  if (raw === "0") return ["sd"];
  const out: SetupId[] = [];
  const seen = new Set<SetupId>();
  for (const token of raw.split(",")) {
    const id = SETUP_ALIASES[token.trim().toLowerCase()];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : ["sd"];
}

export function cardSetup(card: Pick<ZoneCard, "setup" | "zoneId">): SetupId {
  if (card.setup) return parseZoneSetup(card.setup);
  const match = /-(bo|rv|sd)-\d{8}-\d{2}$/i.exec(card.zoneId);
  if (match) {
    return match[1]!.toLowerCase() === "bo"
      ? "breakout"
      : match[1]!.toLowerCase() === "rv"
        ? "reversal"
        : "sd";
  }
  return "sd";
}

type Swing = { index: number; price: number };

function fractalSwings(bars: DetectBar[]): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1]!;
    const bar = bars[i]!;
    const next = bars[i + 1]!;
    if (bar.high > prev.high && bar.high > next.high) highs.push({ index: i, price: bar.high });
    if (bar.low < prev.low && bar.low < next.low) lows.push({ index: i, price: bar.low });
  }
  return { highs, lows };
}

function lastSwingBefore(points: Swing[], index: number): Swing | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]!.index < index) return points[i]!;
  }
  return null;
}

function barBody(bar: DetectBar): number {
  return Math.abs(bar.close - bar.open);
}

function capSetup(cards: ZoneCard[], cap: number): ZoneCard[] {
  const sorted = [...cards].sort((a, b) => b.baseStartTs - a.baseStartTs || a.zoneId.localeCompare(b.zoneId));
  const picked: ZoneCard[] = [];
  for (const card of sorted) {
    if (picked.length >= cap) break;
    const overlap = picked.some((other) => (
      other.side === card.side
      && other.zoneLow <= card.zoneHigh
      && other.zoneHigh >= card.zoneLow
    ));
    if (overlap) continue;
    picked.push(card);
  }
  return picked;
}

/**
 * Break-and-retest. Bull close through swing high → demand card under the level.
 * Bear close through swing low → supply card above the level. ARM waits for proximal.
 */
export function detectBreakoutCards(bars: DetectBar[], opts: DetectOpts): ZoneCard[] {
  const symbol = opts.symbol.trim().toUpperCase();
  const cap = opts.maxZones ?? ZONE_DETECT.maxZonesPerSymbol;
  if (bars.length < ZONE_DETECT.atrPeriod + 3) return [];
  const { highs, lows } = fractalSwings(bars);
  const found: ZoneCard[] = [];
  const seqByDay = new Map<string, number>();
  const padAtr = ZONE_DETECT.departureMinAtr;
  for (let i = ZONE_DETECT.atrPeriod + 1; i < bars.length; i++) {
    const bar = bars[i]!;
    if (!bar.confirm) continue;
    const atr = atrSma(bars, i - 1);
    if (atr == null) continue;
    const prev = bars[i - 1];
    if (!prev) continue;
    const pad = atr * padAtr;
    const priorHigh = lastSwingBefore(highs, i);
    const priorLow = lastSwingBefore(lows, i);
    let side: ZoneSide | null = null;
    let level = 0;
    if (priorHigh && bar.close > priorHigh.price + pad && prev.close <= priorHigh.price) {
      side = "demand";
      level = priorHigh.price;
    } else if (priorLow && bar.close < priorLow.price - pad && prev.close >= priorLow.price) {
      side = "supply";
      level = priorLow.price;
    }
    if (!side) continue;
    const height = Math.max(atr * 0.5, Math.abs(bar.close - level));
    const zoneLow = side === "demand" ? level - height : level;
    const zoneHigh = side === "demand" ? level : level + height;
    const departureAtr = Math.abs(bar.close - level) / atr;
    const dayKey = `${side}:${new Date(bar.startTs).toISOString().slice(0, 10)}`;
    const seq = (seqByDay.get(dayKey) ?? 0) + 1;
    const card = buildGeometryCard({
      symbol,
      tf: opts.tf,
      intervalMs: opts.intervalMs,
      side,
      setup: "breakout",
      zoneLow,
      zoneHigh,
      baseStartTs: bar.startTs,
      baseEndTs: bar.startTs + opts.intervalMs,
      atr,
      later: bars.slice(i + 1),
      impulseBody: barBody(bar),
      departureAtr,
      seq,
    });
    if (!card) continue;
    seqByDay.set(dayKey, seq);
    found.push(card);
  }
  return capSetup(found, cap);
}

function reversalTags(prev: DetectBar, last: DetectBar): string[] {
  const range = last.high - last.low;
  if (range <= 0) return ["doji"];
  const body = Math.abs(last.close - last.open);
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  const tags: string[] = [];
  if (lower >= body * 2 && last.close >= last.low + range * 0.66) tags.push("hammer");
  if (upper >= body * 2 && last.close <= last.high - range * 0.66) tags.push("shooting_star");
  const prevBody = Math.abs(prev.close - prev.open);
  const prevBear = prev.close < prev.open;
  const prevBull = prev.close > prev.open;
  const lastBull = last.close > last.open;
  const lastBear = last.close < last.open;
  if (prevBear && lastBull && last.open <= prev.close && last.close >= prev.open && body > prevBody) {
    tags.push("bullish_engulfing");
  }
  if (prevBull && lastBear && last.open >= prev.close && last.close <= prev.open && body > prevBody) {
    tags.push("bearish_engulfing");
  }
  return tags;
}

/** Candle reversal at a swing. Hammer/engulf at swing low → demand; star/engulf at swing high → supply. */
export function detectReversalCards(bars: DetectBar[], opts: DetectOpts): ZoneCard[] {
  const symbol = opts.symbol.trim().toUpperCase();
  const cap = opts.maxZones ?? ZONE_DETECT.maxZonesPerSymbol;
  if (bars.length < ZONE_DETECT.atrPeriod + 3) return [];
  const { highs, lows } = fractalSwings(bars);
  const found: ZoneCard[] = [];
  const seqByDay = new Map<string, number>();
  for (let i = ZONE_DETECT.atrPeriod + 1; i < bars.length; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1];
    if (!bar.confirm || !prev) continue;
    const atr = atrSma(bars, i - 1);
    if (atr == null) continue;
    const tags = reversalTags(prev, bar);
    const nearLow = lastSwingBefore(lows, i + 1);
    const nearHigh = lastSwingBefore(highs, i + 1);
    const atLow = nearLow != null && bar.low <= nearLow.price + atr * 0.15;
    const atHigh = nearHigh != null && bar.high >= nearHigh.price - atr * 0.15;
    let side: ZoneSide | null = null;
    if (atLow && (tags.includes("hammer") || tags.includes("bullish_engulfing"))) side = "demand";
    if (atHigh && (tags.includes("shooting_star") || tags.includes("bearish_engulfing"))) side = "supply";
    if (!side) continue;
    const zoneLow = Math.min(prev.low, bar.low);
    const zoneHigh = Math.max(prev.high, bar.high);
    const dayKey = `${side}:${new Date(bar.startTs).toISOString().slice(0, 10)}`;
    const seq = (seqByDay.get(dayKey) ?? 0) + 1;
    const card = buildGeometryCard({
      symbol,
      tf: opts.tf,
      intervalMs: opts.intervalMs,
      side,
      setup: "reversal",
      zoneLow,
      zoneHigh,
      baseStartTs: prev.startTs,
      baseEndTs: bar.startTs + opts.intervalMs,
      atr,
      later: bars.slice(i + 1),
      impulseBody: barBody(bar),
      departureAtr: 0,
      seq,
    });
    if (!card) continue;
    seqByDay.set(dayKey, seq);
    found.push(card);
  }
  return capSetup(found, cap);
}

export function detectAllSetups(bars: DetectBar[], opts: DetectOpts): ZoneCard[] {
  const enabled = paperSetups();
  const out: ZoneCard[] = [];
  if (enabled.includes("sd")) out.push(...detectZoneCards(bars, opts));
  if (enabled.includes("breakout")) out.push(...detectBreakoutCards(bars, opts));
  if (enabled.includes("reversal")) out.push(...detectReversalCards(bars, opts));
  out.sort((a, b) => b.baseStartTs - a.baseStartTs || a.zoneId.localeCompare(b.zoneId));
  return out;
}

export function detectAllSetupsFromKlines(rows: BriefKline[], opts: DetectOpts): ZoneCard[] {
  return detectAllSetups(barsFromKlines(rows), opts);
}
