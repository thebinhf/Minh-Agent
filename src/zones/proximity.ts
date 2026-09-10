import type { ZoneCard } from "./card";
import { ZONE_DETECT } from "./detect";

/** last vs an accepted card. Suggest-only `/zones` never uses this. */
export type ProximityDecision = "wait" | "arm" | "deep" | "invalid";

export function penetrationFromLast(card: ZoneCard, last: number): number {
  const span = Math.abs(card.proximal - card.distal);
  if (!(span > 0) || !Number.isFinite(last)) return 0;
  switch (card.side) {
    case "demand":
      if (last >= card.proximal) return 0;
      return ((card.proximal - last) / span) * 100;
    case "supply":
      if (last <= card.proximal) return 0;
      return ((last - card.proximal) / span) * 100;
    default: {
      const _exhaustive: never = card.side;
      return _exhaustive;
    }
  }
}

/**
 * Arm only in the first 30% of the zone (proximal → entry), post-only rest.
 * Through entry → wait (no chase). ≥50% → deep. Through SL → invalid.
 */
export function proximityDecision(card: ZoneCard, last: number): ProximityDecision {
  if (!Number.isFinite(last)) return "wait";
  switch (card.side) {
    case "demand":
      if (last <= card.sl) return "invalid";
      if (last > card.proximal) return "wait";
      if (last < card.distal) return "wait";
      if (penetrationFromLast(card, last) >= ZONE_DETECT.deepPenetrationPct) return "deep";
      if (last <= card.entry) return "wait";
      return "arm";
    case "supply":
      if (last >= card.sl) return "invalid";
      if (last < card.proximal) return "wait";
      if (last > card.distal) return "wait";
      if (penetrationFromLast(card, last) >= ZONE_DETECT.deepPenetrationPct) return "deep";
      if (last >= card.entry) return "wait";
      return "arm";
    default: {
      const _exhaustive: never = card.side;
      return _exhaustive;
    }
  }
}

export function armTimeframes(tf: string): string[] {
  if (tf === "240") return ["240", "60", "15"];
  if (tf === "60") return ["60", "15"];
  return [tf, "15"];
}

export function armSide(side: ZoneCard["side"]): "long" | "short" {
  switch (side) {
    case "demand":
      return "long";
    case "supply":
      return "short";
    default: {
      const _exhaustive: never = side;
      return _exhaustive;
    }
  }
}
