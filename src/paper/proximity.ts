import { PaperReject } from "./errors";
import { paperArm } from "./ops";
import type { PaperEngine } from "./engine";
import type { PaperKlineSnap, PaperQuantTape } from "./types";
import { quantVeto } from "../agent/quant";
import type { CancelCode, ZoneCard, ZoneSide } from "../zones/card";
import {
  armSide,
  armTimeframes,
  proximityDecision,
} from "../zones/proximity";
import { familyStatsFromEngine } from "./map-accept";
import { compareZoneCards, familyFromCard, familyKey, paperZoneScoreEnabled, type FamilyStats } from "./score";
import { taArmWait, type TaArmTape } from "../agent/ta-gate";

export function proximityArmEnabled(): boolean {
  return process.env.PAPER_PROXIMITY_ARM !== "0";
}

export function confirm15Enabled(): boolean {
  return process.env.PAPER_CONFIRM_15 !== "0";
}

/**
 * Max symbols with a pending OCO or open position. Default 2.
 * PAPER_ARM_MAX=0 → unlimited (still one pending/open per symbol).
 */
export function paperArmMaxSymbols(): number | null {
  const raw = process.env.PAPER_ARM_MAX;
  if (raw === "0") return null;
  if (raw == null || raw.trim() === "") return 2;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) return 2;
  return n;
}

export type ProximityArmResult = {
  armed: string[];
  rejected: string[];
};

/**
 * Latest confirmed 15m must close with the zone (demand bull, supply bear)
 * and still sit in proximal → entry. Forming / doji / opposite / missing → wait.
 * Does not reject the card. PAPER_CONFIRM_15=0 skips.
 */
export function confirm15Bar(card: ZoneCard, bar: PaperKlineSnap | null | undefined): "ok" | "wait" {
  if (!confirm15Enabled()) return "ok";
  if (!bar || bar.confirm !== true) return "wait";
  const open = Number(bar.open);
  const close = Number(bar.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || open === close) return "wait";
  switch (card.side) {
    case "demand":
      if (!(close > open)) return "wait";
      if (close > card.proximal || close <= card.entry) return "wait";
      return "ok";
    case "supply":
      if (!(close < open)) return "wait";
      if (close < card.proximal || close >= card.entry) return "wait";
      return "ok";
    default: {
      const _exhaustive: never = card.side;
      return _exhaustive;
    }
  }
}

