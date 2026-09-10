import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  OI_NOTE,
  buildMapOi,
  buildOi,
  oiDeltaPct,
  parseOiInterval,
  parseRestOiList,
  toBybitOiInterval,
} from "../../../src/feed/bb/oi";
import { fillOiGaps } from "../../../src/feed/bb/rest";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-oi-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dir, dbPath, store: openDb(dbPath) };
}

describe("OI mapping", () => {
  test("maps feed intervals to Bybit intervalTime", () => {
    expect(parseOiInterval(null)).toBe("240");
    expect(parseOiInterval("60")).toBe("60");
    expect(parseOiInterval("d")).toBe("D");
    expect(parseOiInterval("1h")).toBeNull();
    expect(toBybitOiInterval("240")).toBe("4h");
    expect(toBybitOiInterval("60")).toBe("1h");
    expect(toBybitOiInterval("15")).toBe("15min");
    expect(toBybitOiInterval("D")).toBe("1d");
  });

  test("parses REST list newest-first and computes deltaPct", () => {
    const bars = parseRestOiList([
      { openInterest: "120", timestamp: "2000" },
      { openInterest: "100", timestamp: "1000" },
      { openInterest: "120", timestamp: "2000" },
    ]);
    expect(bars).toEqual([
      { startTs: 1000, openInterest: "100" },
      { startTs: 2000, openInterest: "120" },
    ]);
    expect(oiDeltaPct(bars)).toBe("20.0000");
    expect(oiDeltaPct([{ startTs: 1, openInterest: "5" }])).toBeNull();
  });
});

describe("OI store + HTTP", () => {
  test("upserts bars, GET /oi, MAP summary uses 4H delta", async () => {
    const { store, dbPath } = tempDb();
    store.saveOi("BTCUSDT", "240", { startTs: 1_000, openInterest: "100" }, 9);
    store.saveOi("BTCUSDT", "240", { startTs: 2_000, openInterest: "110" }, 9);
    store.saveOi("BTCUSDT", "60", { startTs: 1_500, openInterest: "50" }, 9);

    const snap = buildOi(store, { symbol: "BTCUSDT", interval: "240", dbPath, now: 9 });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.bars).toHaveLength(2);
    expect(snap.latest).toBe("110");
    expect(snap.deltaPct).toBe("10.0000");
    expect(snap.meta.note).toBe(OI_NOTE);

    const mapOi = buildMapOi(store, "BTCUSDT", "111");
    expect(mapOi.latest).toBe("111");
    expect(mapOi.deltaPct).toBe("10.0000");
    expect(mapOi["240"]).toHaveLength(2);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/oi?symbol=BTCUSDT&interval=240`);
      expect(res.status).toBe(200);
      const body = await res.json() as { latest: string; deltaPct: string };
      expect(body.latest).toBe("110");
      expect(body.deltaPct).toBe("10.0000");
      const bad = await fetch(`http://127.0.0.1:${server.port}/oi?interval=7`);
      expect(bad.status).toBe(400);
    } finally {
      server.stop();
      store.close();
    }
  });
});

describe("fillOiGaps", () => {
  const config = {
    restEndpoint: "https://api.bybit.com",
    symbols: ["BTCUSDT"],
    klineIntervals: ["15"],
    retention: { klinesDays: 1 },
    recovery: { ...DEFAULT_RECOVERY, restRetries: 1, restRetryDelayMs: 1, restTimeoutMs: 200 },
  } as TrackerConfig;

  test("writes linear OI from REST", async () => {
    const { store } = tempDb();
    const urls: string[] = [];
    const result = await fillOiGaps(config, store, {
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
                { openInterest: "10", timestamp: "1500000" },
                { openInterest: "11", timestamp: "1800000" },
              ],
            },
          }),
        };
      },
    });
    expect(result.errors).toBe(0);
    expect(result.bars).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes("/v5/market/open-interest"))).toBe(true);
    expect(urls.some((url) => url.includes("intervalTime=4h") || url.includes("intervalTime=1h"))).toBe(true);
    expect(store.getLastOiStart("BTCUSDT", "240") ?? store.getLastOiStart("BTCUSDT", "60")).not.toBeNull();
    store.close();
  });
});
