import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_KLINE_LIMITS,
  EMPTY_TICKER,
  buildBrief,
  emptyBrief,
  normalizeBriefSymbol,
  parseBriefArgs,
  type BriefKline,
  type SnapshotBrief,
} from "../../../src/feed/bb/brief";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-brief-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dir, dbPath, store: openDb(dbPath) };
}

function expectBriefShape(brief: SnapshotBrief, symbol = "BTCUSDT") {
  expect(brief.symbol).toBe(symbol);
  expect(typeof brief.ts).toBe("number");
  expect(Object.keys(brief.ticker)).toEqual([
    "lastPrice",
    "markPrice",
    "bid1Price",
    "ask1Price",
    "fundingRate",
    "nextFundingTime",
    "openInterest",
    "openInterestValue",
    "recvTs",
  ]);
  expect(Object.keys(brief.klines)).toEqual(["15", "60", "240"]);
  expect(Array.isArray(brief.klines["15"])).toBe(true);
  expect(Array.isArray(brief.klines["60"])).toBe(true);
  expect(Array.isArray(brief.klines["240"])).toBe(true);
  expect(brief.meta.limits).toEqual({ ...BRIEF_KLINE_LIMITS });
  expect(typeof brief.meta.db).toBe("string");
}

function expectKlineShape(row: BriefKline) {
  expect(Object.keys(row)).toEqual([
    "start_ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "turnover",
    "confirm",
  ]);
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

describe("parseBriefArgs / normalizeBriefSymbol", () => {
  test("defaults to BTCUSDT and uppercases a positional symbol", () => {
    expect(parseBriefArgs([])).toEqual({ symbol: "BTCUSDT" });
    expect(parseBriefArgs(["ethusdt"])).toEqual({ symbol: "ETHUSDT" });
    expect(normalizeBriefSymbol("  solusdt  ")).toBe("SOLUSDT");
    expect(normalizeBriefSymbol("")).toBe("BTCUSDT");
    expect(normalizeBriefSymbol(null)).toBe("BTCUSDT");
  });
});

describe("buildBrief shape + missing data", () => {
  test("empty database returns the stable shape with nulls and empty arrays", () => {
    const { store, dbPath } = tempDb();
    try {
      const brief = buildBrief(store, { dbPath, now: 9_000 });
      expectBriefShape(brief);
      expect(brief).toEqual(emptyBrief("BTCUSDT", dbPath, 9_000));
      expect(brief.ticker).toEqual(EMPTY_TICKER);
      expect(brief.klines).toEqual({ "15": [], "60": [], "240": [] });
      expect(brief.ts).toBe(9_000);
    } finally {
      store.close();
    }
  });

  test("unknown symbol and throwing store still return the shape", () => {
    const { store, dbPath } = tempDb();
    try {
      const missing = buildBrief(store, { symbol: "NOPEUSDT", dbPath, now: 1 });
      expectBriefShape(missing, "NOPEUSDT");
      expect(missing.ticker).toEqual(EMPTY_TICKER);
      expect(missing.klines["15"]).toEqual([]);
    } finally {
      store.close();
    }

    const broken = {
      listTickers() {
        throw new Error("ticker_latest missing");
      },
      listKlines() {
        throw new Error("klines missing");
      },
    };
    const brief = buildBrief(broken, { symbol: "BTCUSDT", dbPath: "/tmp/gone.sqlite", now: 2 });
    expectBriefShape(brief);
    expect(brief.ticker).toEqual(EMPTY_TICKER);
    expect(brief.klines).toEqual({ "15": [], "60": [], "240": [] });
  });

  test("maps a ticker and oldest-first klines, keeping only the limit window", () => {
    const { store, dbPath } = tempDb();
    try {
      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: {
          lastPrice: "100",
          markPrice: "101",
          bid1Price: "99",
          ask1Price: "102",
          fundingRate: "0.0001",
          nextFundingTime: "1700000000000",
          openInterest: "1",
          openInterestValue: "2",
        },
      }, 1234, false);

      for (let i = 0; i < 81; i++) {
        store.saveKline("BTCUSDT", candle({ start: i * 15 * 60_000, interval: "15", confirm: i % 2 === 0 }), 1234);
      }
      store.saveKline("BTCUSDT", candle({ start: 60_000, interval: "60", open: "9", confirm: false }), 1234);
      store.saveKline("BTCUSDT", candle({ start: 240_000, interval: "240", close: "8" }), 1234);
      store.saveKline("ETHUSDT", candle({ start: 15_000, interval: "15" }), 1234);

      const brief = buildBrief(store, { symbol: "btcusdt", dbPath, now: 42 });
      expectBriefShape(brief);
      expect(brief.ticker).toEqual({
        lastPrice: "100",
        markPrice: "101",
        bid1Price: "99",
        ask1Price: "102",
        fundingRate: "0.0001",
        nextFundingTime: "1700000000000",
        openInterest: "1",
        openInterestValue: "2",
        recvTs: 1234,
      });
      expect(brief.klines["15"]).toHaveLength(80);
      expectKlineShape(brief.klines["15"][0]!);
      expect(brief.klines["15"][0]?.start_ts).toBe(15 * 60_000);
      expect(brief.klines["15"].at(-1)?.start_ts).toBe(80 * 15 * 60_000);
      expect(brief.klines["15"].at(-1)?.confirm).toBe(true);
      expect(brief.klines["15"][0]?.confirm).toBe(false);
      expect(brief.klines["60"]).toEqual([
        expect.objectContaining({ start_ts: 60_000, open: "9", confirm: false }),
      ]);
      expect(brief.klines["240"]).toEqual([
        expect.objectContaining({ start_ts: 240_000, close: "8", confirm: true }),
      ]);
      expect(brief.ts).toBe(42);
      expect(brief.meta.db).toBe(dbPath);
    } finally {
      store.close();
    }
  });
});

describe("GET /brief", () => {
  test("returns the same schema as buildBrief", async () => {
    const { store, dbPath } = tempDb();
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "50", markPrice: "51" },
    }, 99, false);
    store.saveKline("BTCUSDT", candle({ start: 1_000, interval: "15" }), 99);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);

    try {
      const expected = buildBrief(store, { symbol: "BTCUSDT", dbPath, now: 0 });
      const res = await fetch(`http://127.0.0.1:${server.port}/brief?symbol=BTCUSDT`);
      expect(res.status).toBe(200);
      const body = await res.json() as SnapshotBrief;
      expectBriefShape(body);
      expect(body.ticker).toEqual(expected.ticker);
      expect(body.klines).toEqual(expected.klines);
      expect(body.meta).toEqual(expected.meta);

      const def = await fetch(`http://127.0.0.1:${server.port}/brief`);
      const defBody = await def.json() as SnapshotBrief;
      expect(defBody.symbol).toBe("BTCUSDT");
    } finally {
      server.stop();
      store.close();
    }
  });
});
