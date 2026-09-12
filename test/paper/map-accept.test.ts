import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  lastPricesFromMap,
  mapAcceptEnabled,
  mapSkipSymbol,
  pickAcceptable,
  runMapAccept,
  shouldAcceptCard,
} from "../../src/paper/map-accept";
import { mockFeed, OPEN_LONG, paperEngine } from "./helpers";
import type { ZoneCard } from "../../src/zones/card";

const dirs: string[] = [];
const saved = process.env.MAP_ACCEPT;
const savedScore = process.env.PAPER_ZONE_SCORE;

const savedSkip = process.env.PAPER_MAP_SKIP;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (saved === undefined) delete process.env.MAP_ACCEPT;
  else process.env.MAP_ACCEPT = saved;
  if (savedScore === undefined) delete process.env.PAPER_ZONE_SCORE;
  else process.env.PAPER_ZONE_SCORE = savedScore;
  if (savedSkip === undefined) delete process.env.PAPER_MAP_SKIP;
  else process.env.PAPER_MAP_SKIP = savedSkip;
});

const SUPPLY: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
  setup: "sd",
  baseStartTs: 1_788_801_600_000,
  baseEndTs: 1_788_808_800_000,
  zoneLow: 79_250,
  zoneHigh: 79_472,
  distal: 79_472,
  proximal: 79_250,
  impulseBody: 980,
  atr14: 720,
  impulseAtr: 1.36,
  departureAtr: 0.42,
  freshness: "virgin",
  penetrationPct: 0,
  entry: 79_300,
  sl: 79_880,
  tp: 77_580,
  rr: 2.97,
  hardInvalid: 79_880,
  softInvalid: 79_472,
  expiryBars: 48,
  cancelCodes: [],
};

const DEMAND: ZoneCard = {
  ...SUPPLY,
  zoneId: "btc-4h-d-20260908-01",
  side: "demand",
  setup: "sd",
  distal: 79_250,
  proximal: 79_472,
  entry: 79_400,
  sl: 79_100,
  tp: 80_200,
  rr: 2.1,
  hardInvalid: 79_100,
  softInvalid: 79_250,
};

const DEMAND_HIGH_RR: ZoneCard = {
  ...DEMAND,
  zoneId: "btc-4h-d-20260908-02",
  rr: 3.5,
};

describe("map accept (P5)", () => {
  test("skips deep/invalid last; mid-range (away) is acceptable", () => {
    expect(shouldAcceptCard(SUPPLY, 79_600)).toBe(true);
    expect(shouldAcceptCard(SUPPLY, 79_280)).toBe(true);
    expect(shouldAcceptCard(SUPPLY, 79_400)).toBe(false);
    expect(shouldAcceptCard(SUPPLY, 80_000)).toBe(false);
    expect(shouldAcceptCard(SUPPLY, undefined)).toBe(true);
    expect(lastPricesFromMap({
      maps: [{ symbol: "btcusdt", ticker: { lastPrice: "79600" } }],
    }).get("BTCUSDT")).toBe(79600);
    expect(pickAcceptable([SUPPLY], new Map([["BTCUSDT", 80_000]]))).toEqual([]);
    delete process.env.PAPER_MAP_SKIP;
    expect(mapSkipSymbol("HYPEUSDT")).toBe(false);
    expect(shouldAcceptCard({ ...SUPPLY, symbol: "HYPEUSDT" }, 79_600)).toBe(true);
    process.env.PAPER_MAP_SKIP = "HYPEUSDT";
    expect(mapSkipSymbol("HYPEUSDT")).toBe(true);
    expect(shouldAcceptCard({ ...SUPPLY, symbol: "HYPEUSDT" }, 79_600)).toBe(false);
    process.env.PAPER_MAP_SKIP = "0";
    expect(mapSkipSymbol("HYPEUSDT")).toBe(false);
  });

  test("accepts a card into the ledger and does not arm; MAP_ACCEPT=0 skips", async () => {
    delete process.env.MAP_ACCEPT;
    expect(mapAcceptEnabled()).toBe(true);
    const ctx = await paperEngine(mockFeed({ lastPrice: "79600", markPrice: "79600" }));
    dirs.push(ctx.dir);
    const last = lastPricesFromMap({
      maps: [{ symbol: "BTCUSDT", ticker: { lastPrice: "79600" } }],
    });
    const first = runMapAccept(ctx.engine, [SUPPLY], last);
    expect(first.accepted).toEqual([SUPPLY.zoneId]);
    expect(ctx.engine.orders("pending")).toEqual([]);
    const dup = runMapAccept(ctx.engine, [SUPPLY], last);
    expect(dup.accepted).toEqual([]);
    expect(dup.skipped).toBe(1);

    process.env.MAP_ACCEPT = "0";
    const ctx2 = await paperEngine(mockFeed());
    dirs.push(ctx2.dir);
    expect(runMapAccept(ctx2.engine, [SUPPLY], last).accepted).toEqual([]);
  });

  test("source does not paper arm or hit private Bybit", async () => {
    const src = await Bun.file("src/paper/map-accept.ts").text();
    expect(src).not.toContain("paper arm");
    expect(src).not.toContain("/v5/order");
  });

  test("family score ranks before ledger cap; sampled losing demand is family_floor", async () => {
    delete process.env.MAP_ACCEPT;
    delete process.env.PAPER_ZONE_SCORE;
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    const now = Date.now();

    async function closeAt(last: string, zoneId: string, t: number) {
      feed.ticker = async (symbol) => ({
        symbol,
        lastPrice: "63000",
        markPrice: "63000",
        recvTs: t,
        fundingRate: null,
        nextFundingTime: null,
      });
      await ctx.engine.open({ ...OPEN_LONG, zoneId }, t);
      feed.ticker = async (symbol) => ({
        symbol,
        lastPrice: last,
        markPrice: last,
        recvTs: t + 1,
        fundingRate: null,
        nextFundingTime: null,
      });
      await ctx.engine.mark(t + 1);
    }

    await closeAt("59000", "btc-4h-d-20260901-01", now);
    await closeAt("59000", "btc-4h-d-20260901-02", now + 10);
    await closeAt("67000", "btc-4h-s-20260901-01", now + 20);
    await closeAt("67000", "btc-4h-s-20260901-02", now + 30);

    const last = lastPricesFromMap({
      maps: [{ symbol: "BTCUSDT", ticker: { lastPrice: "79600" } }],
    });
    const ranked = runMapAccept(ctx.engine, [DEMAND, DEMAND_HIGH_RR, SUPPLY], last, now + 40);
    expect(ranked.accepted).toEqual([SUPPLY.zoneId]);
    expect(ranked.skipped).toBe(2);
    expect(ctx.engine.zones("accepted").map((row) => row.zoneId)).toEqual([SUPPLY.zoneId]);

    process.env.PAPER_ZONE_SCORE = "0";
    const ctx2 = await paperEngine(mockFeed({ lastPrice: "79600", markPrice: "79600" }));
    dirs.push(ctx2.dir);
    const unranked = runMapAccept(ctx2.engine, [DEMAND, DEMAND_HIGH_RR, SUPPLY], last);
    expect(unranked.accepted).toEqual([DEMAND.zoneId, DEMAND_HIGH_RR.zoneId]);
  });
});
