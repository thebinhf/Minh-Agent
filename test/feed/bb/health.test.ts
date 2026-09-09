import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import { openDb } from "../../../src/feed/bb/db";
import {
  applyKlineLagWatch,
  buildFeedHealth,
  buildKlineLag,
  DEFAULT_KLINE_LAG_MS,
  evaluateKlineLag,
  lagRowKey,
  TICKER_LIVE_MS,
  type KlineLagRow,
} from "../../../src/feed/bb/health";
import { startHttp } from "../../../src/feed/bb/http";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-kline-lag-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dir, dbPath, store: openDb(dbPath) };
}

function feedConfig(dbPath: string, extra: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    httpHost: "127.0.0.1",
    httpPort: 0,
    dbPath,
    symbols: ["BTCUSDT", "ETHUSDT"],
    klineIntervals: ["5", "15", "60", "240"],
    recovery: { ...DEFAULT_RECOVERY, klineLagMs: 180_000 },
    ...extra,
  } as TrackerConfig;
}

function candle(partial: Partial<BybitKline> & Pick<BybitKline, "start" | "interval">): BybitKline {
  return {
    end: partial.start + 60_000,
    open: "1",
    high: "2",
    low: "0.5",
    close: "1.5",
    volume: "10",
    turnover: "20",
    confirm: true,
    timestamp: partial.start,
    ...partial,
  };
}

const now = 2_000_000;
const interval15 = 15 * 60_000;
const expected15 = Math.floor(now / interval15) * interval15;

describe("evaluateKlineLag", () => {
  test("forming candle with fresh recv is not stale", () => {
    const row = evaluateKlineLag({
      symbol: "BTCUSDT",
      interval: "15",
      now,
      startTs: expected15,
      recvTs: now - 400,
      confirm: false,
      tickerRecvTs: now - 80,
      staleMs: 180_000,
    });
    expect(row.klineLagMs).toBe(400);
    expect(row.startTs).toBe(expected15);
    expect(row.formingStuck).toBe(false);
    expect(row.stale).toBe(false);
    expect(row.tickerLive).toBe(true);
  });

  test("forming stuck when kline recv is old but ticker WS still updates", () => {
    const row = evaluateKlineLag({
      symbol: "BTCUSDT",
      interval: "15",
      now,
      startTs: expected15,
      recvTs: now - 240_000,
      confirm: false,
      tickerRecvTs: now - 200,
      staleMs: 180_000,
    });
    expect(row.klineLagMs).toBe(240_000);
    expect(row.formingStuck).toBe(true);
    expect(row.stale).toBe(true);
  });

  test("does not flag forming stuck when ticker itself is stale", () => {
    const row = evaluateKlineLag({
      symbol: "BTCUSDT",
      interval: "15",
      now,
      startTs: expected15,
      recvTs: now - 240_000,
      confirm: false,
      tickerRecvTs: now - (TICKER_LIVE_MS + 1_000),
      staleMs: 180_000,
    });
    expect(row.tickerLive).toBe(false);
    expect(row.formingStuck).toBe(false);
    expect(row.stale).toBe(false);
  });

  test("confirmed series that did not open the current bar is stale after N minutes", () => {
    const row = evaluateKlineLag({
      symbol: "ETHUSDT",
      interval: "15",
      now,
      startTs: expected15 - interval15,
      recvTs: expected15,
      confirm: true,
      tickerRecvTs: now - 50,
      staleMs: 180_000,
    });
    expect(row.formingStuck).toBe(false);
    expect(row.stale).toBe(true);
    expect(row.startTs).toBe(expected15 - interval15);
  });

  test("missing klines while ticker is live stay null and do not trip the watchdog", () => {
    const row = evaluateKlineLag({
      symbol: "SOLUSDT",
      interval: "60",
      now,
      startTs: null,
      recvTs: null,
      confirm: null,
      tickerRecvTs: now - 10,
      staleMs: 180_000,
    });
    expect(row.klineLagMs).toBeNull();
    expect(row.startTs).toBeNull();
    expect(row.confirm).toBeNull();
    expect(row.formingStuck).toBe(false);
    expect(row.stale).toBe(false);
    expect(row.tickerLive).toBe(true);
  });

  test("missing everything stays null / not stale", () => {
    const row = evaluateKlineLag({
      symbol: "BTCUSDT",
      interval: "240",
      now,
      startTs: null,
      recvTs: null,
      confirm: null,
      tickerRecvTs: null,
      staleMs: 180_000,
    });
    expect(row.klineLagMs).toBeNull();
    expect(row.tickerAgeMs).toBeNull();
    expect(row.formingStuck).toBe(false);
    expect(row.stale).toBe(false);
  });
});

