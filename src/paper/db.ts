import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PaperAccountSeed, PaperAccountRow, PaperCloseReason, PaperFillKind, PaperFillSource, PaperPositionRow, PaperSide, PaperStatus } from "./types";

export const PAPER_SCHEMA_VERSION = "1";

export type PaperDb = ReturnType<typeof openPaperDb>;

export function openPaperDb(dbPath: string, seed: PaperAccountSeed) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db, seed);
  return wrap(db);
}

function migrate(db: Database, seed: PaperAccountSeed) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_accounts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL UNIQUE,
      quote TEXT NOT NULL,
      cash TEXT NOT NULL,
      equity TEXT NOT NULL,
      starting_cash TEXT NOT NULL,
      risk_pct_min TEXT NOT NULL,
      risk_pct_max TEXT NOT NULL,
      default_risk_pct TEXT NOT NULL,
      min_rr TEXT,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('long', 'short')),
      qty TEXT NOT NULL,
      risk_pct TEXT NOT NULL,
      entry_price TEXT NOT NULL,
      stop_loss TEXT NOT NULL,
      take_profit TEXT NOT NULL,
      risk_quote TEXT NOT NULL,
      reward_quote TEXT NOT NULL,
      rr TEXT NOT NULL,
      timeframes TEXT NOT NULL,
      mtf_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      opened_ts INTEGER NOT NULL,
      closed_ts INTEGER,
      close_price TEXT,
      close_reason TEXT CHECK (close_reason IN ('sl', 'tp', 'manual') OR close_reason IS NULL),
      realized_pnl TEXT,
      unrealized_pnl TEXT,
      mark_price TEXT,
      fill_source TEXT NOT NULL,
      fill_recv_ts INTEGER NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_paper_positions_status_symbol
      ON paper_positions(status, symbol);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_one_open_symbol
      ON paper_positions(symbol) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS paper_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES paper_positions(id),
      account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
      kind TEXT NOT NULL CHECK (kind IN ('open', 'close')),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty TEXT NOT NULL,
      price TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('last', 'sl', 'tp')),
      recv_ts INTEGER,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO paper_accounts (
      id, name, quote, cash, equity, starting_cash,
      risk_pct_min, risk_pct_max, default_risk_pct, min_rr, created_ts, updated_ts
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.name,
    seed.quote,
    seed.startingCash,
    seed.startingCash,
    seed.startingCash,
    seed.riskPctMin,
    seed.riskPctMax,
    seed.defaultRiskPct,
    seed.minRr,
    now,
    now,
  );

  db.prepare(
    `INSERT INTO paper_meta (key, value, updated_ts) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts`,
  ).run("schema_version", PAPER_SCHEMA_VERSION, now);
}

