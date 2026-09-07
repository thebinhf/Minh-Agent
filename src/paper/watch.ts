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
  "order.invalidated",
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

/** OCO is on unless the operator explicitly disables it. */
export function parseOco(raw: boolean | undefined): boolean {
  return raw !== false;
}

/** Invalidation must sit on the stop side of the limit (same geometry as SL). */
export function assertInvalidateSide(side: PaperSide, limit: Dec, invalidate: Dec): void {
  if (side === "long" && !invalidate.lt(limit)) {
    throw new PaperReject("invalidate_side", "oco", {
      side,
      limit: limit.toText(),
      invalidate: invalidate.toText(),
    });
  }
  if (side === "short" && !invalidate.gt(limit)) {
    throw new PaperReject("invalidate_side", "oco", {
      side,
      limit: limit.toText(),
      invalidate: invalidate.toText(),
    });
  }
}

/** Pending long dies when last <= invalidate; short when last >= invalidate. */
export function limitInvalidated(side: PaperSide, last: Dec, invalidate: Dec): boolean {
  return side === "long" ? last.lte(invalidate) : last.gte(invalidate);
}
