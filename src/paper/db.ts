import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  PaperAccountSeed,
  PaperAccountRow,
  PaperCloseReason,
  PaperFillKind,
  PaperFillSource,
  PaperPositionRow,
  PaperSide,
  PaperStatus,
} from "./types";

export const PAPER_SCHEMA_VERSION = "2";

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

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
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
      fee_rate TEXT NOT NULL DEFAULT '0',
      leverage_min TEXT NOT NULL DEFAULT '1',
      leverage_max TEXT NOT NULL DEFAULT '25',
      default_leverage TEXT NOT NULL DEFAULT '1',
      mm_rate TEXT NOT NULL DEFAULT '0.005',
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
  `);

  const accountCols = tableColumns(db, "paper_accounts");
  const accountAdds: Array<[string, string]> = [
    ["fee_rate", "TEXT NOT NULL DEFAULT '0'"],
    ["leverage_min", "TEXT NOT NULL DEFAULT '1'"],
    ["leverage_max", "TEXT NOT NULL DEFAULT '25'"],
    ["default_leverage", "TEXT NOT NULL DEFAULT '1'"],
    ["mm_rate", "TEXT NOT NULL DEFAULT '0.005'"],
    ["margin_mode", "TEXT NOT NULL DEFAULT 'isolated'"],
  ];
  for (const [name, spec] of accountAdds) {
    if (!accountCols.has(name)) db.exec(`ALTER TABLE paper_accounts ADD COLUMN ${name} ${spec}`);
  }

  rebuildPositionsIfNeeded(db);
  rebuildFillsIfNeeded(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_funding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES paper_positions(id),
      account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty TEXT NOT NULL,
      mark_price TEXT NOT NULL,
      rate TEXT NOT NULL,
      amount TEXT NOT NULL,
      funding_time INTEGER NOT NULL,
      ts INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO paper_accounts (
      id, name, quote, cash, equity, starting_cash,
      risk_pct_min, risk_pct_max, default_risk_pct, min_rr,
      fee_rate, leverage_min, leverage_max, default_leverage, mm_rate,
      created_ts, updated_ts
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    seed.feeRate,
    seed.leverageMin,
    seed.leverageMax,
    seed.defaultLeverage,
    seed.mmRate,
    now,
    now,
  );

  db.prepare(
    `UPDATE paper_accounts SET
      risk_pct_min = ?, risk_pct_max = ?, default_risk_pct = ?, margin_mode = ?, updated_ts = ?
     WHERE id = 1`,
  ).run(seed.riskPctMin, seed.riskPctMax, seed.defaultRiskPct, seed.marginMode, now);

  db.prepare(
    `INSERT INTO paper_meta (key, value, updated_ts) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts`,
  ).run("schema_version", PAPER_SCHEMA_VERSION, now);
}

function rebuildPositionsIfNeeded(db: Database) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_positions'").get();
  if (!exists) {
    db.exec(positionsDdl());
    return;
  }
  const cols = tableColumns(db, "paper_positions");
  if (cols.has("leverage") && cols.has("take_profits_json")) return;
  db.exec("ALTER TABLE paper_positions RENAME TO paper_positions_v1");
  db.exec(positionsDdl());
  db.exec(`
    INSERT INTO paper_positions (
      id, account_id, symbol, side, qty, risk_pct, entry_price, stop_loss, take_profit,
      risk_quote, reward_quote, rr, timeframes, mtf_json, status, opened_ts, closed_ts,
      close_price, close_reason, realized_pnl, unrealized_pnl, mark_price, fill_source,
      fill_recv_ts, note, leverage, qty_initial, margin, liq_price, take_profits_json,
      last_funding_ts, open_fee, close_fee
    )
    SELECT
      id, account_id, symbol, side, qty, risk_pct, entry_price, stop_loss, take_profit,
      risk_quote, reward_quote, rr, timeframes, mtf_json, status, opened_ts, closed_ts,
      close_price, close_reason, realized_pnl, unrealized_pnl, mark_price, fill_source,
      fill_recv_ts, note, '1', qty, '0', '0',
      json_array(json_object('price', take_profit, 'qtyPct', '1', 'filled', status = 'closed')),
      NULL, '0', '0'
    FROM paper_positions_v1
  `);
  db.exec("DROP TABLE paper_positions_v1");
}

function rebuildFillsIfNeeded(db: Database) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_fills'").get() as
    | { name: string }
    | undefined;
  if (!exists) {
    db.exec(fillsDdl());
    return;
  }
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='paper_fills'").get() as
    | { sql: string }
    | undefined;
  if (ddl?.sql.includes("'liq'")) return;
  db.exec("ALTER TABLE paper_fills RENAME TO paper_fills_v1");
  db.exec(fillsDdl());
  db.exec(`
    INSERT INTO paper_fills (id, position_id, account_id, kind, symbol, side, qty, price, source, recv_ts, ts)
    SELECT id, position_id, account_id, kind, symbol, side, qty, price, source, recv_ts, ts
    FROM paper_fills_v1
  `);
  db.exec("DROP TABLE paper_fills_v1");
}

function positionsDdl(): string {
  return `
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
      close_reason TEXT CHECK (close_reason IN ('sl', 'tp', 'manual', 'liq') OR close_reason IS NULL),
      realized_pnl TEXT,
      unrealized_pnl TEXT,
      mark_price TEXT,
      fill_source TEXT NOT NULL,
      fill_recv_ts INTEGER NOT NULL,
      note TEXT,
      leverage TEXT NOT NULL,
      qty_initial TEXT NOT NULL,
      margin TEXT NOT NULL,
      liq_price TEXT NOT NULL,
      take_profits_json TEXT NOT NULL,
      last_funding_ts INTEGER,
      open_fee TEXT NOT NULL,
      close_fee TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_positions_status_symbol
      ON paper_positions(status, symbol);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_one_open_symbol
      ON paper_positions(symbol) WHERE status = 'open';
  `;
}

function fillsDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS paper_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES paper_positions(id),
      account_id INTEGER NOT NULL REFERENCES paper_accounts(id),
      kind TEXT NOT NULL CHECK (kind IN ('open', 'close')),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty TEXT NOT NULL,
      price TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('last', 'sl', 'tp', 'liq')),
      recv_ts INTEGER,
      ts INTEGER NOT NULL
    );
  `;
}

