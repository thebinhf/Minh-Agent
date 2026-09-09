import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_TICKER } from "../../../src/feed/bb/brief";
import {
  CONFIRM_KLINE_LIMIT,
  buildConfirm,
  emptyConfirm,
  parseConfirmArgs,
  parseConfirmInterval,
  type ConfirmInterval,
  type SnapshotConfirm,
} from "../../../src/feed/bb/confirm";
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
  const dir = mkdtempSync(join(tmpdir(), "minh-confirm-"));
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

function expectConfirmShape(body: SnapshotConfirm, interval: ConfirmInterval = "15") {
  expect(body.interval).toBe(interval);
  expect(Array.isArray(body.klines)).toBe(true);
  expect(body.meta.limit).toBe(CONFIRM_KLINE_LIMIT);
  expect(body.meta.note).toBe("ltf confirm — agent reads PA; no S/D");
  expect("240" in body).toBe(false);
}

describe("parseConfirmArgs / buildConfirm", () => {
  test("defaults to BTCUSDT 15m; scalp is 5", () => {
    expect(parseConfirmInterval(null)).toBe("15");
    expect(parseConfirmInterval("5")).toBe("5");
    expect(parseConfirmInterval("60")).toBeNull();
    expect(parseConfirmArgs([])).toEqual({ symbol: "BTCUSDT", interval: "15" });
    expect(parseConfirmArgs(["ethusdt", "--interval", "5"])).toEqual({ symbol: "ETHUSDT", interval: "5" });
  });

  test("empty database has ticker nulls and no HTF keys", () => {
    const { store, dbPath } = tempDb();
    try {
      const body = buildConfirm(store, { dbPath, now: 4 });
      expectConfirmShape(body);
      expect(body).toEqual(emptyConfirm("BTCUSDT", dbPath, 4));
      expect(body.ticker).toEqual(EMPTY_TICKER);
    } finally {
      store.close();
    }
  });

  test("keeps 20×15m and ignores 4H", () => {
    const { store, dbPath } = tempDb();
    try {
      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: { lastPrice: "100" },
      }, 9, false);
      for (let i = 0; i < 25; i++) {
        store.saveKline("BTCUSDT", candle({ start: i * 15 * 60_000, interval: "15" }), 9);
      }
      store.saveKline("BTCUSDT", candle({ start: 1, interval: "240" }), 9);
      store.saveKline("BTCUSDT", candle({ start: 2, interval: "5", close: "99" }), 9);

      const body = buildConfirm(store, { dbPath, now: 1 });
      expectConfirmShape(body);
      expect(body.ticker.lastPrice).toBe("100");
      expect(body.klines).toHaveLength(20);
      expect(body.klines[0]?.start_ts).toBe(5 * 15 * 60_000);
      expect(body.klines.at(-1)?.start_ts).toBe(24 * 15 * 60_000);

      const scalp = buildConfirm(store, { dbPath, interval: "5" });
      expect(scalp.klines).toEqual([
        expect.objectContaining({ start_ts: 2, close: "99" }),
      ]);
    } finally {
      store.close();
    }
  });
});

describe("GET /confirm", () => {
  test("matches buildConfirm; 60 is 400; /map unchanged", async () => {
    const { store, dbPath } = tempDb();
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "50" },
    }, 3, false);
    store.saveKline("BTCUSDT", candle({ start: 1_000, interval: "15" }), 3);
    store.saveKline("BTCUSDT", candle({ start: 2_000, interval: "240" }), 3);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);

    try {
      const expected = buildConfirm(store, { dbPath, now: 0 });
      const res = await fetch(`http://127.0.0.1:${server.port}/confirm?symbol=BTCUSDT`);
      expect(res.status).toBe(200);
      const body = await res.json() as SnapshotConfirm;
      expectConfirmShape(body);
      expect(body.ticker).toEqual(expected.ticker);
      expect(body.klines).toEqual(expected.klines);

      const bad = await fetch(`http://127.0.0.1:${server.port}/confirm?interval=60`);
      expect(bad.status).toBe(400);

      const map = await (await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`)).json() as {
        klines: Record<string, unknown[]>;
      };
      expect(map.klines["240"]).toHaveLength(1);
      expect("15" in map.klines).toBe(false);
    } finally {
      server.stop();
      store.close();
    }
  });
});
