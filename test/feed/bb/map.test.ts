import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TICKER } from "../../../src/feed/bb/brief";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  MAP_KLINE_LIMITS,
  MAP_LAG_INTERVALS,
  MAP_SYMBOL_CAP,
  buildMap,
  buildMapBatch,
  emptyMap,
  parseMapArgs,
  parseMapSymbols,
  resolveMapSymbols,
  type SnapshotMap,
  type SnapshotMapBatch,
} from "../../../src/feed/bb/map";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-map-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dir, dbPath, store: openDb(dbPath) };
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

function expectMapShape(map: SnapshotMap, symbol = "BTCUSDT") {
  expect(map.symbol).toBe(symbol);
  expect(Array.isArray(map.klines["240"])).toBe(true);
  expect(Array.isArray(map.klines["60"])).toBe(true);
  expect(Array.isArray(map.klines.D)).toBe(true);
  expect("15" in map.klines).toBe(false);
  expect(map.meta.note).toBe("htf map — agent draws S/D; no bias");
  expect(map.meta.limits).toEqual({ ...MAP_KLINE_LIMITS });
  expect(map.klineLag.ok).toBe(true);
  expect(map.klineLag.intervals).toEqual([...MAP_LAG_INTERVALS]);
  expect(map.oi.note).toBe("quant veto — not a signal");
  expect(Array.isArray(map.oi["240"])).toBe(true);
  expect(Array.isArray(map.oi["60"])).toBe(true);
}

describe("parseMapArgs / buildMap", () => {
  test("empty args means feed watchlist; cap is 10", () => {
    expect(parseMapArgs([])).toEqual({ symbols: [] });
    expect(resolveMapSymbols([], ["BTCUSDT", "ETHUSDT"])).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(parseMapArgs(["ethusdt"])).toEqual({ symbols: ["ETHUSDT"] });
    expect(parseMapArgs(["btcusdt", "ethusdt"])).toEqual({ symbols: ["BTCUSDT", "ETHUSDT"] });
    expect(parseMapSymbols("btc,ETH,btc")).toEqual(["BTC", "ETH"]);
    expect(MAP_SYMBOL_CAP).toBe(10);
  });

  test("empty database has no 15m key and empty D", () => {
    const { store, dbPath } = tempDb();
    try {
      const map = buildMap(store, { dbPath, now: 7 });
      expectMapShape(map);
      expect(map.ticker).toEqual(EMPTY_TICKER);
      expect("15" in map.klines).toBe(false);
      expect(map.klineLag.rows).toEqual([
        expect.objectContaining({ symbol: "BTCUSDT", interval: "60", stale: false }),
        expect.objectContaining({ symbol: "BTCUSDT", interval: "240", stale: false }),
      ]);
      const blank = emptyMap("BTCUSDT", dbPath, 7);
      expect(blank.klines).toEqual(map.klines);
    } finally {
      store.close();
    }
  });

  test("keeps 4H/1H windows and includes D when backfilled", () => {
    const { store, dbPath } = tempDb();
    try {
      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: { lastPrice: "100", fundingRate: "0.0001", openInterest: "9" },
      }, 50, false);
      for (let i = 0; i < 25; i++) {
        store.saveKline("BTCUSDT", candle({ start: i * 240 * 60_000, interval: "240" }), 50);
      }
      for (let i = 0; i < 30; i++) {
        store.saveKline("BTCUSDT", candle({ start: i * 60 * 60_000, interval: "60" }), 50);
      }
      store.saveKline("BTCUSDT", candle({ start: 1_000, interval: "15" }), 50);
      store.saveKline("BTCUSDT", candle({ start: 86_400_000, interval: "D", close: "101" }), 50);

      const map = buildMap(store, { dbPath, now: 3 });
      expectMapShape(map);
      expect(map.ticker.lastPrice).toBe("100");
      expect(map.ticker.fundingRate).toBe("0.0001");
      expect(map.klines["240"]).toHaveLength(20);
      expect(map.klines["60"]).toHaveLength(24);
      expect(map.klines.D).toEqual([
        expect.objectContaining({ start_ts: 86_400_000, close: "101" }),
      ]);
    } finally {
      store.close();
    }
  });

  test("batch maps two symbols independently", () => {
    const { store, dbPath } = tempDb();
    try {
      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: { lastPrice: "100" },
      }, 1, false);
      store.saveTicker({
        symbol: "ETHUSDT",
        type: "snapshot",
        fields: { lastPrice: "3" },
      }, 1, false);
      store.saveKline("BTCUSDT", candle({ start: 240_000, interval: "240" }), 1);
      store.saveKline("ETHUSDT", candle({ start: 241_000, interval: "240" }), 1);

      const batch = buildMapBatch(store, { symbols: ["BTCUSDT", "ETHUSDT"], dbPath, now: 8 });
      expect(batch.maps).toHaveLength(2);
      expect(batch.maps[0]?.ticker.lastPrice).toBe("100");
      expect(batch.maps[1]?.ticker.lastPrice).toBe("3");
      expect(batch.maps[1]?.klines["240"][0]?.start_ts).toBe(241_000);
      expect(batch.meta.count).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("GET /map", () => {
  test("matches buildMap and does not change /brief", async () => {
    const { store, dbPath } = tempDb();
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "50" },
    }, 99, false);
    store.saveKline("BTCUSDT", candle({ start: 1_000, interval: "240" }), 99);
    store.saveKline("BTCUSDT", candle({ start: 2_000, interval: "15" }), 99);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
      symbols: ["BTCUSDT", "ETHUSDT"],
    } as TrackerConfig, store);

    try {
      const expected = buildMap(store, { symbol: "BTCUSDT", dbPath, now: 0 });
      const res = await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`);
      expect(res.status).toBe(200);
      const body = await res.json() as SnapshotMap;
      expectMapShape(body);
      expect(body.ticker).toEqual(expected.ticker);
      expect(body.klines).toEqual(expected.klines);
      expect(body.klines["240"]).toHaveLength(1);
      expect(body.klines.D).toEqual([]);
      expect(body.klineLag.ok).toBe(true);
      expect(body.klineLag.rows.some((row) => row.interval === "15")).toBe(false);

      const brief = await (await fetch(`http://127.0.0.1:${server.port}/brief?symbol=BTCUSDT`)).json() as {
        klines: Record<string, unknown[]>;
      };
      expect(Object.keys(brief.klines)).toEqual(["15", "60", "240"]);
      expect(brief.klines["15"]).toHaveLength(1);

      const many = await fetch(`http://127.0.0.1:${server.port}/map?symbols=BTCUSDT,ETHUSDT`);
      expect(many.status).toBe(200);
      const batch = await many.json() as SnapshotMapBatch;
      expect(batch.maps).toHaveLength(2);
      expect(batch.maps[0]?.symbol).toBe("BTCUSDT");
      expect(batch.maps[1]?.symbol).toBe("ETHUSDT");
      expect(batch.klineLag.ok).toBe(true);

      const watch = await fetch(`http://127.0.0.1:${server.port}/map`);
      const watchBody = await watch.json() as SnapshotMapBatch;
      expect(watchBody.maps.map((row) => row.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
      expect(watchBody.klineLag.intervals).toEqual(["60", "240"]);

      const over = Array.from({ length: MAP_SYMBOL_CAP + 1 }, (_, i) => `S${i}`).join(",");
      const tooMany = await fetch(`http://127.0.0.1:${server.port}/map?symbols=${over}`);
      expect(tooMany.status).toBe(400);
    } finally {
      server.stop();
      store.close();
    }
  });
});