function wrap(db: Database) {
  const getAccountStmt = db.prepare("SELECT * FROM paper_accounts WHERE id = 1");
  const updateAccountStmt = db.prepare(
    `UPDATE paper_accounts SET cash = ?, equity = ?, updated_ts = ? WHERE id = 1`,
  );
  const updateMinRrStmt = db.prepare(
    `UPDATE paper_accounts SET min_rr = ?, updated_ts = ? WHERE id = 1`,
  );
  const insertPositionStmt = db.prepare(
    `INSERT INTO paper_positions (
      account_id, symbol, side, qty, risk_pct, entry_price, stop_loss, take_profit,
      risk_quote, reward_quote, rr, timeframes, mtf_json, status, opened_ts,
      closed_ts, close_price, close_reason, realized_pnl, unrealized_pnl, mark_price,
      fill_source, fill_recv_ts, note
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?,
      NULL, NULL, NULL, NULL, ?, ?, 'last', ?, ?
    )`,
  );
  const getPositionStmt = db.prepare("SELECT * FROM paper_positions WHERE id = ?");
  const listPositionsStmt = db.prepare(
    `SELECT * FROM paper_positions
     WHERE (? = 'all' OR status = ?)
     ORDER BY id`,
  );
  const openOnSymbolStmt = db.prepare(
    `SELECT id FROM paper_positions WHERE status = 'open' AND symbol = ? LIMIT 1`,
  );
  const countOpenStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM paper_positions WHERE status = 'open'`,
  );
  const listOpenStmt = db.prepare(
    `SELECT * FROM paper_positions WHERE status = 'open' ORDER BY id`,
  );
  const markOpenStmt = db.prepare(
    `UPDATE paper_positions SET unrealized_pnl = ?, mark_price = ? WHERE id = ? AND status = 'open'`,
  );
  const closePositionStmt = db.prepare(
    `UPDATE paper_positions SET
      status = 'closed',
      closed_ts = ?,
      close_price = ?,
      close_reason = ?,
      realized_pnl = ?,
      unrealized_pnl = '0',
      mark_price = ?
     WHERE id = ? AND status = 'open'`,
  );
  const insertFillStmt = db.prepare(
    `INSERT INTO paper_fills (
      position_id, account_id, kind, symbol, side, qty, price, source, recv_ts, ts
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    raw: db,
    close() {
      db.close();
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    getAccount(): PaperAccountRow {
      const row = getAccountStmt.get() as PaperAccountRow | null;
      if (!row) throw new Error("paper account missing");
      return row;
    },
    setMinRr(minRr: string | null, ts = Date.now()) {
      updateMinRrStmt.run(minRr, ts);
    },
    updateAccount(cash: string, equity: string, ts = Date.now()) {
      updateAccountStmt.run(cash, equity, ts);
    },
    insertPosition(row: {
      symbol: string;
      side: PaperSide;
      qty: string;
      riskPct: string;
      entryPrice: string;
      stopLoss: string;
      takeProfit: string;
      riskQuote: string;
      rewardQuote: string;
      rr: string;
      timeframes: string;
      mtfJson: string | null;
      openedTs: number;
      unrealizedPnl: string;
      markPrice: string;
      fillRecvTs: number;
      note: string | null;
    }): number {
      const result = insertPositionStmt.run(
        row.symbol,
        row.side,
        row.qty,
        row.riskPct,
        row.entryPrice,
        row.stopLoss,
        row.takeProfit,
        row.riskQuote,
        row.rewardQuote,
        row.rr,
        row.timeframes,
        row.mtfJson,
        row.openedTs,
        row.unrealizedPnl,
        row.markPrice,
        row.fillRecvTs,
        row.note,
      );
      return Number(result.lastInsertRowid);
    },
    getPosition(id: number): PaperPositionRow | null {
      return (getPositionStmt.get(id) as PaperPositionRow | null) ?? null;
    },
    listPositions(status: PaperStatus | "all"): PaperPositionRow[] {
      return listPositionsStmt.all(status, status) as PaperPositionRow[];
    },
    listOpen(): PaperPositionRow[] {
      return listOpenStmt.all() as PaperPositionRow[];
    },
    openIdOnSymbol(symbol: string): number | null {
      const row = openOnSymbolStmt.get(symbol) as { id: number } | null;
      return row?.id ?? null;
    },
    countOpen(): number {
      const row = countOpenStmt.get() as { n: number };
      return Number(row.n);
    },
    markOpen(id: number, unrealizedPnl: string, markPrice: string) {
      markOpenStmt.run(unrealizedPnl, markPrice, id);
    },
    closePosition(row: {
      id: number;
      closedTs: number;
      closePrice: string;
      closeReason: PaperCloseReason;
      realizedPnl: string;
    }) {
      const result = closePositionStmt.run(
        row.closedTs,
        row.closePrice,
        row.closeReason,
        row.realizedPnl,
        row.closePrice,
        row.id,
      );
      return result.changes;
    },
    insertFill(row: {
      positionId: number;
      kind: PaperFillKind;
      symbol: string;
      side: PaperSide;
      qty: string;
      price: string;
      source: PaperFillSource;
      recvTs: number | null;
      ts: number;
    }) {
      insertFillStmt.run(
        row.positionId,
        row.kind,
        row.symbol,
        row.side,
        row.qty,
        row.price,
        row.source,
        row.recvTs,
        row.ts,
      );
    },
  };
}
