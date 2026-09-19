import { afterEach, describe, expect, test } from "bun:test";
import { familyRankCompare, mapAllocateMode, planMapAccept, type ZoneStanding } from "../../src/strategy/allocate";
import type { PolicyDecision } from "../../src/agent/policy";
import type { ZoneCard } from "../../src/zones/card";
import type { FamilyStats } from "../../src/paper/score";

const savedZoneScore = process.env.PAPER_ZONE_SCORE;
const savedZoneScoreRr = process.env.PAPER_ZONE_SCORE_RR;
const savedAllocate = process.env.PAPER_MAP_ALLOCATE;

afterEach(() => {
  if (savedZoneScore === undefined) delete process.env.PAPER_ZONE_SCORE;
  else process.env.PAPER_ZONE_SCORE = savedZoneScore;
  if (savedZoneScoreRr === undefined) delete process.env.PAPER_ZONE_SCORE_RR;
  else process.env.PAPER_ZONE_SCORE_RR = savedZoneScoreRr;
  if (savedAllocate === undefined) delete process.env.PAPER_MAP_ALLOCATE;
  else process.env.PAPER_MAP_ALLOCATE = savedAllocate;
});

const CAP = 2;

type Item = {
  card: ZoneCard;
  /** A gate ahead of the cap in decideMapAccept (e.g. `expired`). */
  pre?: PolicyDecision;
  /** A gate behind the cap (e.g. `bias_chop`). */
  post?: PolicyDecision;
};

function card(over: Partial<ZoneCard> & { zoneId: string }): ZoneCard {
  return {
    symbol: "BTCUSDT",
    tf: "240",
    side: "supply",
    setup: "sd",
    baseStartTs: 1,
    baseEndTs: 2,
    zoneLow: 100,
    zoneHigh: 110,
    distal: 110,
    proximal: 100,
    impulseBody: 10,
    atr14: 5,
    impulseAtr: 2,
    departureAtr: 1,
    freshness: "virgin",
    penetrationPct: 0,
    entry: 105,
    sl: 110,
    tp: 95,
    rr: 2,
    hardInvalid: 110,
    softInvalid: 105,
    expiryBars: 6,
    cancelCodes: [],
    ...over,
  } as ZoneCard;
}

function item(zoneId: string, over: Partial<Item> & { rr?: number; symbol?: string } = {}): Item {
  const { rr, symbol, ...rest } = over;
  return { card: card({ zoneId, symbol: symbol ?? "BTCUSDT", rr: rr ?? 2 }), ...rest };
}

/** Mirrors decideMapAccept: cap first, then the gates that follow it. */
function decide(item: Item, acceptedForSymbol: number): PolicyDecision {
  if (item.pre) return item.pre;
  if (acceptedForSymbol >= CAP) return { allow: false, reason: "ledger_cap" };
  return item.post ?? { allow: true, reason: "ok" };
}

const CHOP: PolicyDecision = { allow: false, reason: "bias_chop" };
const EXPIRED: PolicyDecision = { allow: false, reason: "expired" };

/** A symbol's standing rows as the allocator sees them. */
function stood(count: number, zoneIds: string[] = []): ZoneStanding {
  return { count, zoneIds };
}

/** What the desk did before this module: one pass, slots consumed in payload order. */
function sequential(items: Item[], standing: (symbol: string) => ZoneStanding): PolicyDecision[] {
  const accepted: ZoneCard[] = [];
  return items.map((item) => {
    const slots = standing(item.card.symbol).count + accepted.filter((a) => a.symbol === item.card.symbol).length;
    const verdict = decide(item, slots);
    if (verdict.allow) accepted.push(item.card);
    return verdict;
  });
}

function verdicts(
  items: Item[],
  standing: (symbol: string) => ZoneStanding = () => stood(0),
  compare?: (a: ZoneCard, b: ZoneCard) => number,
) {
  return planMapAccept({ items, standingFor: standing, decide, compare });
}

