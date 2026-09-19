import {
  compareZoneCards,
  familyRealizedRrOf,
  familyScoreOf,
  paperZoneScoreEnabled,
  type FamilyStats,
} from "../paper/score";
import type { PolicyDecision } from "../agent/policy";
import type { ZoneCard } from "../zones/card";

/**
 * Who gets a scarce ledger slot.
 *
 * MAP asks `decideMapAccept` one card at a time, but the per-symbol cap is not a
 * per-card property: it is a race between the cards of a symbol for
 * `LEDGER_CAP_PER_SYMBOL` slots, and a race needs an order. Before this module
 * each caller had its own — the paper desk used `/zones` payload order (newest
 * card first), the live-shadow re-ranked by RR, and the replay walk ranked by
 * family score only where a score existed. Three orders means the walk does not
 * measure the desk and the terminal's shadow verdict is not the desk's verdict.
 *
 * One function now, four callers. The order is a strategy choice, not a
 * consequence of how the feed happened to sort a response.
 */

export type AllocateMode = "feed" | "rank";

/**
 * `feed` = the order the cards arrived in, which is what the paper desk has
 * always done. `rank` = the same comparator ARM already uses (family score,
 * then realized RR under `PAPER_ZONE_SCORE_RR`, then card RR, then zoneId).
 *
 * Default is `feed` on purpose: it keeps the shipped loop's verdicts identical
 * and makes `rank` a one-flag walk rather than an untested change to the desk.
 */
export function mapAllocateMode(env: NodeJS.ProcessEnv = process.env): AllocateMode {
  return env.PAPER_MAP_ALLOCATE?.trim().toLowerCase() === "rank" ? "rank" : "feed";
}

/**
 * The one definition of "the better card". Scores only count when
 * `PAPER_ZONE_SCORE` is on; below that it degrades to RR then zoneId, which is
 * what ARM's cap ranking does.
 */
export function familyRankCompare(familyByKey?: Map<string, FamilyStats> | null): (a: ZoneCard, b: ZoneCard) => number {
  const stats = familyByKey ?? null;
  const scoreOf = paperZoneScoreEnabled() && stats ? familyScoreOf(stats) : () => null;
  const realizedRrOf = stats ? familyRealizedRrOf(stats) : undefined;
  return (a, b) => compareZoneCards(a, b, scoreOf, realizedRrOf);
}

export type SlotPlanInput<T extends { card: ZoneCard }> = {
  /** Cards in arrival order. The output is index-aligned with this array. */
  items: T[];
  /** How many of this symbol already stand on the ledger before this pass. */
  standingFor: (card: ZoneCard) => number;
  /**
   * The existing per-card gate chain, with the slot position supplied. Must be
   * pure: every card is evaluated twice, once to find out whether it competes
   * for a slot at all and once with its slot position.
   */
  decide: (item: T, acceptedForSymbol: number) => PolicyDecision;
  /** Undefined = arrival order. */
  compare?: (a: ZoneCard, b: ZoneCard) => number;
};

/**
 * Hand out per-symbol slots and return one decision per input card.
 *
 * Only a card that clears every other gate competes for a slot — a chop-denied
 * card never holds one, so it cannot block a card that would have passed. A
 * loser is attributed `ledger_cap` at the same point in the gate chain it is
 * attributed today, so `skipReasons` and the decision corpus stay comparable
 * across the change.
 */
export function planMapAccept<T extends { card: ZoneCard }>(input: SlotPlanInput<T>): PolicyDecision[] {
  const items = input.items;
  const slots = new Array<number>(items.length);

  // Pass 1: who is actually competing? `0` = no slot consumed yet, so the cap
  // gate cannot fire here; the verdicts that follow it still do.
  const competes: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (input.decide(items[i]!, 0).allow) competes.push(i);
  }
  const competing = new Set(competes);

  // Pass 2: walk the cards in the strategy's order, counting only competitors
  // against each symbol's standing count.
  const ordered: number[] = [];
  for (let i = 0; i < items.length; i += 1) ordered.push(i);
  if (input.compare) {
    ordered.sort((a, b) => input.compare!(items[a]!.card, items[b]!.card) || a - b);
  }
  const next = new Map<string, number>();
  for (const i of ordered) {
    const card = items[i]!.card;
    const base = next.get(card.symbol) ?? input.standingFor(card);
    slots[i] = base;
    if (competing.has(i)) next.set(card.symbol, base + 1);
  }

  // Pass 3: the real verdict, with the card's slot position.
  return items.map((item, i) => input.decide(item, slots[i]!));
}
