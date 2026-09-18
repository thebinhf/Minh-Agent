/**
 * EVENT stop management. Opt-in (`PAPER_BE_R`). Not a signal. Does not arm.
 * Uses original risk (`risk_quote / qty_initial`) so a moved stop does not
 * shrink the R multiple used to trigger the next manage step.
 */
import { eventBeR, eventManageApplies } from "../agent/strategy";
import { Dec } from "./decimal";
import type { PaperSide } from "./types";
import type { ZoneSetup } from "../zones/card";

export function originalRiskPx(riskQuote: string, qtyInitial: string): Dec | null {
  try {
    const qty = Dec.from(qtyInitial);
    const risk = Dec.from(riskQuote);
    if (!qty.isPos() || !risk.isPos()) return null;
    return risk.div(qty);
  } catch {
    return null;
  }
}

export function favorableR(side: PaperSide, entry: Dec, last: Dec, riskPx: Dec): Dec {
  const excursion = side === "long" ? last.sub(entry) : entry.sub(last);
  return excursion.div(riskPx);
}

/** Long only tightens up; short only tightens down. Equal is not an improve. */
export function stopImproves(side: PaperSide, current: Dec, next: Dec): boolean {
  return side === "long" ? next.gt(current) : next.lt(current);
}

export type BeMove = {
  action: "be";
  stop: Dec;
  mfeR: Dec;
};

/**
 * When PAPER_BE_R is on and last has run ≥ N R in the trade's favor, the
 * next stop is entry. Caller must still venue-snap and refuse a stop that
 * last already prints through (would instant-SL).
 */
export function beStopFor(
  row: {
    side: string;
    entry_price: string;
    stop_loss: string;
    risk_quote: string;
    qty_initial: string;
    setup?: ZoneSetup | null;
  },
  last: Dec,
): BeMove | null {
  const floor = eventBeR();
  if (floor == null) return null;
  if (!eventManageApplies("be", row.setup ?? "sd")) return null;
  const riskPx = originalRiskPx(row.risk_quote, row.qty_initial);
  if (!riskPx) return null;
  let entry: Dec;
  let current: Dec;
  try {
    entry = Dec.from(row.entry_price);
    current = Dec.from(row.stop_loss);
  } catch {
    return null;
  }
  const side = row.side as PaperSide;
  if (side !== "long" && side !== "short") return null;
  if (!stopImproves(side, current, entry)) return null;
  const mfeR = favorableR(side, entry, last, riskPx);
  if (mfeR.lt(Dec.from(String(floor)))) return null;
  return { action: "be", stop: entry, mfeR };
}
