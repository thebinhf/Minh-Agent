import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { BybitKline, OrderBookState, TickerState } from "./types";
import { serializeBook } from "./merge";

export const SCHEMA_VERSION = "2";

export type TrackerDb = ReturnType<typeof openDb>;

export function openDb(dbPath: string, readonly = false) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, readonly ? { readonly: true } : { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    migrate(db);
  }
  return wrap(db);
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_latest (
      symbol TEXT PRIMARY KEY,
      last_price TEXT,
      mark_price TEXT,
      index_price TEXT,
      bid1_price TEXT,
      bid1_size TEXT,
      ask1_price TEXT,
      ask1_size TEXT,
      volume_24h TEXT,
      turnover_24h TEXT,
      price_24h_pcnt TEXT,
      high_price_24h TEXT,
      low_price_24h TEXT,
      funding_rate TEXT,
      next_funding_time TEXT,
      open_interest TEXT,
      open_interest_value TEXT,
      payload_json TEXT NOT NULL,
      recv_ts INTEGER NOT NULL,
      exch_ts INTEGER,
      cs INTEGER,
      type TEXT
    );

    CREATE TABLE IF NOT EXISTS ticker_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recv_ts INTEGER NOT NULL,
      exch_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ticker_snapshots_symbol_ts
      ON ticker_snapshots(symbol, recv_ts);

    CREATE TABLE IF NOT EXISTS orderbook_latest (
      symbol TEXT PRIMARY KEY,
      depth INTEGER NOT NULL,
      bids_json TEXT NOT NULL,
      asks_json TEXT NOT NULL,
      update_id INTEGER,
      seq INTEGER,
      recv_ts INTEGER NOT NULL,
      exch_ts INTEGER,
      type TEXT
    );

    CREATE TABLE IF NOT EXISTS orderbook_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      depth INTEGER NOT NULL,
      type TEXT NOT NULL,
      bids_json TEXT NOT NULL,
      asks_json TEXT NOT NULL,
      update_id INTEGER,
      seq INTEGER,
      recv_ts INTEGER NOT NULL,
      exch_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ob_snapshots_symbol_ts
      ON orderbook_snapshots(symbol, recv_ts);

    CREATE TABLE IF NOT EXISTS klines (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER,
      open TEXT,
      high TEXT,
      low TEXT,
      close TEXT,
      volume TEXT,
      turnover TEXT,
      confirm INTEGER NOT NULL DEFAULT 0,
      candle_ts INTEGER,
      recv_ts INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval, start_ts)
    );

    CREATE TABLE IF NOT EXISTS connection_health (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      connected INTEGER NOT NULL DEFAULT 0,
      endpoint TEXT,
      subscribed_topics INTEGER,
      last_message_ts INTEGER,
      last_pong_ts INTEGER,
      last_ping_ts INTEGER,
      connect_ts INTEGER,
      disconnect_ts INTEGER,
      reconnect_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO connection_health (id, connected, reconnect_count)
    VALUES (1, 0, 0);
  `);

  db.exec("DROP INDEX IF EXISTS idx_klines_lookup;");
  setMeta(db, "schema_version", SCHEMA_VERSION);
}

function setMeta(db: Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO meta (key, value, updated_ts) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts`,
  ).run(key, value, Date.now());
}

function pragmaNum(db: Database, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  if (!row) return 0;
  return Number(row[name] ?? Object.values(row)[0]) || 0;
}

/** 0 disables history snapshots. Latest ticker/book rows still upsert. */
export function snapshotDue(everyMs: number, lastTs: number | undefined, now: number): boolean {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return false;
  return lastTs == null || now - lastTs >= everyMs;
}

export type ReclaimResult = {
  pageCount: number;
  freelistCount: number;
  vacuumed: boolean;
};

/** Truncate WAL. VACUUM only when free pages are a real fraction of the file. */
export function reclaimSqlite(
  db: Database,
  now = Date.now(),
  vacuumMinIntervalMs = 3_600_000,
): ReclaimResult {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const pageCount = pragmaNum(db, "page_count");
  const freelistCount = pragmaNum(db, "freelist_count");
  const lastVacuum = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'last_vacuum_ts'").get() as { value: string } | undefined)?.value ?? 0,
  );
  const ratio = pageCount > 0 ? freelistCount / pageCount : 0;
  let vacuumed = false;
  if (ratio >= 0.15 && now - lastVacuum >= vacuumMinIntervalMs) {
    db.exec("VACUUM;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    setMeta(db, "last_vacuum_ts", String(now));
    vacuumed = true;
  }
  return { pageCount, freelistCount, vacuumed };
}

