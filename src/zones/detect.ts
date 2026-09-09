import {
  parseZoneCard,
  type CancelCode,
  type ZoneCard,
  type ZoneFreshness,
  type ZoneSide,
} from "./card";
import type { BriefKline } from "../feed/bb/brief";

/** HTF suggest windows. 15m stays EVENT /confirm. */
export const ZONE_INTERVALS = ["240", "60"] as const;
export type ZoneInterval = (typeof ZONE_INTERVALS)[number];

export const ZONE_KLINE_LIMITS = {
  "240": 80,
  "60": 120,
} as const;

export const ZONE_DETECT = {
  atrPeriod: 14,
  impulseMinAtr: 1,
  departureMinAtr: 0.3,
  baseMaxBars: 6,
  baseMaxAtr: 1.5,
  entryFromProximal: 0.3,
  slBufferAtr: 0.25,
  minRr: 2,
  deepPenetrationPct: 50,
  expiryBars: 48,
  maxZonesPerSymbol: 2,
} as const;

export type DetectBar = {
  startTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  confirm: boolean;
};

export type DetectOpts = {
  symbol: string;
  tf: string;
  intervalMs: number;
  now?: number;
  maxZones?: number;
};

function roundPrice(n: number): number {
  return Number(n.toFixed(8));
}

function roundRatio(n: number): number {
  return Number(n.toFixed(4));
}

export function intervalMsForTf(tf: string): number {
  if (tf === "240") return 4 * 60 * 60 * 1000;
  if (tf === "60") return 60 * 60 * 1000;
  if (tf === "15") return 15 * 60 * 1000;
  if (tf === "5") return 5 * 60 * 1000;
  throw new Error(`unsupported zone tf: ${tf}`);
}

export function tfSlug(tf: string): string {
  if (tf === "240") return "4h";
  if (tf === "60") return "1h";
  if (tf === "15") return "15m";
  if (tf === "5") return "5m";
  if (tf === "D") return "d";
  return tf.toLowerCase();
}

export function symbolSlug(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  const stripped = upper.endsWith("USDT") ? upper.slice(0, -4) : upper;
  return stripped.toLowerCase();
}

export function parseZoneInterval(raw: string | undefined | null): ZoneInterval | null {
  if (raw == null || raw.trim() === "") return "240";
  const token = raw.trim();
  if (token === "240" || token === "60") return token;
  return null;
}