describe("MAP slot allocation", () => {
  test("arrival order reproduces the sequential loop verdict for verdict", () => {
    const items = [
      item("btc-1"),
      item("btc-2"),
      item("btc-3"),
      item("eth-1", { symbol: "ETHUSDT" }),
      item("btc-4"),
      item("eth-2", { symbol: "ETHUSDT", post: CHOP }),
      item("eth-3", { symbol: "ETHUSDT" }),
      item("sol-1", { symbol: "SOLUSDT", pre: EXPIRED }),
      item("sol-2", { symbol: "SOLUSDT" }),
      item("sol-3", { symbol: "SOLUSDT" }),
      item("sol-4", { symbol: "SOLUSDT" }),
    ];
    const standing = (symbol: string) => stood(symbol === "SOLUSDT" ? 1 : 0);
    const planned = verdicts(items, standing);
    const walk = sequential(items, standing);
    expect(planned.map((row) => `${row.allow}:${row.reason}`)).toEqual(walk.map((row) => `${row.allow}:${row.reason}`));
    // And the expectation is stated out loud, not just equal to itself. SOL stands
    // at 1, so its cap leaves one slot: the first live SOL card takes it.
    expect(planned.map((row) => row.reason)).toEqual([
      "ok", "ok", "ledger_cap", "ok", "ledger_cap", "bias_chop", "ok", "expired", "ok", "ledger_cap", "ledger_cap",
    ]);
  });

  test("a gate behind the cap cannot hold a slot from a card that would pass", () => {
    const items = [item("btc-a", { post: CHOP }), item("btc-b"), item("btc-c"), item("btc-d")];
    const planned = verdicts(items);
    expect(planned.map((row) => row.reason)).toEqual(["bias_chop", "ok", "ok", "ledger_cap"]);
  });

  test("rank order hands the scarce slot to the better card and the loser reads ledger_cap", () => {
    const byRr = (a: ZoneCard, b: ZoneCard) => b.rr - a.rr;
    const items = [
      item("btc-weak", { rr: 1.5 }),
      item("btc-strong", { rr: 3 }),
      item("btc-mid", { rr: 2 }),
    ];
    const planned = verdicts(items, () => stood(0), byRr);
    expect(planned.map((row) => `${row.allow}`)).toEqual(["false", "true", "true"]);
    expect(planned[0]!.reason).toBe("ledger_cap");
    // Output stays index-aligned with the input, so callers emit once per card.
    expect(items.map((row) => row.card.zoneId)).toEqual(["btc-weak", "btc-strong", "btc-mid"]);
  });

  test("an equal rank keeps arrival order, so ranking never becomes a coin flip", () => {
    const items = [item("btc-a", { rr: 2 }), item("btc-b", { rr: 2 }), item("btc-c", { rr: 2 })];
    const planned = verdicts(items, () => stood(0), () => 0);
    expect(planned.map((row) => row.reason)).toEqual(["ok", "ok", "ledger_cap"]);
  });

  test("standing cards reduce what the pass may add", () => {
    const items = [item("btc-a"), item("btc-b")];
    expect(verdicts(items, () => stood(1)).map((row) => row.reason)).toEqual(["ok", "ledger_cap"]);
    expect(verdicts(items, () => stood(2)).map((row) => row.reason)).toEqual(["ledger_cap", "ledger_cap"]);
  });

  test("a card already on the ledger is not locked out of the slot it holds", () => {
    // The field bug this guards: BTC stood at 2/2, and the next 4H close
    // re-priced both of its own incumbents as `ledger_cap` — the terminal showed
    // a deny on cards the desk was holding.
    const items = [item("btc-old-1"), item("btc-old-2"), item("btc-new")];
    const standing = () => stood(2, ["btc-old-1", "btc-old-2"]);
    expect(verdicts(items, standing).map((row) => row.reason)).toEqual(["ok", "ok", "ledger_cap"]);
  });

  test("one incumbent leaves exactly one slot for challengers", () => {
    const items = [item("btc-held"), item("btc-challenger"), item("btc-late")];
    const standing = () => stood(1, ["btc-held"]);
    expect(verdicts(items, standing).map((row) => row.reason)).toEqual(["ok", "ok", "ledger_cap"]);
  });

  test("an incumbent that fails another gate reports that gate, not the cap", () => {
    const items = [item("btc-held", { post: CHOP }), item("btc-challenger")];
    const standing = () => stood(2, ["btc-held", "btc-other"]);
    expect(verdicts(items, standing).map((row) => row.reason)).toEqual(["bias_chop", "ledger_cap"]);
  });

  test("no cards, no plan", () => {
    expect(planMapAccept({ items: [] as Item[], standingFor: () => stood(0), decide })).toEqual([]);
  });
});

describe("allocation mode", () => {
  test("only rank ranks; anything else is the shipped order", () => {
    delete process.env.PAPER_MAP_ALLOCATE;
    expect(mapAllocateMode()).toBe("feed");
    process.env.PAPER_MAP_ALLOCATE = "rank";
    expect(mapAllocateMode()).toBe("rank");
    process.env.PAPER_MAP_ALLOCATE = " RANK ";
    expect(mapAllocateMode()).toBe("rank");
    process.env.PAPER_MAP_ALLOCATE = "0";
    expect(mapAllocateMode()).toBe("feed");
    process.env.PAPER_MAP_ALLOCATE = "armed";
    expect(mapAllocateMode()).toBe("feed");
  });
});

describe("family ranking", () => {
  function stats(key: string, over: Partial<FamilyStats>): [string, FamilyStats] {
    return [key, { score: null, trades: 0, avgRealizedRr: null, ...over } as FamilyStats];
  }

  test("family score ranks above card RR", () => {
    delete process.env.PAPER_ZONE_SCORE;
    const by = familyRankCompare(new Map([
      stats("BTCUSDT:240:supply", { score: "0.9", trades: 5 }),
      stats("BTCUSDT:240:demand", { score: "0.1", trades: 5 }),
    ]));
    const hot = card({ zoneId: "btc-4h-s-20260908-01", rr: 2 });
    const cold = card({ zoneId: "btc-4h-d-20260908-01", side: "demand", rr: 4 });
    // The sampled 0.9 family wins the slot despite the worse card RR.
    expect(by(hot, cold)).toBeLessThan(0);
    expect(by(cold, hot)).toBeGreaterThan(0);
  });

  test("with scoring off it degrades to RR then zoneId, which is ARM's rule", () => {
    process.env.PAPER_ZONE_SCORE = "0";
    const by = familyRankCompare(new Map([
      stats("BTCUSDT:240:supply", { score: "0.9", trades: 5 }),
    ]));
    expect(by(card({ zoneId: "btc-b", rr: 2 }), card({ zoneId: "btc-a", rr: 4 }))).toBeGreaterThan(0);
    expect(by(card({ zoneId: "btc-a" }), card({ zoneId: "btc-b" }))).toBeLessThan(0);
    expect(familyRankCompare(null)(card({ zoneId: "btc-a" }), card({ zoneId: "btc-a" }))).toBe(0);
  });
});
