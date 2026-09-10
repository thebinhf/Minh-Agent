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

export function proximityArmEnabled(): boolean {
  return process.env.PAPER_PROXIMITY_ARM !== "0";
}

export function confirm15Enabled(): boolean {
  return process.env.PAPER_CONFIRM_15 !== "0";
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

/**
 * Rest limit+alert for accepted ledger cards when last is in the proximal band
 * and the last confirmed 15m agrees. Does not read GET /zones.
 * Kill: PAPER_PROXIMITY_ARM=0. 15m: PAPER_CONFIRM_15=0.
 */
export async function runProximityArm(
  engine: PaperEngine,
  lastBySymbol: Map<string, number>,
  now = Date.now(),
  quantBySymbol?: Map<string, PaperQuantTape>,
  kline15BySymbol?: Map<string, PaperKlineSnap>,
): Promise<ProximityArmResult> {
  const armed: string[] = [];
  const rejected: string[] = [];
  if (!proximityArmEnabled()) return { armed, rejected };

  const busy = new Set<string>();
  for (const row of engine.orders("pending")) {
    if (row.zoneId) busy.add(row.zoneId);
  }
  for (const row of engine.positions("open")) {
    if (row.zoneId) busy.add(row.zoneId);
  }

  for (const row of engine.zones("accepted", now)) {
    const card = row.card;
    if (busy.has(card.zoneId)) continue;
    if (engine.orders("pending").some((order) => order.symbol === card.symbol)) continue;
    if (engine.positions("open").some((pos) => pos.symbol === card.symbol)) continue;
    const last = lastBySymbol.get(card.symbol);
    if (last == null) continue;
    const decision = proximityDecision(card, last);
    switch (decision) {
      case "wait":
        continue;
      case "deep":
        engine.rejectZone(card.zoneId, "deep_mitigate", now);
        rejected.push(card.zoneId);
        continue;
      case "invalid":
        engine.rejectZone(card.zoneId, "htf_break", now);
        rejected.push(card.zoneId);
        continue;
      case "arm":
        break;
      default: {
        const _exhaustive: never = decision;
        return _exhaustive;
      }
    }
    if (confirm15Bar(card, kline15BySymbol?.get(card.symbol)) !== "ok") continue;
    const veto = quantVeto(card.side, quantBySymbol?.get(card.symbol), "arm");
    if (!veto.allow) continue;
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
    } catch (error) {
      if (!(error instanceof PaperReject)) throw error;
      if (error.error === "already_invalidated") {
        engine.rejectZone(card.zoneId, "htf_break", now);
        rejected.push(card.zoneId);
        continue;
      }
      if (
        error.error === "duplicate_symbol"
        || error.error === "kline_lag"
        || error.error === "feed_unhealthy"
        || error.error === "post_only"
        || error.error === "insufficient_margin"
      ) {
        continue;
      }
      throw error;
    }
  }
  return { armed, rejected };
}
