import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBackfillArgs, runBackfill } from "../../../src/feed/bb/backfill";
import { DEFAULT_RECOVERY, DEFAULT_REST_FALLBACKS, loadConfig } from "../../../src/feed/bb/config";
import { openDb } from "../../../src/feed/bb/db";
import { PA_KLINE_INTERVALS, type TrackerConfig } from "../../../src/feed/bb/types";

const config = {
  restEndpoint: "https://api.bybit.com",
  restFallbacks: ["https://api.manepa.jp"],
  symbols: ["BTCUSDT", "ETHUSDT"],
  klineIntervals: ["5", "15", "60", "240"],
  dbPath: "./data/bybit-market.sqlite",
  retention: { klinesDays: 14 },
  recovery: { ...DEFAULT_RECOVERY, restRetries: 1, restRetryDelayMs: 1, restTimeoutMs: 200 },
} as TrackerConfig;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-backfill-"));
  dirs.push(dir);
  return { dir, store: openDb(join(dir, "market.sqlite")) };
}

describe("loadConfig REST fallbacks", () => {
  test("loads documented manepa fallback from config.json", async () => {
    const loaded = await loadConfig();
    expect(loaded.restEndpoint).toBe("https://api.bybit.com");
    expect(loaded.restFallbacks).toEqual(DEFAULT_REST_FALLBACKS);
  });

  test("default public linear watchlist is 10 symbols including HYPEUSDT", async () => {
    const loaded = await loadConfig();
    expect(loaded.symbols).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "ENAUSDT",
      "BNBUSDT",
      "XRPUSDT",
      "DOGEUSDT",
      "AVAXUSDT",
      "LINKUSDT",
      "HYPEUSDT",
    ]);
  });
});

describe("parseBackfillArgs", () => {
  test("defaults to REST + PA intervals and retention lookback", () => {
    const now = 2_000_000;
    const parsed = parseBackfillArgs([], config, now);
    expect(parsed).toMatchObject({
      source: "rest",
      symbols: ["BTCUSDT", "ETHUSDT"],
      intervals: [...PA_KLINE_INTERVALS],
      end: now,
      start: now - 14 * 86_400_000,
    });
  });

  test("parses a dump path and explicit window", () => {
    const parsed = parseBackfillArgs(
      ["--from", "./out.json", "--symbol", "SOLUSDT", "--interval", "60", "--start", "1000", "--end", "2000"],
      config,
      9_000,
    );
    expect(parsed).toEqual({
      source: { file: "./out.json" },
      symbols: ["SOLUSDT"],
      intervals: ["60"],
      start: 1000,
      end: 2000,
      now: 9_000,
    });
  });

  test("accepts Bybit named intervals D and W (and M)", () => {
    const parsed = parseBackfillArgs(
      ["--interval", "D,W,M", "--symbol", "BTCUSDT"],
      config,
      2_000_000,
    );
    expect(parsed).toMatchObject({
      source: "rest",
      symbols: ["BTCUSDT"],
      intervals: ["D", "W", "M"],
    });
  });

  test("normalizes lowercase named intervals and keeps minute ids", () => {
    const parsed = parseBackfillArgs(
      ["--interval", "5,15,d,w"],
      config,
      2_000_000,
    );
    expect(parsed).toMatchObject({
      intervals: ["5", "15", "D", "W"],
    });
  });

  test("rejects unknown interval tokens before REST", () => {
    expect(() => parseBackfillArgs(["--interval", "15,Q"], config, 1)).toThrow(
      "Unsupported kline interval: Q",
    );
  });
});

describe("runBackfill", () => {
  test("imports a JSON dump into SQLite and reports stats", async () => {
    const { dir, store } = tempDb();
    const dumpPath = join(dir, "BTCUSDT_15_sample.json");
    writeFileSync(dumpPath, JSON.stringify({
      result: {
        symbol: "BTCUSDT",
        list: [
          ["1735689600000", "1", "3", "0.5", "2", "10", "20"],
          ["1735690500000", "2", "4", "1.5", "3", "11", "21"],
        ],
      },
    }));

    try {
      const result = await runBackfill(config, store, {
        source: { file: dumpPath },
        symbols: ["BTCUSDT"],
        intervals: ["15"],
        start: 0,
        end: 2_000_000,
        now: Date.parse("2025-01-02T00:00:00.000Z"),
      });
      expect(result).toMatchObject({ series: 1, candles: 2, errors: 0 });
      const rows = store.listKlines({ symbol: "BTCUSDT", interval: "15", limit: 10 });
      expect(rows).toHaveLength(2);
      expect(store.klineStats("BTCUSDT", "15")[0]?.count).toBe(2);
      const window = store.listKlines({
        symbol: "BTCUSDT",
        interval: "15",
        startTs: 1_735_689_600_000,
        endTs: 1_735_689_600_000,
        limit: 10,
      });
      expect(window).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("REST backfill upserts candles from a working fetch", async () => {
    const { store } = tempDb();
    try {
      const result = await runBackfill(config, store, {
        source: "rest",
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
            result: { list: [["1500000", "1", "2", "0.5", "1.5", "9", "8"]] },
          }),
        }),
      });
      expect(result.candles).toBe(1);
      expect(result.errors).toBe(0);
      expect(store.getLastKlineStart("BTCUSDT", "15")).toBe(1_500_000);
    } finally {
      store.close();
    }
  });

  test("REST backfill accepts daily interval D", async () => {
    const { store } = tempDb();
    const start = Date.UTC(2025, 0, 1);
    try {
      const result = await runBackfill(config, store, {
        source: "rest",
        symbols: ["BTCUSDT"],
        intervals: ["D"],
        start,
        end: Date.UTC(2025, 0, 3),
        now: Date.UTC(2025, 0, 3),
        fetchImpl: async (url) => {
          expect(url).toContain("interval=D");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              retCode: 0,
              result: { list: [[String(start), "1", "2", "0.5", "1.5", "9", "8"]] },
            }),
          };
        },
      });
      expect(result.candles).toBe(1);
      expect(result.errors).toBe(0);
      expect(store.getLastKlineStart("BTCUSDT", "D")).toBe(start);
      const rows = store.listKlines({ symbol: "BTCUSDT", interval: "D", limit: 10 });
      expect(rows[0]).toMatchObject({ interval: "D", start_ts: start });
    } finally {
      store.close();
    }
  });
});
