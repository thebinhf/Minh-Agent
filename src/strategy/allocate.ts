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

export type ZoneStanding = {
  /** How many of this symbol's slots are already taken. */
  count: number;
  /** By whom — a card in this list is an incumbent, not a challenger. */
  zoneIds: ReadonlyArray<string>;
};

export type SlotPlanInput<T extends { card: ZoneCard }> = {
  /** Cards in arrival order. The output is index-aligned with this array. */
  items: T[];
  /** What already stands on the ledger for that symbol before this pass. */
  standingFor: (symbol: string) => ZoneStanding;
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
 * Two rules decide everything here:
 *
 * - Only a card that clears every other gate competes for a slot — a chop-denied
 *   card never holds one, so it cannot block a card that would have passed.
 * - A card already on the ledger **is** one of the standing cards, so it takes
 *   the seat it already occupies instead of challenging for one. Without that, a
 *   symbol at 2/2 re-prices both of its own incumbents as `ledger_cap`: the desk
 *   hides it because `acceptZone` hits `duplicate_zone` before the cap, so the
 *   outcome is a no-op, but the live-shadow publishes the raw verdict — the
 *   terminal showed `shadow=deny ledger_cap` on cards the desk was holding, and
 *   the decision corpus recorded the same mislabel.
 *
 * A genuine loser against the cap is still attributed `ledger_cap` at the same
 * point in the gate chain, so `skipReasons` and the corpus stay comparable.
 */
export function planMapAccept<T extends { card: ZoneCard }>(input: SlotPlanInput<T>): PolicyDecision[] {
  const items = input.items;
  const slots = new Array<number>(items.length);

  // Pass 1: who is actually competing? `0` = no slot consumed yet, so the cap
  // gate cannot fire here; the verdicts that follow it still do.
  const competes = new Set<number>();
  for (let i = 0; i < items.length; i += 1) {
    if (input.decide(items[i]!, 0).allow) competes.add(i);
  }

  const cached = new Map<string, ZoneStanding>();
  const standingOf = (symbol: string): ZoneStanding => {
    let row = cached.get(symbol);
    if (!row) {
      row = input.standingFor(symbol);
      cached.set(symbol, row);
    }
    return row;
  };

  // Pass 2: walk the cards in the strategy's order. Incumbents sit in seats
  // 0..n-1 of their symbol; challengers start above the standing count.
  const ordered = items.map((_, i) => i);
  if (input.compare) {
    ordered.sort((a, b) => input.compare!(items[a]!.card, items[b]!.card) || a - b);
  }
  const incumbentSeat = new Map<string, number>();
  const challenger = new Map<string, number>();
  for (const i of ordered) {
    const card = items[i]!.card;
    const standing = standingOf(card.symbol);
    if (standing.zoneIds.includes(card.zoneId)) {
      const seat = incumbentSeat.get(card.symbol) ?? 0;
      incumbentSeat.set(card.symbol, seat + 1);
      slots[i] = seat;
      continue;
    }
    const ahead = challenger.get(card.symbol) ?? 0;
    slots[i] = standing.count + ahead;
    if (competes.has(i)) challenger.set(card.symbol, ahead + 1);
  }

  // Pass 3: the real verdict, with the card's slot position.
  return items.map((item, i) => input.decide(item, slots[i]!));
}