describe("applyKlineLagWatch", () => {
  test("trips once on edge and recovers once — no mid-watch spam", () => {
    const trips: string[] = [];
    const recovered: string[] = [];
    const stuck: KlineLagRow = {
      symbol: "BTCUSDT",
      interval: "15",
      startTs: 1,
      recvTs: 1,
      confirm: false,
      klineLagMs: 200_000,
      tickerAgeMs: 10,
      tickerLive: true,
      formingStuck: true,
      stale: true,
    };
    const ok: KlineLagRow = { ...stuck, stale: false, formingStuck: false, klineLagMs: 20 };

    let prev = new Set<string>();
    prev = applyKlineLagWatch(prev, [stuck], {
      trip: (row) => trips.push(lagRowKey(row)),
      recover: (symbol, interval) => recovered.push(`${symbol}|${interval}`),
    });
    prev = applyKlineLagWatch(prev, [stuck], {
      trip: (row) => trips.push(lagRowKey(row)),
      recover: (symbol, interval) => recovered.push(`${symbol}|${interval}`),
    });
    prev = applyKlineLagWatch(prev, [ok], {
      trip: (row) => trips.push(lagRowKey(row)),
      recover: (symbol, interval) => recovered.push(`${symbol}|${interval}`),
    });

    expect(trips).toEqual(["BTCUSDT|15"]);
    expect(recovered).toEqual(["BTCUSDT|15"]);
    expect(prev.size).toBe(0);
  });
});

describe("buildKlineLag + GET /health", () => {
  test("empty database emits per-symbol/interval rows with nulls", () => {
    const { store } = tempDb();
    try {
      const summary = buildKlineLag(store, {
        config: { symbols: ["BTCUSDT"] },
        now,
        staleMs: DEFAULT_KLINE_LAG_MS,
      });
      expect(summary.ok).toBe(true);
      expect(summary.staleMs).toBe(DEFAULT_KLINE_LAG_MS);
      expect(summary.intervals).toEqual(["15", "60", "240"]);
      expect(summary.rows).toHaveLength(3);
      expect(summary.rows.every((row) => row.symbol === "BTCUSDT")).toBe(true);
      expect(summary.rows.every((row) => row.startTs == null && row.klineLagMs == null && row.formingStuck === false && row.stale === false)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("GET /health includes klineLag and keeps ok on ticker freshness, not kline lag", async () => {
    const { store, dbPath } = tempDb();
    const tickTs = Date.now();
    store.setHealth({ connected: 1, lastMessageTs: tickTs, endpoint: "wss://example" });
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "100" },
    }, tickTs, false);
    store.saveKline("BTCUSDT", candle({
      start: expected15,
      interval: "15",
      confirm: false,
    }), tickTs - 240_000);

    const server = startHttp(feedConfig(dbPath), store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        tickers: unknown[];
        klineLag: { ok: boolean; rows: KlineLagRow[] };
      };
      expect(body.ok).toBe(true);
      expect(body.klineLag.ok).toBe(false);
      const row15 = body.klineLag.rows.find((row) => row.symbol === "BTCUSDT" && row.interval === "15");
      expect(row15?.formingStuck).toBe(true);
      expect(row15?.startTs).toBe(expected15);
      expect(row15?.klineLagMs).toBeGreaterThanOrEqual(180_000);
      expect(body.tickers).toEqual([
        expect.objectContaining({ symbol: "BTCUSDT", lastPrice: "100" }),
      ]);
    } finally {
      server.stop();
      store.close();
    }
  });
});
