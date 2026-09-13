import { describe, expect, test } from "bun:test";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import {
  healKlineGaps,
  scanKlineHoles,
  type KlineHole,
} from "../../../src/feed/bb/rest";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";
import type { RestFetch } from "../../../src/feed/bb/rest";

const M15 = 900_000;

describe("scanKlineHoles", () => {
  test("dense series has no holes", () => {
    const starts = [0, M15, 2 * M15, 3 * M15];
    expect(scanKlineHoles(starts, M15)).toEqual([]);
  });

  test("finds contiguous missing runs inside the range, never the tail", () => {
    const starts = [0, M15, 2 * M15, 5 * M15, 6 * M15];
    const holes: KlineHole[] = scanKlineHoles(starts, M15);
    expect(holes).toEqual([{ start: 3 * M15, end: 5 * M15 }]);
  });

  test("two separate gaps produce two runs", () => {
    const starts = [0, 2 * M15, 3 * M15, 5 * M15, 6 * M15];
    expect(scanKlineHoles(starts, M15)).toEqual([
      { start: M15, end: 2 * M15 },
      { start: 4 * M15, end: 5 * M15 },
    ]);
  });

  test("unsorted or duplicated input is tolerated; short input yields nothing", () => {
    expect(scanKlineHoles([3 * M15, M15, M15, 2 * M15, 0], M15)).toEqual([]);
    expect(scanKlineHoles([0, M15, 3 * M15, M15], M15)).toEqual([{ start: 2 * M15, end: 3 * M15 }]);
    expect(scanKlineHoles([0], M15)).toEqual([]);
    expect(scanKlineHoles([], M15)).toEqual([]);
  });
});

function healConfig(overrides: Partial<TrackerConfig["recovery"]> = {}): TrackerConfig {
  return {
    restEndpoint: "https://api.bybit.com",
    symbols: ["BTCUSDT"],
    klineIntervals: ["15"],
    retention: { klinesDays: 1 },
    recovery: { ...DEFAULT_RECOVERY, gapHeal: true, restRetries: 2, restRetryDelayMs: 1, restTimeoutMs: 200, ...overrides },
  } as TrackerConfig;
}

/** Venue stub: rows for the candle starts the fake venue "has", per interval. */
function fakeVenue(has: Map<number, string[]>, interval: string, now: number): RestFetch {
  return async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname !== "/v5/market/kline") throw new Error(`unexpected path ${parsed.pathname}`);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const list: string[][] = [];
    for (const [rowStart, row] of has) {
      if (rowStart >= start && rowStart < end) list.push([String(rowStart), ...row]);
    }
    void interval;
    void now;
    return {
      ok: true,
      status: 200,
      json: async () => ({ retCode: 0, retMsg: "OK", result: { list }, retExtInfo: {}, time: now }),
    } as never;
  };
}

describe("healKlineGaps", () => {
  test("fills an interior hole and finalizes a stale forming row from the venue", async () => {
    const now = 8 * M15 + 60_000; // every stored bar is already closed
    const stored = [0, M15, 2 * M15, 4 * M15, 5 * M15]; // hole at 3*M15; 2*M15 is a stale confirm=0 row
    const saved: Array<{ symbol: string; candle: BybitKline }> = [];

    const store = {
      getKlineStarts: (symbol: string, interval: string) => {
        void symbol;
        void interval;
        return [...stored];
      },
      getStaleFormingStarts: (symbol: string, interval: string, stepMs: number, asOf: number) => {
        void symbol;
        void interval;
        expect(stepMs).toBe(M15);
        return stored.filter((start) => start === 2 * M15 && start + stepMs <= asOf);
      },
      saveKline(symbol: string, candle: BybitKline) {
        saved.push({ symbol, candle });
      },
    };

    const venue = new Map<number, string[]>([
      [3 * M15, ["101", "105", "100", "104", "12", "1180"]],
      [2 * M15, ["91", "95", "90", "94", "9", "870"]], // final values for the dead-session row
    ]);
    const config = healConfig();
    const result = await healKlineGaps(config, store, {
      now,
      fetchImpl: fakeVenue(venue, "15", now),
    });

    expect(result.holes).toBe(2);
    expect(result.stale).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.candles).toBe(2);
    expect(saved.map((s) => s.candle.start).sort((a, b) => a - b)).toEqual([2 * M15, 3 * M15]);
    for (const s of saved) {
      expect(s.candle.confirm).toBe(true);
    }
    const holeCandle = saved.find((s) => s.candle.start === 3 * M15)!.candle;
    expect(holeCandle).toMatchObject({ open: "101", close: "104", volume: "12", turnover: "1180" });
  });

  test("gapHeal=false is a no-op that never touches the venue", async () => {
    let calls = 0;
    const config = healConfig({ gapHeal: false });
    const result = await healKlineGaps(config, {
      getKlineStarts: () => [0, 3 * M15],
      getStaleFormingStarts: () => [0],
      saveKline() {
        calls += 1;
      },
    }, {
      now: 8 * M15,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("venue must not be contacted");
      },
    });
    expect(result).toEqual({ series: 0, holes: 0, candles: 0, stale: 0, errors: 0 });
    expect(calls).toBe(0);
  });
});
