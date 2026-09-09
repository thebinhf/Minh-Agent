import {
  GATE_FEED_UNHEALTHY,
  GATE_KLINE_LAG,
  tradingGates,
  type TradingGates,
} from "../feed/bb/health";
import { PaperReject } from "./errors";
import type { PaperFeedHealth } from "./types";

export { GATE_FEED_UNHEALTHY, GATE_KLINE_LAG, tradingGates };
export type { TradingGates };

export function klineLagOkFromHealth(health: PaperFeedHealth): boolean {
  return health.klineLagOk !== false;
}

export function gatesFromFeedHealth(health: PaperFeedHealth): TradingGates {
  return tradingGates({
    feedOk: health.ok,
    klineLagOk: klineLagOkFromHealth(health),
  });
}

/** Reject new paper open / limit / arm. Does not close existing positions. */
export function rejectIfEntryBlocked(health: PaperFeedHealth): void {
  const gates = gatesFromFeedHealth(health);
  if (gates.tradingAllowed) return;
  const error = gates.reasons.includes(GATE_FEED_UNHEALTHY)
    ? GATE_FEED_UNHEALTHY
    : GATE_KLINE_LAG;
  throw new PaperReject(error, "gates", {
    tradingAllowed: false,
    reasons: gates.reasons,
  });
}

export function parseZoneId(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const id = String(raw).trim();
  return id.length ? id : null;
}
