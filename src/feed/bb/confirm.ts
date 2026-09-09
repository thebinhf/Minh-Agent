import { loadConfig } from "./config";
import { openDb, type TrackerDb } from "./db";
import {
  EMPTY_TICKER,
  normalizeBriefSymbol,
  readBriefKlines,
  readBriefTicker,
  type BriefKline,
  type BriefStore,
  type BriefTicker,
} from "./brief";

/** LTF window for EVENT confirm. No 4H/1H, no depth. */
export const CONFIRM_KLINE_LIMIT = 20;
export const CONFIRM_INTERVALS = ["15", "5"] as const;

export type ConfirmInterval = (typeof CONFIRM_INTERVALS)[number];

export type SnapshotConfirm = {
  symbol: string;
  ts: number;
  interval: ConfirmInterval;
  ticker: BriefTicker;
  klines: BriefKline[];
  meta: {
    db: string;
    limit: number;
    note: "ltf confirm — agent reads PA; no S/D";
  };
};

export type ConfirmStore = BriefStore;

export function parseConfirmInterval(raw: string | undefined | null): ConfirmInterval | null {
  if (raw == null || raw.trim() === "") return "15";
  const token = raw.trim();
  if (token === "15" || token === "5") return token;
  return null;
}

export function emptyConfirm(
  symbol: string,
  dbPath: string,
  ts: number,
  interval: ConfirmInterval = "15",
): SnapshotConfirm {
  return {
    symbol,
    ts,
    interval,
    ticker: { ...EMPTY_TICKER },
    klines: [],
    meta: {
      db: dbPath,
      limit: CONFIRM_KLINE_LIMIT,
      note: "ltf confirm — agent reads PA; no S/D",
    },
  };
}

export function buildConfirm(
  store: ConfirmStore,
  opts: {
    symbol?: string | null;
    interval?: string | null;
    dbPath: string;
    now?: number;
  },
): SnapshotConfirm {
  const interval = parseConfirmInterval(opts.interval);
  if (interval == null) {
    throw new Error("confirm_interval");
  }
  const symbol = normalizeBriefSymbol(opts.symbol);
  const now = opts.now ?? Date.now();
  const body = emptyConfirm(symbol, opts.dbPath, now, interval);
  body.ticker = readBriefTicker(store, symbol);
  body.klines = readBriefKlines(store, symbol, interval, CONFIRM_KLINE_LIMIT);
  return body;
}

function confirmUsage(): never {
  console.log(`Usage:
  bun run confirm [SYMBOL] [--interval 15|5]

LTF snapshot for EVENT (ticker + 20 bars). Default 15m; scalp uses 5.
No 4H/1H, no depth, no S/D. Default SYMBOL is BTCUSDT.
`);
  process.exit(2);
}

export function parseConfirmArgs(argv: string[]): { symbol: string; interval: ConfirmInterval } {
  if (argv.includes("--help") || argv.includes("-h")) confirmUsage();
  const dash = argv.indexOf("--interval");
  let intervalRaw: string | undefined;
  const rest = [...argv];
  if (dash >= 0) {
    intervalRaw = rest[dash + 1];
    rest.splice(dash, 2);
  }
  const interval = parseConfirmInterval(intervalRaw);
  if (interval == null) confirmUsage();
  const positional = rest.find((arg) => !arg.startsWith("-"));
  return { symbol: normalizeBriefSymbol(positional), interval };
}

async function main(): Promise<void> {
  const { symbol, interval } = parseConfirmArgs(process.argv.slice(2));
  const config = await loadConfig();
  let store: TrackerDb;
  try {
    store = openDb(config.dbPath, true);
  } catch (error) {
    console.error(`Cannot open ${config.dbPath}. Is the tracker running?`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(buildConfirm(store, { symbol, interval, dbPath: config.dbPath }), null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
