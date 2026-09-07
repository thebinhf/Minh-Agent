import { Dec } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperSide } from "./types";

export type AlertOp = "above" | "below";
export type OrderTif = "gtc";

export const EVENT_KINDS = [
  "alert.fired",
  "order.filled",
  "order.rejected",
  "order.cancelled",
  "position.closed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function parseAlertOp(raw: string): AlertOp {
  const op = raw.trim().toLowerCase();
  if (op === "above" || op === "below") return op;
  throw new PaperReject("invalid_alert_op", "alert", { op: raw });
}

/** Fire when last prints through the level. Equal counts as a hit. */
export function alertHit(op: AlertOp, last: Dec, price: Dec): boolean {
  return op === "above" ? last.gte(price) : last.lte(price);
}

/** Resting limit: long fills when last trades down to/through the bid; short the reverse. */
export function limitFillHit(side: PaperSide, last: Dec, limit: Dec): boolean {
  return side === "long" ? last.lte(limit) : last.gte(limit);
}

/**
 * Post-only rests on the book: long limit must be strictly below last,
 * short strictly above. At-or-through last would take liquidity.
 */
export function limitPostOnlyOk(side: PaperSide, last: Dec, limit: Dec): boolean {
  return side === "long" ? limit.lt(last) : limit.gt(last);
}

export function parsePostOnly(raw: boolean | undefined): boolean {
  return raw !== false;
}