function num(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function barsFromKlines(rows: BriefKline[]): DetectBar[] {
  const out: DetectBar[] = [];
  for (const row of rows) {
    const startTs = row.start_ts;
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    if (startTs == null || open == null || high == null || low == null || close == null) continue;
    if (!(high >= low) || !(high >= Math.max(open, close)) || !(low <= Math.min(open, close))) continue;
    out.push({
      startTs,
      open,
      high,
      low,
      close,
      confirm: row.confirm !== false,
    });
  }
  out.sort((a, b) => a.startTs - b.startTs);
  return out;
}

function trueRange(bar: DetectBar, prevClose: number): number {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** SMA ATR(14) ending at `endIndex` (inclusive). Null until enough history. */
export function atrSma(bars: DetectBar[], endIndex: number, period = ZONE_DETECT.atrPeriod): number | null {
  if (endIndex < period) return null;
  const start = endIndex - period + 1;
  if (start < 1) return null;
  let sum = 0;
  for (let i = start; i <= endIndex; i++) {
    sum += trueRange(bars[i]!, bars[i - 1]!.close);
  }
  const atr = sum / period;
  return atr > 0 ? atr : null;
}

function barBody(bar: DetectBar): number {
  return Math.abs(bar.close - bar.open);
}

function freshnessFromPenetration(pct: number): ZoneFreshness {
  if (pct <= 0) return "virgin";
  if (pct < ZONE_DETECT.deepPenetrationPct) return "touched";
  return "deep";
}

function penetrationAfter(
  side: ZoneSide,
  proximal: number,
  distal: number,
  later: DetectBar[],
): number {
  const height = Math.abs(distal - proximal);
  if (!(height > 0) || later.length === 0) return 0;
  let best = 0;
  for (const bar of later) {
    let into = 0;
    switch (side) {
      case "supply":
        if (bar.high > proximal) into = Math.min(bar.high, distal) - proximal;
        break;
      case "demand":
        if (bar.low < proximal) into = proximal - Math.max(bar.low, distal);
        break;
      default: {
        const _exhaustive: never = side;
        return _exhaustive;
      }
    }
    const pct = (into / height) * 100;
    if (pct > best) best = pct;
  }
  return roundRatio(Math.max(0, best));
}

function collectBase(bars: DetectBar[], impulseIndex: number, atr: number): DetectBar[] | null {
  const origin = impulseIndex - 1;
  if (origin < 0) return null;
  const picked: DetectBar[] = [];
  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (let j = origin; j >= 0 && picked.length < ZONE_DETECT.baseMaxBars; j--) {
    const bar = bars[j]!;
    if (!bar.confirm) break;
    const nextHigh = Math.max(rangeHigh, bar.high);
    const nextLow = Math.min(rangeLow, bar.low);
    if (picked.length > 0 && (bar.high < rangeLow || bar.low > rangeHigh)) break;
    if (nextHigh - nextLow > ZONE_DETECT.baseMaxAtr * atr) {
      if (picked.length > 0) break;
      return null;
    }
    if (picked.length > 0 && barBody(bar) >= ZONE_DETECT.impulseMinAtr * atr) break;
    picked.unshift(bar);
    rangeHigh = nextHigh;
    rangeLow = nextLow;
  }
  return picked.length > 0 ? picked : null;
}

function yyyymmddUtc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10).replace(/-/g, "");
}

function zoneIdFor(symbol: string, tf: string, side: ZoneSide, baseStartTs: number, seq: number): string {
  const sideSlug = side === "supply" ? "s" : "d";
  const n = String(seq).padStart(2, "0");
  return `${symbolSlug(symbol)}-${tfSlug(tf)}-${sideSlug}-${yyyymmddUtc(baseStartTs)}-${n}`;
}