function wrap(db: Database) {
  const upsertTicker = db.prepare(`
    INSERT INTO ticker_latest (
      symbol, last_price, mark_price, index_price, bid1_price, bid1_size,
      ask1_price, ask1_size, volume_24h, turnover_24h, price_24h_pcnt,
      high_price_24h, low_price_24h, funding_rate, next_funding_time,
      open_interest, open_interest_value, payload_json, recv_ts, exch_ts, cs, type
    ) VALUES (
      $symbol, $last_price, $mark_price, $index_price, $bid1_price, $bid1_size,
      $ask1_price, $ask1_size, $volume_24h, $turnover_24h, $price_24h_pcnt,
      $high_price_24h, $low_price_24h, $funding_rate, $next_funding_time,
      $open_interest, $open_interest_value, $payload_json, $recv_ts, $exch_ts, $cs, $type
    )
    ON CONFLICT(symbol) DO UPDATE SET
      last_price = excluded.last_price,
      mark_price = excluded.mark_price,
      index_price = excluded.index_price,
      bid1_price = excluded.bid1_price,
      bid1_size = excluded.bid1_size,
      ask1_price = excluded.ask1_price,
      ask1_size = excluded.ask1_size,
      volume_24h = excluded.volume_24h,
      turnover_24h = excluded.turnover_24h,
      price_24h_pcnt = excluded.price_24h_pcnt,
      high_price_24h = excluded.high_price_24h,
      low_price_24h = excluded.low_price_24h,
      funding_rate = excluded.funding_rate,
      next_funding_time = excluded.next_funding_time,
      open_interest = excluded.open_interest,
      open_interest_value = excluded.open_interest_value,
      payload_json = excluded.payload_json,
      recv_ts = excluded.recv_ts,
      exch_ts = excluded.exch_ts,
      cs = excluded.cs,
      type = excluded.type
  `);

  const insertTickerSnap = db.prepare(`
    INSERT INTO ticker_snapshots (symbol, type, payload_json, recv_ts, exch_ts)
    VALUES (?, ?, ?, ?, ?)
  `);

  const upsertBook = db.prepare(`
    INSERT INTO orderbook_latest (
      symbol, depth, bids_json, asks_json, update_id, seq, recv_ts, exch_ts, type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      depth = excluded.depth,
      bids_json = excluded.bids_json,
      asks_json = excluded.asks_json,
      update_id = excluded.update_id,
      seq = excluded.seq,
      recv_ts = excluded.recv_ts,
      exch_ts = excluded.exch_ts,
      type = excluded.type
  `);

  const insertBookSnap = db.prepare(`
    INSERT INTO orderbook_snapshots (
      symbol, depth, type, bids_json, asks_json, update_id, seq, recv_ts, exch_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertKline = db.prepare(`
    INSERT INTO klines (
      symbol, interval, start_ts, end_ts, open, high, low, close, volume,
      turnover, confirm, candle_ts, recv_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, interval, start_ts) DO UPDATE SET
      end_ts = excluded.end_ts,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      turnover = excluded.turnover,
      confirm = excluded.confirm,
      candle_ts = excluded.candle_ts,
      recv_ts = excluded.recv_ts
  `);

  const touchHealth = db.prepare(`
    UPDATE connection_health SET
      connected = COALESCE($connected, connected),
      endpoint = COALESCE($endpoint, endpoint),
      subscribed_topics = COALESCE($subscribed_topics, subscribed_topics),
      last_message_ts = COALESCE($last_message_ts, last_message_ts),
      last_pong_ts = COALESCE($last_pong_ts, last_pong_ts),
      last_ping_ts = COALESCE($last_ping_ts, last_ping_ts),
      connect_ts = COALESCE($connect_ts, connect_ts),
      disconnect_ts = COALESCE($disconnect_ts, disconnect_ts),
      reconnect_count = COALESCE($reconnect_count, reconnect_count),
      last_error = COALESCE($last_error, last_error)
    WHERE id = 1
  `);

  return {
    raw: db,
    close() {
      db.close();
    },
    saveTicker(state: TickerState, recvTs: number, snapshot: boolean) {
      const f = state.fields;
      const payload = JSON.stringify({ symbol: state.symbol, ...f, cs: state.cs, ts: state.ts, type: state.type });
      upsertTicker.run({
        $symbol: state.symbol,
        $last_price: f.lastPrice ?? null,
        $mark_price: f.markPrice ?? null,
        $index_price: f.indexPrice ?? null,
        $bid1_price: f.bid1Price ?? null,
        $bid1_size: f.bid1Size ?? null,
        $ask1_price: f.ask1Price ?? null,
        $ask1_size: f.ask1Size ?? null,
        $volume_24h: f.volume24h ?? null,
        $turnover_24h: f.turnover24h ?? null,
        $price_24h_pcnt: f.price24hPcnt ?? null,
        $high_price_24h: f.highPrice24h ?? null,
        $low_price_24h: f.lowPrice24h ?? null,
        $funding_rate: f.fundingRate ?? null,
        $next_funding_time: f.nextFundingTime ?? null,
        $open_interest: f.openInterest ?? null,
        $open_interest_value: f.openInterestValue ?? null,
        $payload_json: payload,
        $recv_ts: recvTs,
        $exch_ts: state.ts ?? null,
        $cs: state.cs ?? null,
        $type: state.type,
      });
      if (snapshot) {
        insertTickerSnap.run(state.symbol, state.type, payload, recvTs, state.ts ?? null);
      }
    },
    saveOrderbook(state: OrderBookState, depth: number, type: string, recvTs: number, exchTs: number | undefined, snapshot: boolean) {
      const { bids, asks } = serializeBook(state);
      const bidsJson = JSON.stringify(bids);
      const asksJson = JSON.stringify(asks);
      upsertBook.run(
        state.symbol,
        depth,
        bidsJson,
        asksJson,
        state.updateId,
        state.seq,
        recvTs,
        exchTs ?? null,
        type,
      );
      if (snapshot) {
        insertBookSnap.run(
          state.symbol,
          depth,
          type,
          bidsJson,
          asksJson,
          state.updateId,
          state.seq,
          recvTs,
          exchTs ?? null,
        );
      }
    },
    saveKline(symbol: string, candle: BybitKline, recvTs: number) {
      upsertKline.run(
        symbol,
        candle.interval,
        candle.start,
        candle.end,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.turnover,
        candle.confirm ? 1 : 0,
        candle.timestamp,
        recvTs,
      );
    },
    setHealth(fields: {
      connected?: number;
      endpoint?: string;
      subscribedTopics?: number;
      lastMessageTs?: number;
      lastPongTs?: number;
      lastPingTs?: number;
      connectTs?: number;
      disconnectTs?: number;
      reconnectCount?: number;
      lastError?: string | null;
    }) {
      touchHealth.run({
        $connected: fields.connected ?? null,
        $endpoint: fields.endpoint ?? null,
        $subscribed_topics: fields.subscribedTopics ?? null,
        $last_message_ts: fields.lastMessageTs ?? null,
        $last_pong_ts: fields.lastPongTs ?? null,
        $last_ping_ts: fields.lastPingTs ?? null,
        $connect_ts: fields.connectTs ?? null,
        $disconnect_ts: fields.disconnectTs ?? null,
        $reconnect_count: fields.reconnectCount ?? null,
        $last_error: fields.lastError === undefined ? null : fields.lastError,
      });
    },
    bumpReconnect() {
      db.exec("UPDATE connection_health SET reconnect_count = reconnect_count + 1 WHERE id = 1");
    },
    setMeta(key: string, value: string) {
      setMeta(db, key, value);
    },
    getMeta(): Record<string, { value: string; updatedTs: number }> {
      const rows = db.prepare("SELECT key, value, updated_ts FROM meta").all() as {
        key: string;
        value: string;
        updated_ts: number;
      }[];
      const out: Record<string, { value: string; updatedTs: number }> = {};
      for (const row of rows) out[row.key] = { value: row.value, updatedTs: row.updated_ts };
      return out;
    },
    getHealth() {
      return db.prepare("SELECT * FROM connection_health WHERE id = 1").get() as Record<string, unknown> | null;
    },
    getLastKlineStart(symbol: string, interval: string): number | null {
      const row = db
        .prepare("SELECT MAX(start_ts) AS start_ts FROM klines WHERE symbol = ? AND interval = ?")
        .get(symbol, interval) as { start_ts: number | null } | null;
      return row?.start_ts ?? null;
    },
    klineStats(symbol?: string, interval?: string) {
      const where: string[] = [];
      const args: string[] = [];
      if (symbol) {
        where.push("symbol = ?");
        args.push(symbol);
      }
      if (interval) {
        where.push("interval = ?");
        args.push(interval);
      }
      const sql = `SELECT symbol, interval, COUNT(*) AS count,
        MIN(start_ts) AS min_start, MAX(start_ts) AS max_start
        FROM klines ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        GROUP BY symbol, interval
        ORDER BY symbol, CAST(interval AS INTEGER)`;
      return db.prepare(sql).all(...args) as Array<{
        symbol: string;
        interval: string;
        count: number;
        min_start: number | null;
        max_start: number | null;
      }>;
    },
    listTickers(symbol?: string) {
      const sql = symbol
        ? "SELECT * FROM ticker_latest WHERE symbol = ? ORDER BY symbol"
        : "SELECT * FROM ticker_latest ORDER BY symbol";
      return symbol ? db.prepare(sql).all(symbol) : db.prepare(sql).all();
    },
    listOrderbooks(symbol?: string) {
      const sql = symbol
        ? "SELECT * FROM orderbook_latest WHERE symbol = ? ORDER BY symbol"
        : "SELECT * FROM orderbook_latest ORDER BY symbol";
      return symbol ? db.prepare(sql).all(symbol) : db.prepare(sql).all();
    },
    listOrderbookSnapshots(opts: {
      symbol?: string;
      limit?: number;
      startTs?: number;
      endTs?: number;
      maxLimit?: number;
    }) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (opts.symbol) {
        where.push("symbol = ?");
        args.push(opts.symbol);
      }
      if (opts.startTs !== undefined) {
        where.push("recv_ts >= ?");
        args.push(opts.startTs);
      }
      if (opts.endTs !== undefined) {
        where.push("recv_ts <= ?");
        args.push(opts.endTs);
      }
      const cap = opts.maxLimit ?? 500;
      const limit = Math.min(Math.max(opts.limit ?? 120, 1), cap);
      const sql = `SELECT * FROM orderbook_snapshots ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY recv_ts DESC LIMIT ?`;
      args.push(limit);
      return db.prepare(sql).all(...args);
    },
    listKlines(opts: {
      symbol?: string;
      interval?: string;
      limit?: number;
      confirm?: boolean;
      startTs?: number;
      endTs?: number;
      maxLimit?: number;
    }) {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (opts.symbol) {
        where.push("symbol = ?");
        args.push(opts.symbol);
      }
      if (opts.interval) {
        where.push("interval = ?");
        args.push(opts.interval);
      }
      if (opts.startTs !== undefined) {
        where.push("start_ts >= ?");
        args.push(opts.startTs);
      }
      if (opts.endTs !== undefined) {
        where.push("start_ts <= ?");
        args.push(opts.endTs);
      }
      if (opts.confirm === true) where.push("confirm = 1");
      if (opts.confirm === false) where.push("confirm = 0");
      const cap = opts.maxLimit ?? 1000;
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), cap);
      const sql = `SELECT * FROM klines ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY start_ts DESC LIMIT ?`;
      args.push(limit);
      return db.prepare(sql).all(...args);
    },
    prune(now: number, retention: {
      tickerSnapshotsHours: number;
      orderbookSnapshotsHours: number;
      klinesDays: number;
      vacuumMinIntervalMs?: number;
    }) {
      const tickerCut = now - retention.tickerSnapshotsHours * 3600_000;
      const bookCut = now - retention.orderbookSnapshotsHours * 3600_000;
      const klineCut = now - retention.klinesDays * 86400_000;
      const tickerDeleted = db.prepare("DELETE FROM ticker_snapshots WHERE recv_ts < ?").run(tickerCut).changes;
      const bookDeleted = db.prepare("DELETE FROM orderbook_snapshots WHERE recv_ts < ?").run(bookCut).changes;
      const klineDeleted = db.prepare("DELETE FROM klines WHERE start_ts < ? AND confirm = 1").run(klineCut).changes;
      setMeta(db, "last_prune_ts", String(now));
      const reclaim = reclaimSqlite(db, now, retention.vacuumMinIntervalMs ?? 3_600_000);
      return { tickerDeleted, bookDeleted, klineDeleted, ...reclaim };
    },
  };
}
