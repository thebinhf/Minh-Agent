import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  FUNDING_NOTE,
  buildFunding,
  buildMapFunding,
  fundingCrowded,
  parseRestFundingList,
} from "../../../src/feed/bb/funding";
import { fillFundingGaps } from "../../../src/feed/bb/rest";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-funding-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dbPath, store: openDb(dbPath) };
}

describe("funding parse + crowded veto", () => {
  test("sorts REST list and flags extreme long/short", () => {
    const bars = parseRestFundingList([
      { fundingRate: "0.0004", fundingRateTimestamp: "2000" },
      { fundingRate: "0.0001", fundingRateTimestamp: "1000" },
      { fundingRate: "0.0004", fundingRateTimestamp: "2000" },
    ]);
    expect(bars).toEqual([
      { fundingTs: 1000, fundingRate: "0.0001" },
      { fundingTs: 2000, fundingRate: "0.0004" },
    ]);
    expect(fundingCrowded("0.0004", "0.0003")).toBe("long");
    expect(fundingCrowded("-0.0005", "0.0003")).toBe("short");
    expect(fundingCrowded("0.0001", "0.0003")).toBeNull();
  });
});

describe("funding store + HTTP", () => {
  test("GET /funding and MAP summary use tape + ticker nextFundingTime", async () => {
    const { store, dbPath } = tempDb();
    store.saveFunding("BTCUSDT", { fundingTs: 1_000, fundingRate: "0.0001" }, 9);
    store.saveFunding("BTCUSDT", { fundingTs: 2_000, fundingRate: "0.0004" }, 9);
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "50", fundingRate: "0.0004", nextFundingTime: "3000" },
    }, 9, false);

    const snap = buildFunding(store, {
      symbol: "BTCUSDT",
      dbPath,
      now: 9,
      ticker: { fundingRate: "0.0004", nextFundingTime: "3000" },
    });
    expect(snap.bars).toHaveLength(2);
    expect(snap.latest).toBe("0.0004");
    expect(snap.crowded).toBe("long");
    expect(snap.nextFundingTime).toBe("3000");
    expect(snap.meta.note).toBe(FUNDING_NOTE);

    const mapFunding = buildMapFunding(store, "BTCUSDT", {
      fundingRate: "0.0004",
      nextFundingTime: "3000",
    });
    expect(mapFunding.crowded).toBe("long");

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/funding?symbol=BTCUSDT`);
      expect(res.status).toBe(200);
      const body = await res.json() as { crowded: string; nextFundingTime: string };
      expect(body.crowded).toBe("long");
      expect(body.nextFundingTime).toBe("3000");
    } finally {
      server.stop();
      store.close();
    }
  });
});

describe("fillFundingGaps", () => {
  const config = {
    restEndpoint: "https://api.bybit.com",
    symbols: ["BTCUSDT"],
    klineIntervals: ["15"],
    retention: { klinesDays: 1 },
    recovery: { ...DEFAULT_RECOVERY, restRetries: 1, restRetryDelayMs: 1, restTimeoutMs: 200 },
  } as TrackerConfig;

  test("writes linear funding history from REST", async () => {
    const { store } = tempDb();
    const urls: string[] = [];
    const result = await fillFundingGaps(config, store, {
      now: 2_000_000,
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            retCode: 0,
            result: {
              list: [
                { symbol: "BTCUSDT", fundingRate: "0.0001", fundingRateTimestamp: "1500000" },
                { symbol: "BTCUSDT", fundingRate: "-0.0002", fundingRateTimestamp: "1800000" },
              ],
            },
          }),
        };
      },
    });
    expect(result.errors).toBe(0);
    expect(result.bars).toBe(2);
    expect(urls.some((url) => url.includes("/v5/market/funding/history"))).toBe(true);
    expect(store.getLastFundingTs("BTCUSDT")).toBe(1_800_000);
    store.close();
  });
});
