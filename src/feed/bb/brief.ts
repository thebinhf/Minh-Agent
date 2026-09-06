import { loadConfig } from "./config";
import { openDb, type TrackerDb } from "./db";
import { PA_KLINE_INTERVALS } from "./types";

/** Newest-last window sizes for the Minh snapshot brief (15m / 1h / 4h). */
export const BRIEF_KLINE_LIMITS = {
  "15": 80,
  "60": 48,
  "240": 30,
} as const;

export type BriefInterval = (typeof PA_KLINE_INTERVALS)[number];

export type BriefTicker = {
  lastPrice: string | null;
  markPrice: string | null;
  bid1Price: string | null;
  ask1Price: string | null;
  fundingRate: string | null;
  nextFundingTime: string | null;
  openInterest: string | null;
  openInterestValue: string | null;
  recvTs: number | null;
};

export type BriefKline = {
  start_ts: number | null;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  turnover: string | null;
  confirm: boolean | null;
};

export type BriefLimits = {
  "15": number;
  "60": number;
  "240": number;
};

export type SnapshotBrief = {
  symbol: string;
  ts: number;
  ticker: BriefTicker;
  klines: {
    "15": BriefKline[];
    "60": BriefKline[];
    "240": BriefKline[];
  };
  meta: {
    db: string;
    limits: BriefLimits;
  };
};

export type BriefStore = Pick<TrackerDb, "listTickers" | "listKlines">;

export const EMPTY_TICKER: BriefTicker = {
  lastPrice: null,
  markPrice: null,
  bid1Price: null,
  ask1Price: null,
  fundingRate: null,
  nextFundingTime: null,
  openInterest: null,
  openInterestValue: null,
  recvTs: null,
};

export const DEFAULT_BRIEF_SYMBOL = "BTCUSDT";

export function normalizeBriefSymbol(raw: string | undefined | null): string {
  const symbol = raw?.trim().toUpperCase();
  return symbol || DEFAULT_BRIEF_SYMBOL;
}

export function parseBriefArgs(argv: string[]): { symbol: string } {
  if (argv.includes("--help") || argv.includes("-h")) briefUsage();
  const positional = argv.find((arg) => !arg.startsWith("-"));
  return { symbol: normalizeBriefSymbol(positional) };
}

/** Empty payload with the stable Minh shape. Missing data is null / []. */
export function emptyBrief(symbol: string, dbPath: string, now = Date.now(), limits: BriefLimits = { ...BRIEF_KLINE_LIMITS }): SnapshotBrief {
  return {
    symbol: normalizeBriefSymbol(symbol),
    ts: now,
    ticker: { ...EMPTY_TICKER },
    klines: { "15": [], "60": [], "240": [] },
    meta: { db: dbPath, limits },
  };
}

/**
 * One local snapshot for Minh: latest ticker + 15/60/240 klines.
 * Kline arrays are oldest-first (newest last). The last row is the most recent
 * candle and may be unconfirmed. Missing rows/fields become [] / null; never throws.
 */
export function buildBrief(
  store: BriefStore,
  opts: {
    symbol?: string;
    dbPath: string;
    now?: number;
    limits?: Partial<BriefLimits>;
  },
): SnapshotBrief {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const limits: BriefLimits = {
    "15": opts.limits?.["15"] ?? BRIEF_KLINE_LIMITS["15"],
    "60": opts.limits?.["60"] ?? BRIEF_KLINE_LIMITS["60"],
    "240": opts.limits?.["240"] ?? BRIEF_KLINE_LIMITS["240"],
  };
  const now = opts.now ?? Date.now();
  const brief = emptyBrief(symbol, opts.dbPath, now, limits);
  brief.ticker = readTicker(store, symbol);
  brief.klines["15"] = readKlines(store, symbol, "15", limits["15"]);
  brief.klines["60"] = readKlines(store, symbol, "60", limits["60"]);
  brief.klines["240"] = readKlines(store, symbol, "240", limits["240"]);
  return brief;
}

function readTicker(store: BriefStore, symbol: string): BriefTicker {
  return tryRead(() => {
    const rows = store.listTickers(symbol) as Array<Record<string, unknown>> | unknown;
    if (!Array.isArray(rows) || rows.length === 0) return { ...EMPTY_TICKER };
    const row = rows[0] ?? {};
    return {
      lastPrice: textField(row.last_price),
      markPrice: textField(row.mark_price),
      bid1Price: textField(row.bid1_price),
      ask1Price: textField(row.ask1_price),
      fundingRate: textField(row.funding_rate),
      nextFundingTime: textField(row.next_funding_time),
      openInterest: textField(row.open_interest),
      openInterestValue: textField(row.open_interest_value),
      recvTs: numberField(row.recv_ts),
    };
  }, { ...EMPTY_TICKER });
}

function readKlines(store: BriefStore, symbol: string, interval: BriefInterval, limit: number): BriefKline[] {
  return tryRead(() => {
    const rows = store.listKlines({
      symbol,
      interval,
      limit,
      maxLimit: Math.max(limit, 1),
    }) as Array<Record<string, unknown>> | unknown;
    if (!Array.isArray(rows)) return [];
    // listKlines is start_ts DESC (newest first). Reverse so the last row is newest.
    return rows.slice().reverse().map(mapKline);
  }, []);
}

function mapKline(row: Record<string, unknown>): BriefKline {
  return {
    start_ts: numberField(row.start_ts),
    open: textField(row.open),
    high: textField(row.high),
    low: textField(row.low),
    close: textField(row.close),
    volume: textField(row.volume),
    turnover: textField(row.turnover),
    confirm: confirmField(row.confirm),
  };
}

function textField(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function numberField(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function confirmField(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return Boolean(value);
}

function tryRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function briefUsage(): never {
  console.log(`Usage:
  bun run brief [SYMBOL]

Print one local snapshot JSON for Minh (ticker + 15/60/240 klines).
Default SYMBOL is BTCUSDT. Read-only against the tracker SQLite file.
Kline arrays are oldest-first (newest last). Missing data is null / [].
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { symbol } = parseBriefArgs(process.argv.slice(2));
  const config = await loadConfig();
  let store;
  try {
    store = openDb(config.dbPath, true);
  } catch (error) {
    console.error(`Cannot open ${config.dbPath}. Is the tracker running?`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(buildBrief(store, { symbol, dbPath: config.dbPath }), null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
