import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_KLINE_LIMITS,
  buildBrief,
  type SnapshotBrief,
} from "../../../src/feed/bb/brief";
import {
  buildBriefPack,
  EMPTY_BRIEF_PACK_PAPER,
  EMPTY_BRIEF_PACK_TICKER,
  httpPaperSource,
  parseBriefPackArgs,
  readMapZones,
  sqlitePaperSource,
  type BriefPackArmedAlert,
  type BriefPackPendingOrder,
  type BriefPackPosition,
  type SnapshotBriefPack,
} from "../../../src/feed/bb/brief-pack";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";
import { paperArm, paperDesk } from "../../../src/paper/ops";
import { mockFeed, OPEN_LONG, paperEngine } from "../../paper/helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-brief-pack-"));
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
    retention: {
      tickerSnapshotsHours: 24,
      orderbookSnapshotsHours: 6,
      klinesDays: 14,
      pruneIntervalMs: 300_000,
    },
    recovery: { ...DEFAULT_RECOVERY },
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

function expectBriefPackShape(pack: SnapshotBriefPack, symbols = ["BTCUSDT", "ETHUSDT"]) {
  expect(pack.symbols).toEqual(symbols);
  expect(typeof pack.ts).toBe("number");
  expect(Array.isArray(pack.tickers)).toBe(true);
  expect(pack.tickers).toHaveLength(symbols.length);
  for (const ticker of pack.tickers) {
    expect(Object.keys(ticker)).toEqual([
      "symbol",
      "lastPrice",
      "price24hPcnt",
      "highPrice24h",
      "lowPrice24h",
      "volume24h",
      "turnover24h",
      "fundingRate",
      "nextFundingTime",
      "openInterest",
      "openInterestValue",
      "recvTs",
    ]);
  }
  expect(Array.isArray(pack.klineLag.rows)).toBe(true);
  expect(pack.paper).toEqual(expect.objectContaining({
    positions: expect.any(Array),
    pendingOrders: expect.any(Array),
    armedAlerts: expect.any(Array),
  }));
  expect(pack.zones).toEqual([]);
  expect(pack.meta.db).toEqual(expect.any(String));
}

function expectPositionShape(row: BriefPackPosition) {
  expect(Object.keys(row)).toEqual([
    "id", "symbol", "side", "entryPrice", "stopLoss", "takeProfit",
    "qty", "leverage", "riskPct", "status", "openedTs",
  ]);
}

function expectPendingOrderShape(row: BriefPackPendingOrder) {
  expect(Object.keys(row)).toEqual([
    "id", "symbol", "side", "type", "limitPrice", "qty",
    "stopLoss", "takeProfit", "status", "createdTs",
  ]);
}

function expectArmedAlertShape(row: BriefPackArmedAlert) {
  expect(Object.keys(row)).toEqual([
    "id", "symbol", "op", "price", "status", "createdTs",
  ]);
}

describe("parseBriefPackArgs / zones", () => {
  test("omits symbol by default and uppercases a positional", () => {
    expect(parseBriefPackArgs([])).toEqual({});
    expect(parseBriefPackArgs(["ethusdt"])).toEqual({ symbol: "ETHUSDT" });
  });

  test("zones store does not exist — always []", () => {
    expect(readMapZones()).toEqual([]);
  });

  test("paper.source labels are sqlite path or paper HTTP URL", () => {
    expect(sqlitePaperSource("./data/paper.sqlite")).toBe("sqlite:./data/paper.sqlite");
    expect(sqlitePaperSource("sqlite:/tmp/paper.sqlite")).toBe("sqlite:/tmp/paper.sqlite");
    expect(httpPaperSource("http://127.0.0.1:43181/")).toBe("http://127.0.0.1:43181");
    expect(httpPaperSource(undefined)).toBe("http://127.0.0.1:43181");
  });
});

