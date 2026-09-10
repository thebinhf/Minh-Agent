import { PaperReject } from "./errors";
import { paperArm } from "./ops";
import type { PaperEngine } from "./engine";
import type { PaperQuantTape } from "./types";
import { quantVeto } from "../agent/quant";
import {
  armSide,
  armTimeframes,
  proximityDecision,
} from "../zones/proximity";

export function proximityArmEnabled(): boolean {
  return process.env.PAPER_PROXIMITY_ARM !== "0";
}

export type ProximityArmResult = {
  armed: string[];
  rejected: string[];
};

/**
 * Rest limit+alert for accepted ledger cards when last is in the proximal band.
 * Does not read GET /zones. Kill switch: PAPER_PROXIMITY_ARM=0.
 */
export async function runProximityArm(
  engine: PaperEngine,
  lastBySymbol: Map<string, number>,
  now = Date.now(),
  quantBySymbol?: Map<string, PaperQuantTape>,
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
    if (decision === "wait") continue;
    if (decision === "deep") {
      engine.rejectZone(card.zoneId, "deep_mitigate", now);
      rejected.push(card.zoneId);
      continue;
    }
    if (decision === "invalid") {
      engine.rejectZone(card.zoneId, "htf_break", now);
      rejected.push(card.zoneId);
      continue;
    }
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
