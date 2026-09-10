import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  lastPricesFromMap,
  mapAcceptEnabled,
  pickAcceptable,
  runMapAccept,
  shouldAcceptCard,
} from "../../src/paper/map-accept";
import { mockFeed, paperEngine } from "./helpers";
import type { ZoneCard } from "../../src/zones/card";

const dirs: string[] = [];
const saved = process.env.MAP_ACCEPT;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (saved === undefined) delete process.env.MAP_ACCEPT;
  else process.env.MAP_ACCEPT = saved;
});

const SUPPLY: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
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
});