describe("buildBriefPack shape + missing data", () => {
  test("empty database returns null tickers, empty paper/zones, and kline lag rows", () => {
    const { store, dbPath } = tempDb();
    try {
      const pack = buildBriefPack(store, { config: feedConfig(dbPath), now: 9_000 });
      expectBriefPackShape(pack);
      expect(pack.tickers).toEqual([
        { symbol: "BTCUSDT", ...EMPTY_BRIEF_PACK_TICKER },
        { symbol: "ETHUSDT", ...EMPTY_BRIEF_PACK_TICKER },
      ]);
      expect(pack.paper).toEqual(EMPTY_BRIEF_PACK_PAPER);
      expect(pack.zones).toEqual([]);
      expect(pack.klineLag.rows).toHaveLength(6);
      expect(pack.klineLag.rows.every((row) => row.startTs == null && row.klineLagMs == null)).toBe(true);
      expect(pack.meta.klinesDays).toBe(14);
      expect(pack.meta.paperSource).toBeNull();
    } finally {
      store.close();
    }
  });

  test("unknown symbol and throwing store still return the shape", () => {
    const { store, dbPath } = tempDb();
    try {
      const missing = buildBriefPack(store, {
        config: feedConfig(dbPath),
        symbol: "NOPEUSDT",
        now: 1,
      });
      expectBriefPackShape(missing, ["NOPEUSDT"]);
      expect(missing.tickers[0]).toEqual({ symbol: "NOPEUSDT", ...EMPTY_BRIEF_PACK_TICKER });
      expect(missing.paper.positions).toEqual([]);
    } finally {
      store.close();
    }

    const broken = {
      listTickers() {
        throw new Error("ticker_latest missing");
      },
      latestKlines() {
        throw new Error("klines missing");
      },
    };
    const pack = buildBriefPack(broken, { config: { dbPath: "/tmp/gone.sqlite", symbols: ["BTCUSDT"] }, now: 2 });
    expectBriefPackShape(pack, ["BTCUSDT"]);
    expect(pack.tickers[0]?.lastPrice).toBeNull();
    expect(pack.klineLag.rows).toHaveLength(3);
    expect(pack.klineLag.rows.every((row) => row.startTs == null && row.klineLagMs == null)).toBe(true);
    expect(pack.zones).toEqual([]);
  });

  test("maps ticker 24h%/funding/OI and reuses kline lag", () => {
    const { store, dbPath } = tempDb();
    try {
      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: {
          lastPrice: "100",
          price24hPcnt: "0.012",
          highPrice24h: "110",
          lowPrice24h: "90",
          volume24h: "3",
          turnover24h: "4",
          fundingRate: "0.0001",
          nextFundingTime: "1700000000000",
          openInterest: "1",
          openInterestValue: "2",
        },
      }, 1234, false);
      store.saveKline("BTCUSDT", candle({ start: 1_800_000, interval: "15", confirm: false }), 1_999_600);

      const pack = buildBriefPack(store, { config: feedConfig(dbPath), symbol: "btcusdt", now: 2_000_000 });
      expectBriefPackShape(pack, ["BTCUSDT"]);
      expect(pack.tickers[0]).toEqual({
        symbol: "BTCUSDT",
        lastPrice: "100",
        price24hPcnt: "0.012",
        highPrice24h: "110",
        lowPrice24h: "90",
        volume24h: "3",
        turnover24h: "4",
        fundingRate: "0.0001",
        nextFundingTime: "1700000000000",
        openInterest: "1",
        openInterestValue: "2",
        recvTs: 1234,
      });
      const row15 = pack.klineLag.rows.find((row) => row.interval === "15");
      expect(row15?.startTs).toBe(1_800_000);
      expect(row15?.klineLagMs).toBe(400);
      expect(row15?.formingStuck).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("GET /brief-pack + GET /brief stay additive", () => {
  test("returns the pack schema and leaves /brief unchanged", async () => {
    const { store, dbPath } = tempDb();
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "50", price24hPcnt: "-0.01" },
    }, 99, false);

    const server = startHttp(feedConfig(dbPath), store);
    try {
      const packRes = await fetch(`http://127.0.0.1:${server.port}/brief-pack?symbol=BTCUSDT`);
      expect(packRes.status).toBe(200);
      const pack = await packRes.json() as SnapshotBriefPack;
      expectBriefPackShape(pack, ["BTCUSDT"]);
      expect(pack.tickers[0]?.lastPrice).toBe("50");
      expect(pack.tickers[0]?.price24hPcnt).toBe("-0.01");
      expect(pack.paper).toEqual(EMPTY_BRIEF_PACK_PAPER);
      expect(pack.zones).toEqual([]);

      const briefRes = await fetch(`http://127.0.0.1:${server.port}/brief?symbol=BTCUSDT`);
      const brief = await briefRes.json() as SnapshotBrief;
      const expected = buildBrief(store, { symbol: "BTCUSDT", dbPath, now: 0 });
      expect(brief.ticker.lastPrice).toBe(expected.ticker.lastPrice);
      expect(brief.klines).toEqual(expected.klines);
      expect(brief.meta.limits).toEqual({ ...BRIEF_KLINE_LIMITS });

      const mapRes = await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`);
      expect(mapRes.status).toBe(200);
      const map = await mapRes.json() as { klines: Record<string, unknown[]> };
      expect(map.klines).toHaveProperty("240");
      expect(map.klines).toHaveProperty("60");
      expect(map.klines).toHaveProperty("D");
      expect("15" in map.klines).toBe(false);

      const confirmRes = await fetch(`http://127.0.0.1:${server.port}/confirm?symbol=BTCUSDT&interval=15`);
      expect(confirmRes.status).toBe(200);
      const confirm = await confirmRes.json() as { interval: string; klines: unknown[] };
      expect(confirm.interval).toBe("15");
      expect(Array.isArray(confirm.klines)).toBe(true);
    } finally {
      server.stop();
      store.close();
    }
  });

  test("injects in-process paper desk (positions / pending / alerts)", async () => {
    const { store, dbPath } = tempDb();
    const ctx = await paperEngine(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    dirs.push(ctx.dir);
    await paperArm(ctx.engine, { ...OPEN_LONG, limitPrice: "62000" });

    const server = startHttp(feedConfig(dbPath), store, {
      paperDesk: () => paperDesk(ctx.engine, sqlitePaperSource(ctx.config.dbPath)),
    });
    try {
      const pack = await (await fetch(`http://127.0.0.1:${server.port}/brief-pack`)).json() as SnapshotBriefPack;
      expect(pack.paper.source).toBe(sqlitePaperSource(ctx.config.dbPath));
      expect(pack.paper.source?.startsWith("sqlite:")).toBe(true);
      expect(pack.paper.pendingOrders).toHaveLength(1);
      expect(pack.paper.armedAlerts).toHaveLength(1);
      expect(pack.paper.positions).toEqual([]);
      expectPendingOrderShape(pack.paper.pendingOrders[0]!);
      expectArmedAlertShape(pack.paper.armedAlerts[0]!);
      expect(pack.paper.pendingOrders[0]).toEqual(expect.objectContaining({
        symbol: "BTCUSDT",
        side: "long",
        type: "limit",
        limitPrice: "62000",
        stopLoss: "60000",
        takeProfit: "66000",
        status: "pending",
      }));
      expect(pack.paper.armedAlerts[0]).toEqual(expect.objectContaining({
        symbol: "BTCUSDT",
        op: "below",
        price: "62000",
        status: "armed",
      }));
      expect(pack.paper.pendingOrders[0]?.id).toEqual(expect.any(Number));
      expect(pack.paper.pendingOrders[0]?.qty).toEqual(expect.any(String));
      expect(pack.paper.pendingOrders[0]?.createdTs).toEqual(expect.any(Number));
      expect(pack.paper.armedAlerts[0]?.createdTs).toEqual(expect.any(Number));
      expect(pack.meta.paperSource).toBe(pack.paper.source);
      expect(pack.zones).toEqual([]);
    } finally {
      server.stop();
      store.close();
      ctx.store.close();
    }
  });

  test("projects open position fields and http://127.0.0.1:43181 source", async () => {
    const { store, dbPath } = tempDb();
    const ctx = await paperEngine(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    dirs.push(ctx.dir);
    const opened = await ctx.engine.open(OPEN_LONG);
    const source = httpPaperSource("http://127.0.0.1:43181");
    const pack = buildBriefPack(store, {
      config: feedConfig(dbPath),
      paper: paperDesk(ctx.engine, source),
      now: 1,
    });
    expect(pack.paper.source).toBe("http://127.0.0.1:43181");
    expect(pack.paper.positions).toHaveLength(1);
    expectPositionShape(pack.paper.positions[0]!);
    expect(pack.paper.positions[0]).toEqual(expect.objectContaining({
      id: opened.position.id,
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: opened.position.entryPrice,
      stopLoss: opened.position.stopLoss,
      takeProfit: opened.position.takeProfit,
      qty: opened.position.qty,
      leverage: opened.position.leverage,
      riskPct: opened.position.riskPct,
      status: "open",
      openedTs: opened.position.openedTs,
    }));
    expect(pack.paper.positions[0]).not.toHaveProperty("unrealizedPnl");
    expect(pack.paper.pendingOrders).toEqual([]);
    ctx.store.close();
    store.close();
  });

  test("missing paper row fields become null and extra engine keys are dropped", () => {
    const { store, dbPath } = tempDb();
    try {
      const pack = buildBriefPack(store, {
        config: feedConfig(dbPath),
        now: 1,
        paper: {
          source: "",
          positions: [{ extra: true }],
          pendingOrders: [{ extra: true }],
          armedAlerts: [{ extra: true }],
        } as never,
      });
      expect(pack.paper.source).toBeNull();
      expectPositionShape(pack.paper.positions[0]!);
      expectPendingOrderShape(pack.paper.pendingOrders[0]!);
      expectArmedAlertShape(pack.paper.armedAlerts[0]!);
      expect(pack.paper.positions[0]).toEqual({
        id: null, symbol: null, side: null, entryPrice: null, stopLoss: null, takeProfit: null,
        qty: null, leverage: null, riskPct: null, status: null, openedTs: null,
      });
    } finally {
      store.close();
    }
  });

  test("missing paper desk stays [] and throwing desk does not 500", async () => {
    const { store, dbPath } = tempDb();
    const server = startHttp(feedConfig(dbPath), store, {
      paperDesk: () => {
        throw new Error("paper sqlite locked");
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/brief-pack`);
      expect(res.status).toBe(200);
      const pack = await res.json() as SnapshotBriefPack;
      expect(pack.paper).toEqual(EMPTY_BRIEF_PACK_PAPER);
    } finally {
      server.stop();
      store.close();
    }
  });
});
