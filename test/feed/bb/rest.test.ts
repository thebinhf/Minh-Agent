import { describe, expect, test } from "bun:test";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import {
  fetchLinearKlines,
  fillKlineGaps,
  fillKlineHistory,
  parseRestKlineList,
  resetRestHostCache,
  restBases,
} from "../../../src/feed/bb/rest";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";

describe("parseRestKlineList", () => {
  test("maps Bybit REST tuples and marks the open candle unconfirmed", () => {
    const now = 15 * 60_000 + 1_000;
    const candles = parseRestKlineList(
      [
        [String(15 * 60_000), "2", "4", "1", "3", "10", "20"],
        ["0", "1", "1", "1", "1", "1", "1"],
      ],
      "15",
      now,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      start: 15 * 60_000,
      interval: "15",
      open: "2",
      high: "4",
      low: "1",
      close: "3",
      confirm: false,
    });
    expect(candles[1]?.confirm).toBe(true);
  });
});

describe("fillKlineGaps", () => {
  const config = {
    restEndpoint: "https://api.bybit.com",
    symbols: ["BTCUSDT"],
    klineIntervals: ["15"],
    retention: { klinesDays: 1 },
    recovery: { ...DEFAULT_RECOVERY, restRetries: 2, restRetryDelayMs: 1, restTimeoutMs: 200 },
  } as TrackerConfig;

  test("upserts REST pages onto an empty series then stops", async () => {
    const saved: BybitKline[] = [];
    const urls: string[] = [];
    const result = await fillKlineGaps(config, {
      getLastKlineStart: () => null,
      saveKline(_symbol, candle) {
        saved.push(candle);
      },
    }, {
      now: 2_000_000,
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            retCode: 0,
            result: {
              list: [["1500000", "1", "2", "0.5", "1.5", "9", "8"]],
            },
          }),
        };
      },
    });

    expect(result).toEqual({ series: 1, candles: 1, errors: 0 });
    expect(saved[0]?.start).toBe(1_500_000);
    expect(urls[0]).toContain("/v5/market/kline");
    expect(urls[0]).toContain("symbol=BTCUSDT");
    expect(urls[0]).toContain("interval=15");
  });

  test("does not retry a geo-block HTTP 403", async () => {
    let calls = 0;
    const result = await fillKlineGaps(config, {
      getLastKlineStart: () => null,
      saveKline() {},
    }, {
      now: 2_000_000,
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 403,
          json: async () => ({}),
        };
      },
    });
    expect(calls).toBe(1);
    expect(result.errors).toBe(1);
  });

  test("counts a series error when REST keeps failing, and does not throw", async () => {
    const result = await fillKlineGaps(config, {
      getLastKlineStart: () => 1_900_000,
      saveKline() {
        throw new Error("should not save");
      },
    }, {
      now: 2_000_000,
      fetchImpl: async () => {
        throw new Error("geo blocked");
      },
    });
    expect(result.series).toBe(1);
    expect(result.candles).toBe(0);
    expect(result.errors).toBe(1);
  });

  test("skips work when gapFill is disabled", async () => {
    const result = await fillKlineGaps(
      { ...config, recovery: { ...config.recovery, gapFill: false } },
      {
        getLastKlineStart: () => {
          throw new Error("unused");
        },
        saveKline() {
          throw new Error("unused");
        },
      },
    );
    expect(result).toEqual({ series: 0, candles: 0, errors: 0 });
  });
});

describe("REST host failover", () => {
  test("restBases de-dupes primary and fallbacks", () => {
    expect(restBases({
      restEndpoint: "https://api.bybit.com/",
      restFallbacks: ["https://api.manepa.jp", "https://api.bybit.com"],
    })).toEqual(["https://api.bybit.com", "https://api.manepa.jp"]);
  });

  test("skips a CloudFront 403 host and uses the next public base", async () => {
    resetRestHostCache();
    const config = {
      restEndpoint: "https://api.bybit.com",
      restFallbacks: ["https://api.manepa.jp"],
      recovery: { ...DEFAULT_RECOVERY, restRetries: 2, restRetryDelayMs: 1, restTimeoutMs: 200 },
    } as TrackerConfig;
    const urls: string[] = [];
    const candles = await fetchLinearKlines(config, {
      symbol: "BTCUSDT",
      interval: "15",
      start: 1,
      end: 2,
      now: 2_000_000,
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("api.bybit.com")) {
          return { ok: false, status: 403, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            retCode: 0,
            result: { list: [["1500000", "1", "2", "0.5", "1.5", "9", "8"]] },
          }),
        };
      },
    });
    expect(candles).toHaveLength(1);
    expect(urls[0]).toContain("api.bybit.com");
    expect(urls[1]).toContain("api.manepa.jp");

    urls.length = 0;
    await fetchLinearKlines(config, {
      symbol: "ETHUSDT",
      interval: "15",
      start: 1,
      end: 2,
      now: 2_000_000,
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            retCode: 0,
            result: { list: [["1500000", "1", "2", "0.5", "1.5", "9", "8"]] },
          }),
        };
      },
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.manepa.jp");
    resetRestHostCache();
  });

  test("fillKlineHistory pages a window even when recent candles already exist", async () => {
    const config = {
      restEndpoint: "https://api.bybit.com",
      restFallbacks: [],
      symbols: ["BTCUSDT"],
      klineIntervals: ["15"],
      retention: { klinesDays: 1 },
      recovery: { ...DEFAULT_RECOVERY, restRetries: 1, restRetryDelayMs: 1, restTimeoutMs: 200 },
    } as TrackerConfig;
    const saved: number[] = [];
    const result = await fillKlineHistory(config, {
      saveKline(_symbol, candle) {
        saved.push(candle.start);
      },
    }, {
      symbols: ["BTCUSDT"],
      intervals: ["15"],
      start: 1_000_000,
      end: 2_000_000,
      now: 2_000_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          retCode: 0,
          result: { list: [["1200000", "1", "2", "0.5", "1.5", "9", "8"]] },
        }),
      }),
    });
    expect(result.candles).toBe(1);
    expect(saved).toEqual([1_200_000]);
  });
});