function buildCard(opts: {
  symbol: string;
  tf: string;
  intervalMs: number;
  side: ZoneSide;
  base: DetectBar[];
  impulse: DetectBar;
  later: DetectBar[];
  atr: number;
  seq: number;
}): ZoneCard | null {
  const zoneLow = Math.min(...opts.base.map((bar) => bar.low));
  const zoneHigh = Math.max(...opts.base.map((bar) => bar.high));
  const height = zoneHigh - zoneLow;
  if (!(height > 0)) return null;
  const distal = opts.side === "supply" ? zoneHigh : zoneLow;
  const proximal = opts.side === "supply" ? zoneLow : zoneHigh;
  switch (opts.side) {
    case "supply":
      if (!(opts.impulse.close < zoneLow)) return null;
      break;
    case "demand":
      if (!(opts.impulse.close > zoneHigh)) return null;
      break;
    default: {
      const _exhaustive: never = opts.side;
      return _exhaustive;
    }
  }
  const impulseBody = barBody(opts.impulse);
  const departure = opts.side === "supply"
    ? zoneLow - opts.impulse.close
    : opts.impulse.close - zoneHigh;
  const departureAtr = departure / opts.atr;
  if (departureAtr < ZONE_DETECT.departureMinAtr) return null;
  const penetrationPct = penetrationAfter(opts.side, proximal, distal, opts.later);
  const freshness = freshnessFromPenetration(penetrationPct);
  const cancelCodes: CancelCode[] = [];
  if (freshness === "deep") return null;
  const entry = opts.side === "supply"
    ? proximal + ZONE_DETECT.entryFromProximal * height
    : proximal - ZONE_DETECT.entryFromProximal * height;
  const buf = Math.max(opts.atr * ZONE_DETECT.slBufferAtr, height * 0.1);
  const sl = opts.side === "supply" ? distal + buf : distal - buf;
  const risk = Math.abs(sl - entry);
  if (!(risk > 0)) return null;
  const tpRr2 = opts.side === "supply" ? entry - ZONE_DETECT.minRr * risk : entry + ZONE_DETECT.minRr * risk;
  const measured = opts.side === "supply" ? proximal - impulseBody : proximal + impulseBody;
  const measuredReward = Math.abs(entry - measured);
  const measuredRr = measuredReward / risk;
  const useMeasured = measuredRr >= ZONE_DETECT.minRr
    && (opts.side === "supply" ? measured < entry : measured > entry);
  const tp = useMeasured ? measured : tpRr2;
  const rr = Math.abs(tp - entry) / risk;
  if (rr < ZONE_DETECT.minRr) return null;
  const baseStartTs = opts.base[0]!.startTs;
  const baseEndTs = opts.base[opts.base.length - 1]!.startTs + opts.intervalMs;
  const raw: ZoneCard = {
    zoneId: zoneIdFor(opts.symbol, opts.tf, opts.side, baseStartTs, opts.seq),
    symbol: opts.symbol.trim().toUpperCase(),
    tf: opts.tf,
    side: opts.side,
    baseStartTs,
    baseEndTs,
    zoneLow: roundPrice(zoneLow),
    zoneHigh: roundPrice(zoneHigh),
    distal: roundPrice(distal),
    proximal: roundPrice(proximal),
    impulseBody: roundPrice(impulseBody),
    atr14: roundPrice(opts.atr),
    impulseAtr: roundRatio(impulseBody / opts.atr),
    departureAtr: roundRatio(departureAtr),
    freshness,
    penetrationPct,
    entry: roundPrice(entry),
    sl: roundPrice(sl),
    tp: roundPrice(tp),
    rr: roundRatio(rr),
    hardInvalid: roundPrice(sl),
    softInvalid: roundPrice(distal),
    expiryBars: ZONE_DETECT.expiryBars,
    cancelCodes,
  };
  try {
    return parseZoneCard(raw);
  } catch {
    return null;
  }
}

/**
 * Suggest zone-cards from local HTF klines. Never arms, never writes paper.
 * Deep / RR&lt;2 candidates are dropped, not auto-cancelled.
 */
export function detectZoneCards(bars: DetectBar[], opts: DetectOpts): ZoneCard[] {
  const symbol = opts.symbol.trim().toUpperCase();
  const tf = opts.tf;
  const intervalMs = opts.intervalMs;
  const cap = opts.maxZones ?? ZONE_DETECT.maxZonesPerSymbol;
  if (bars.length < ZONE_DETECT.atrPeriod + 2) return [];
  const found: ZoneCard[] = [];
  const seqByDay = new Map<string, number>();
  for (let i = ZONE_DETECT.atrPeriod + 1; i < bars.length; i++) {
    const impulse = bars[i]!;
    if (!impulse.confirm) continue;
    const atr = atrSma(bars, i - 1);
    if (atr == null) continue;
    const body = barBody(impulse);
    if (body / atr < ZONE_DETECT.impulseMinAtr) continue;
    const side: ZoneSide = impulse.close < impulse.open ? "supply" : "demand";
    const base = collectBase(bars, i, atr);
    if (!base) continue;
    const dayKey = `${side}:${yyyymmddUtc(base[0]!.startTs)}`;
    const seq = (seqByDay.get(dayKey) ?? 0) + 1;
    const card = buildCard({
      symbol,
      tf,
      intervalMs,
      side,
      base,
      impulse,
      later: bars.slice(i + 1),
      atr,
      seq,
    });
    if (!card) continue;
    seqByDay.set(dayKey, seq);
    found.push(card);
  }
  found.sort((a, b) => b.baseStartTs - a.baseStartTs);
  const picked: ZoneCard[] = [];
  for (const card of found) {
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

export function detectZoneCardsFromKlines(rows: BriefKline[], opts: DetectOpts): ZoneCard[] {
  return detectZoneCards(barsFromKlines(rows), opts);
}
