import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import type { BybitKline, OrderBookState, TrackerConfig } from "../../../src/feed/bb/types";
import {
  bucketPrice,
  buildChart,
  buildDepth,
  buildHeatmap,
  stitchBars,
} from "../../../src/feed/bb/view";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-view-"));
  dirs.push(dir);
  return { dir, dbPath: join(dir, "market.sqlite"), store: openDb(join(dir, "market.sqlite")) };
}

function candle(partial: Partial<BybitKline> & Pick<BybitKline, "start" | "interval">): BybitKline {
  return {
    end: partial.start + 15 * 60_000,
    open: "100",
    high: "110",
    low: "90",
    close: "105",
    volume: "10",
    turnover: "1000",
    confirm: true,
    timestamp: partial.start,
    ...partial,
  };
}

function book(symbol: string, bids: Array<[string, string]>, asks: Array<[string, string]>): OrderBookState {
  return {
    symbol,
    bids: new Map(bids),
    asks: new Map(asks),
    updateId: 1,
    seq: 1,
    ready: true,
  };
}

describe("stitchBars — nối nến từ kline WS", () => {
  test("sorts oldest-first, overwrites the same startTs, and keeps kline volume", () => {
    const { bars, gaps } = stitchBars([
      { start_ts: 30_000, open: "3", volume: "30", confirm: 1 },
      { start_ts: 10_000, open: "1", volume: "10", confirm: 1 },
      { start_ts: 10_000, open: "1b", volume: "11", confirm: 0 },
      { start_ts: 20_000, open: "2", volume: "20", confirm: 1 },
    ], 10_000);
    expect(gaps).toEqual([]);
    expect(bars.map((bar) => bar.startTs)).toEqual([10_000, 20_000, 30_000]);
    expect(bars[0]).toMatchObject({ open: "1b", volume: "11", confirm: false });
    expect(bars.every((bar) => bar.volume !== null)).toBe(true);
  });

  test("records missing interval steps as gaps", () => {
    const { bars, gaps } = stitchBars([
      { start_ts: 0, volume: "1", confirm: 1 },
      { start_ts: 45_000, volume: "2", confirm: 1 },
    ], 15_000);
    expect(bars).toHaveLength(2);
    expect(gaps).toEqual([{ afterTs: 0, nextTs: 45_000, missing: 2 }]);
  });
});

describe("buildChart / buildDepth / buildHeatmap", () => {
  test("chart reads stitched klines and marks the forming bar", () => {
    const { store } = tempDb();
    try {
      store.saveKline("BTCUSDT", candle({ start: 0, interval: "15", volume: "1", confirm: true }), 1);
      store.saveKline("BTCUSDT", candle({ start: 15 * 60_000, interval: "15", volume: "2", confirm: false }), 2);
      store.saveKline("BTCUSDT", candle({ start: 0, interval: "15", volume: "9", confirm: true }), 3);
      const chart = buildChart(store, { symbol: "btcusdt", interval: "15" });
      expect(chart.source).toBe("kline");
      expect(chart.volumeSource).toBe("kline.volume");
      expect(chart.intervalMs).toBe(15 * 60_000);
      expect(chart.bars).toHaveLength(2);
      expect(chart.bars[0]?.volume).toBe("9");
      expect(chart.bars[1]?.confirm).toBe(false);
      expect(chart.forming).toBe(true);
      expect(chart.gaps).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("depth builds an inside-out cumulative ladder from the live book", () => {
    const { store } = tempDb();
    try {
      store.saveOrderbook(book("ETHUSDT", [
        ["99", "2"],
        ["100", "1"],
        ["98", "3"],
      ], [
        ["101", "1"],
        ["102", "4"],
      ]), 50, "snapshot", 50, 40, false);
      const depth = buildDepth(store, { symbol: "ETHUSDT" });
      expect(depth.bestBid).toBe("100");
      expect(depth.bestAsk).toBe("101");
      expect(depth.spread).toBe("1");
      expect(depth.mid).toBe("100.5");
      expect(depth.bids.map((row) => [row.price, row.size, row.cumSize])).toEqual([
        ["100", "1", "1"],
        ["99", "2", "3"],
        ["98", "3", "6"],
      ]);
      expect(depth.asks.map((row) => [row.price, row.cumSize])).toEqual([
        ["101", "1"],
        ["102", "5"],
      ]);
    } finally {
      store.close();
    }
  });

  test("heatmap grids resting size over snapshot time and can bucket prices", () => {
    const { store } = tempDb();
    try {
      store.saveOrderbook(book("BTCUSDT", [["100.4", "1"], ["99.6", "2"]], [["101.2", "3"]]), 50, "snapshot", 1_000, 1_000, true);
      store.saveOrderbook(book("BTCUSDT", [["100.1", "5"]], [["101.8", "1"], ["102.2", "1"]]), 50, "delta", 2_000, 2_000, true);
      const raw = buildHeatmap(store, { symbol: "BTCUSDT" });
      expect(raw.snapshotCount).toBe(2);
      expect(raw.times).toEqual([1_000, 2_000]);
      expect(raw.bucket).toBeNull();
      expect(raw.prices).toContain("100.4");
      expect(raw.bid[0]?.[raw.prices.indexOf("100.4")]).toBe("1");

      const buck = buildHeatmap(store, { symbol: "BTCUSDT", bucket: 1 });
      expect(buck.bucket).toBe("1");
      expect(buck.prices).toEqual(["100", "101", "102"]);
      expect(buck.bid[0]?.[buck.prices.indexOf("100")]).toBe("3");
      expect(buck.ask[1]?.[buck.prices.indexOf("102")]).toBe("2");
      expect(bucketPrice("100.4", 1)).toBe("100");
    } finally {
      store.close();
    }
  });
});

describe("GET /chart /depth /heatmap", () => {
  test("returns the view schemas from the local cache", async () => {
    const { store, dbPath } = tempDb();
    store.saveKline("BTCUSDT", candle({ start: 15_000, interval: "15", volume: "4" }), 1);
    store.saveOrderbook(book("BTCUSDT", [["10", "2"]], [["11", "3"]]), 50, "snapshot", 9, 8, true);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);

    try {
      const chart = await (await fetch(`http://127.0.0.1:${server.port}/chart?symbol=BTCUSDT&interval=15`)).json() as {
        source: string;
        bars: Array<{ volume: string }>;
      };
      expect(chart.source).toBe("kline");
      expect(chart.bars[0]?.volume).toBe("4");

      const depth = await (await fetch(`http://127.0.0.1:${server.port}/depth?symbol=BTCUSDT`)).json() as {
        bestBid: string;
        bids: Array<{ cumSize: string }>;
      };
      expect(depth.bestBid).toBe("10");
      expect(depth.bids[0]?.cumSize).toBe("2");

      const heat = await (await fetch(`http://127.0.0.1:${server.port}/heatmap?symbol=BTCUSDT&bucket=1`)).json() as {
        snapshotCount: number;
        prices: string[];
      };
      expect(heat.snapshotCount).toBe(1);
      expect(heat.prices).toEqual(["10", "11"]);
    } finally {
      server.stop();
      store.close();
    }
  });
});