function wrap(db: Database) {
  const getAccountStmt = db.prepare("SELECT * FROM paper_accounts WHERE id = 1");
  const updateAccountStmt = db.prepare(
    `UPDATE paper_accounts SET cash = ?, equity = ?, updated_ts = ? WHERE id = 1`,
  );
  const updateMinRrStmt = db.prepare(
    `UPDATE paper_accounts SET min_rr = ?, updated_ts = ? WHERE id = 1`,
  );
  const updatePhase2Stmt = db.prepare(
    `UPDATE paper_accounts SET fee_rate = ?, leverage_min = ?, leverage_max = ?,
      default_leverage = ?, mm_rate = ?, updated_ts = ? WHERE id = 1`,
  );
  const updateMarginModeStmt = db.prepare(
    `UPDATE paper_accounts SET margin_mode = ?, updated_ts = ? WHERE id = 1`,
  );
  const insertPositionStmt = db.prepare(
    `INSERT INTO paper_positions (
      account_id, symbol, side, qty, risk_pct, entry_price, stop_loss, take_profit,
      risk_quote, reward_quote, rr, timeframes, mtf_json, status, opened_ts,
      closed_ts, close_price, close_reason, realized_pnl, unrealized_pnl, mark_price,
      fill_source, fill_recv_ts, note, leverage, qty_initial, margin, liq_price,
      take_profits_json, last_funding_ts, open_fee, close_fee
    ) VALUES (
      1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?,
      NULL, NULL, NULL, NULL, ?, ?, 'last', ?, ?,
      ?, ?, ?, ?, ?, NULL, ?, '0'
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
    `UPDATE paper_positions SET
      unrealized_pnl = ?, mark_price = ?, margin = ?,
      liq_price = COALESCE(?, liq_price)
     WHERE id = ? AND status = 'open'`,
  );
  const closePositionStmt = db.prepare(
    `UPDATE paper_positions SET
      status = 'closed',
      closed_ts = ?,
      close_price = ?,
      close_reason = ?,
      realized_pnl = ?,
      unrealized_pnl = '0',
      mark_price = ?,
      qty = '0',
      margin = '0',
      close_fee = ?,
      take_profits_json = ?
     WHERE id = ? AND status = 'open'`,
  );
  const partialCloseStmt = db.prepare(
    `UPDATE paper_positions SET
      qty = ?,
      margin = ?,
      realized_pnl = ?,
      close_fee = ?,
      take_profits_json = ?,
      mark_price = ?,
      unrealized_pnl = ?
     WHERE id = ? AND status = 'open'`,
  );
  const setFundingStmt = db.prepare(
    `UPDATE paper_positions SET last_funding_ts = ? WHERE id = ?`,
  );
  const insertFillStmt = db.prepare(
    `INSERT INTO paper_fills (
      position_id, account_id, kind, symbol, side, qty, price, source, recv_ts, ts
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFundingStmt = db.prepare(
    `INSERT INTO paper_funding (
      position_id, account_id, symbol, side, qty, mark_price, rate, amount, funding_time, ts
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
    setPhase2(fields: {
      feeRate: string;
      leverageMin: string;
      leverageMax: string;
      defaultLeverage: string;
      mmRate: string;
    }, ts = Date.now()) {
      updatePhase2Stmt.run(
        fields.feeRate,
        fields.leverageMin,
        fields.leverageMax,
        fields.defaultLeverage,
        fields.mmRate,
        ts,
      );
    },
    setMarginMode(mode: "isolated" | "cross", ts = Date.now()) {
      updateMarginModeStmt.run(mode, ts);
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
      leverage: string;
      qtyInitial: string;
      margin: string;
      liqPrice: string;
      takeProfitsJson: string;
      openFee: string;
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
        row.leverage,
        row.qtyInitial,
        row.margin,
        row.liqPrice,
        row.takeProfitsJson,
        row.openFee,
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
    markOpen(id: number, unrealizedPnl: string, markPrice: string, margin: string, liqPrice: string | null = null) {
      markOpenStmt.run(unrealizedPnl, markPrice, margin, liqPrice, id);
    },
    closePosition(row: {
      id: number;
      closedTs: number;
      closePrice: string;
      closeReason: PaperCloseReason;
      realizedPnl: string;
      closeFee: string;
      takeProfitsJson: string;
    }) {
      const result = closePositionStmt.run(
        row.closedTs,
        row.closePrice,
        row.closeReason,
        row.realizedPnl,
        row.closePrice,
        row.closeFee,
        row.takeProfitsJson,
        row.id,
      );
      return result.changes;
    },
    partialClose(row: {
      id: number;
      qty: string;
      margin: string;
      realizedPnl: string;
      closeFee: string;
      takeProfitsJson: string;
      markPrice: string;
      unrealizedPnl: string;
    }) {
      partialCloseStmt.run(
        row.qty,
        row.margin,
        row.realizedPnl,
        row.closeFee,
        row.takeProfitsJson,
        row.markPrice,
        row.unrealizedPnl,
        row.id,
      );
    },
    setLastFunding(id: number, fundingTime: number) {
      setFundingStmt.run(fundingTime, id);
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
    insertFunding(row: {
      positionId: number;
      symbol: string;
      side: PaperSide;
      qty: string;
      markPrice: string;
      rate: string;
      amount: string;
      fundingTime: number;
      ts: number;
    }) {
      insertFundingStmt.run(
        row.positionId,
        row.symbol,
        row.side,
        row.qty,
        row.markPrice,
        row.rate,
        row.amount,
        row.fundingTime,
        row.ts,
      );
    },
  };
}