/** Deep / HTF on a resting zoned OCO. `wait` through entry still fills. */
export function pendingProximityReject(card: ZoneCard, last: number): Extract<CancelCode, "deep_mitigate" | "htf_break"> | null {
  const decision = proximityDecision(card, last);
  switch (decision) {
    case "deep":
      return "deep_mitigate";
    case "invalid":
      return "htf_break";
    case "wait":
    case "arm":
      return null;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/**
 * Cascade / crowded hold a pending fill the same way ARM waits.
 * OI add and CVD stay accept-only — they do not skip a resting fill.
 */
export function pendingQuantSkipFill(side: ZoneSide, tape: PaperQuantTape | null | undefined): boolean {
  return !quantVeto(side, tape, "arm").allow;
}

function occupiedSymbols(engine: PaperEngine): Set<string> {
  const occupied = new Set<string>();
  for (const row of engine.orders("pending")) occupied.add(row.symbol);
  for (const row of engine.positions("open")) occupied.add(row.symbol);
  return occupied;
}

function zonedBusy(engine: PaperEngine): Set<string> {
  const busy = new Set<string>();
  for (const row of engine.orders("pending")) {
    if (row.zoneId) busy.add(row.zoneId);
  }
  for (const row of engine.positions("open")) {
    if (row.zoneId) busy.add(row.zoneId);
  }
  return busy;
}

/**
 * Rest limit+alert for accepted ledger cards when last is in the proximal band
 * and the last confirmed 15m agrees. Does not read GET /zones.
 * Kill: PAPER_PROXIMITY_ARM=0. 15m: PAPER_CONFIRM_15=0.
 * Under PAPER_ARM_MAX, rank ready cards by family score then rr then zoneId.
 * Occupied slots stay; only new arms compete for free slots.
 */
export async function runProximityArm(
  engine: PaperEngine,
  lastBySymbol: Map<string, number>,
  now = Date.now(),
  quantBySymbol?: Map<string, PaperQuantTape>,
  kline15BySymbol?: Map<string, PaperKlineSnap>,
  familyByKey?: Map<string, FamilyStats>,
  taBySymbol?: Map<string, TaArmTape>,
): Promise<ProximityArmResult> {
  const armed: string[] = [];
  const rejected: string[] = [];
  if (!proximityArmEnabled()) return { armed, rejected };

  const busy = zonedBusy(engine);

  async function armCard(card: ZoneCard): Promise<"armed" | "rejected" | "wait"> {
    try {
      await paperArm(engine, {
        symbol: card.symbol,
        side: armSide(card.side),
        limitPrice: String(card.entry),
        stopLoss: String(card.sl),
        takeProfit: String(card.tp),
        timeframes: armTimeframes(card.tf),
        zoneId: card.zoneId,
        postOnly: true,
        oco: true,
      }, now);
      armed.push(card.zoneId);
      busy.add(card.zoneId);
      return "armed";
    } catch (error) {
      if (!(error instanceof PaperReject)) throw error;
      if (error.error === "already_invalidated") {
        engine.rejectZone(card.zoneId, "htf_break", now);
        rejected.push(card.zoneId);
        return "rejected";
      }
      if (error.error === "rr_below_min") {
        engine.rejectZone(card.zoneId, "rr_fail", now);
        rejected.push(card.zoneId);
        return "rejected";
      }
      return "wait";
    }
  }

  type Gate = "candidate" | "skip";
  function gateCard(card: ZoneCard): Gate {
    if (busy.has(card.zoneId)) return "skip";
    if (engine.orders("pending").some((order) => order.symbol === card.symbol)) return "skip";
    if (engine.positions("open").some((pos) => pos.symbol === card.symbol)) return "skip";
    const last = lastBySymbol.get(card.symbol);
    if (last == null) return "skip";
    const decision = proximityDecision(card, last);
    switch (decision) {
      case "wait":
        return "skip";
      case "deep":
        engine.rejectZone(card.zoneId, "deep_mitigate", now);
        rejected.push(card.zoneId);
        return "skip";
      case "invalid":
        engine.rejectZone(card.zoneId, "htf_break", now);
        rejected.push(card.zoneId);
        return "skip";
      case "arm":
        break;
      default: {
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
    if (confirm15Bar(card, kline15BySymbol?.get(card.symbol)) !== "ok") return "skip";
    const veto = quantVeto(card.side, quantBySymbol?.get(card.symbol), "arm");
    if (!veto.allow) return "skip";
    if (taArmWait(card.side, taBySymbol?.get(card.symbol))) return "skip";
    return "candidate";
  }

  const cap = paperArmMaxSymbols();
  if (cap == null) {
    for (const row of engine.zones("accepted", now)) {
      if (gateCard(row.card) !== "candidate") continue;
      await armCard(row.card);
    }
    return { armed, rejected };
  }

  const candidates: ZoneCard[] = [];
  for (const row of engine.zones("accepted", now)) {
    if (gateCard(row.card) === "candidate") candidates.push(row.card);
  }
  const occupied = occupiedSymbols(engine);
  let free = cap - occupied.size;
  if (candidates.length === 0 || free <= 0) return { armed, rejected };
  if (candidates.length === 1) {
    const card = candidates[0]!;
    if (!occupied.has(card.symbol)) await armCard(card);
    return { armed, rejected };
  }
  const stats = familyByKey ?? familyStatsFromEngine(engine, now);
  const scoreOf = (card: ZoneCard) => (
    paperZoneScoreEnabled()
      ? stats.get(familyKey(familyFromCard(card)))?.score ?? null
      : null
  );
  const ranked = [...candidates].sort((a, b) => compareZoneCards(a, b, scoreOf));
  for (const card of ranked) {
    if (free <= 0) break;
    if (occupied.has(card.symbol)) continue;
    const outcome = await armCard(card);
    if (outcome === "armed") {
      occupied.add(card.symbol);
      free -= 1;
    }
  }
  return { armed, rejected };
}
