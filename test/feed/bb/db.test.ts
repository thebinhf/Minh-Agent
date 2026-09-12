import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, reclaimSqlite, snapshotDue, SQLITE_CACHE_KIB, SQLITE_WAL_AUTOCHECKPOINT } from "../../../src/feed/bb/db";
import { reclaimWal } from "../../../src/sqlite";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-db-"));
  dirs.push(dir);
  return { dir, dbPath: join(dir, "market.sqlite"), store: openDb(join(dir, "market.sqlite")) };
}

describe("sqlite storage", () => {
  test("reclaimWal skips TRUNCATE when PASSIVE is busy", () => {
    const busyDb = {
      prepare(sql: string) {
        expect(sql).toBe("PRAGMA wal_checkpoint(PASSIVE)");
        return { get: () => ({ busy: 1, log: 40, checkpointed: 0 }) };
      },
      exec(sql: string) {
        expect(sql).toBe("PRAGMA shrink_memory;");
      },
    };
    const got = reclaimWal(busyDb as never);
    expect(got.truncated).toBe(false);
    expect(got.truncate).toBeNull();
    expect(got.passive.busy).toBe(1);
  });

  test("snapshotDue: 0 disables; interval fires once then waits", () => {
    expect(snapshotDue(0, undefined, 1000)).toBe(false);
    expect(snapshotDue(-1, undefined, 1000)).toBe(false);
    expect(snapshotDue(5000, undefined, 1000)).toBe(true);
    expect(snapshotDue(5000, 1000, 5999)).toBe(false);
    expect(snapshotDue(5000, 1000, 6000)).toBe(true);
  });

  test("caps page cache, disables mmap, and limits WAL", () => {
    const { store } = tempDb();
    const cache = store.raw.prepare("PRAGMA cache_size").get() as Record<string, number>;
    const mmap = store.raw.prepare("PRAGMA mmap_size").get() as Record<string, number>;
    const wal = store.raw.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>;
    const cacheVal = Number(cache.cache_size ?? Object.values(cache)[0]);
    const mmapVal = Number(mmap.mmap_size ?? Object.values(mmap)[0]);
    const walVal = Number(wal.wal_autocheckpoint ?? Object.values(wal)[0]);
    expect(cacheVal).toBe(-SQLITE_CACHE_KIB);
    expect(mmapVal).toBe(0);
    expect(walVal).toBe(SQLITE_WAL_AUTOCHECKPOINT);
    store.close();
  });

  test("drops the redundant klines DESC index (PK already covers lookup)", () => {
    const { dbPath } = tempDb();
    const raw = new Database(dbPath, { readonly: true });
    const indexes = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='klines'",
    ).all() as Array<{ name: string }>;
    raw.close();
    expect(indexes.some((row) => row.name === "idx_klines_lookup")).toBe(false);
  });

  test("prune deletes expired snapshots and vacuums when the freelist is large", () => {
    const { store, dbPath } = tempDb();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 80; i++) {
      store.saveTicker({
        symbol: "BTCUSDT",
        fields: { lastPrice: String(60_000 + i), markPrice: String(60_000 + i) },
        type: "snapshot",
      }, now - 48 * 3600_000 + i, true);
      store.saveKline("BTCUSDT", {
        start: now - 30 * 86400_000 + i * 60_000,
        end: now - 30 * 86400_000 + (i + 1) * 60_000,
        interval: "15",
        open: "1",
        high: "1",
        low: "1",
        close: "1",
        volume: "1",
        turnover: "1",
        confirm: true,
        timestamp: now,
      }, now);
    }
    const result = store.prune(now, {
      tickerSnapshotsHours: 24,
      orderbookSnapshotsHours: 6,
      klinesDays: 14,
      vacuumMinIntervalMs: 0,
    });
    expect(result.tickerDeleted).toBe(80);
    expect(result.klineDeleted).toBe(80);
    expect(result.oiDeleted).toBe(0);
    expect(result.fundingDeleted).toBe(0);
    expect(result.liqDeleted).toBe(0);
    expect(result.flowDeleted).toBe(0);
    expect(result.pageCount).toBeGreaterThan(0);

    const raw = new Database(dbPath);
    const leftover = raw.prepare("SELECT COUNT(*) AS n FROM ticker_snapshots").get() as { n: number };
    const oldKlines = raw.prepare("SELECT COUNT(*) AS n FROM klines").get() as { n: number };
    raw.close();
    expect(leftover.n).toBe(0);
    expect(oldKlines.n).toBe(0);
  });

  test("reclaimSqlite truncates WAL without requiring a vacuum", () => {
    const { dbPath } = tempDb();
    const raw = new Database(dbPath);
    raw.exec("PRAGMA journal_mode = WAL;");
    const result = reclaimSqlite(raw, Date.now(), 3_600_000);
    raw.close();
    expect(result.vacuumed).toBe(false);
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.walBusy).toBe(0);
    expect(result.walTruncated).toBe(true);
  });

  test("latestKlines returns the newest start_ts per symbol/interval", () => {
    const { store } = tempDb();
    try {
      store.saveKline("BTCUSDT", {
        start: 1_000,
        end: 2_000,
        interval: "15",
        open: "1",
        high: "1",
        low: "1",
        close: "1",
        volume: "1",
        turnover: "1",
        confirm: true,
        timestamp: 1,
      }, 10);
      store.saveKline("BTCUSDT", {
        start: 2_000,
        end: 3_000,
        interval: "15",
        open: "2",
        high: "2",
        low: "2",
        close: "2",
        volume: "1",
        turnover: "1",
        confirm: false,
        timestamp: 2,
      }, 20);
      store.saveKline("ETHUSDT", {
        start: 5_000,
        end: 6_000,
        interval: "60",
        open: "3",
        high: "3",
        low: "3",
        close: "3",
        volume: "1",
        turnover: "1",
        confirm: true,
        timestamp: 3,
      }, 30);
      const all = store.latestKlines(["15", "60"]);
      expect(all).toEqual([
        expect.objectContaining({ symbol: "BTCUSDT", interval: "15", start_ts: 2_000, confirm: 0, recv_ts: 20 }),
        expect.objectContaining({ symbol: "ETHUSDT", interval: "60", start_ts: 5_000, confirm: 1, recv_ts: 30 }),
      ]);
      const btc = store.latestKlines(["15", "60"], "BTCUSDT");
      expect(btc).toHaveLength(1);
      expect(btc[0]?.start_ts).toBe(2_000);
      expect(store.latestKlines([])).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("latestConfirmedKlines sees the bar latestKlines hides behind a forming one", () => {
    const { store } = tempDb();
    const kline = (start: number, confirm: boolean) => ({
      start,
      end: start + 1_000,
      interval: "60",
      open: "1",
      high: "1",
      low: "1",
      close: "1",
      volume: "1",
      turnover: "1",
      confirm,
      timestamp: start,
    });
    try {
      // BTC closes 1_000 and Bybit opens the next candle in the same push.
      store.saveKline("BTCUSDT", kline(1_000, true), 10);
      store.saveKline("BTCUSDT", kline(2_000, false), 20);
      store.saveKline("ETHUSDT", kline(1_000, true), 30);
      // SOL has only ever been fed a forming bar — nothing to confirm yet.
      store.saveKline("SOLUSDT", kline(2_000, false), 40);

      const newest = store.latestKlines(["60"]);
      expect(newest).toEqual([
        expect.objectContaining({ symbol: "BTCUSDT", start_ts: 2_000, confirm: 0 }),
        expect.objectContaining({ symbol: "ETHUSDT", start_ts: 1_000, confirm: 1 }),
        expect.objectContaining({ symbol: "SOLUSDT", start_ts: 2_000, confirm: 0 }),
      ]);

      const confirmed = store.latestConfirmedKlines(["60"]);
      expect(confirmed).toEqual([
        expect.objectContaining({ symbol: "BTCUSDT", interval: "60", start_ts: 1_000, confirm: 1, recv_ts: 10 }),
        expect.objectContaining({ symbol: "ETHUSDT", interval: "60", start_ts: 1_000, confirm: 1, recv_ts: 30 }),
      ]);
      expect(store.latestConfirmedKlines(["60"], "BTCUSDT")).toHaveLength(1);
      expect(store.latestConfirmedKlines([])).toEqual([]);
    } finally {
      store.close();
    }
  });
});
