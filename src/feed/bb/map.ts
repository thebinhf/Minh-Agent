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

/** HTF-only windows for MAP. No 15m — that stays on /brief and /chart. */
export const MAP_KLINE_LIMITS = {
  "240": 20,
  "60": 24,
  D: 30,
} as const;

export const MAP_SYMBOL_CAP = 8;

export type MapLimits = {
  "240": number;
  "60": number;
  D: number;
};

export type SnapshotMap = {
  symbol: string;
  ts: number;
  ticker: BriefTicker;
  klines: {
    "240": BriefKline[];
    "60": BriefKline[];
    D: BriefKline[];
  };
  meta: {
    db: string;
    limits: MapLimits;
    note: "htf map — agent draws S/D; no bias";
  };
};

export type MapStore = BriefStore;

export function emptyMap(symbol: string, dbPath: string, ts: number, limits: MapLimits = { ...MAP_KLINE_LIMITS }): SnapshotMap {
  return {
    symbol,
    ts,
    ticker: { ...EMPTY_TICKER },
    klines: { "240": [], "60": [], D: [] },
    meta: {
      db: dbPath,
      limits,
      note: "htf map — agent draws S/D; no bias",
    },
  };
}

export function buildMap(
  store: MapStore,
  opts: {
    symbol?: string | null;
    dbPath: string;
    now?: number;
    limits?: Partial<MapLimits>;
  },
): SnapshotMap {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const limits: MapLimits = {
    "240": opts.limits?.["240"] ?? MAP_KLINE_LIMITS["240"],
    "60": opts.limits?.["60"] ?? MAP_KLINE_LIMITS["60"],
    D: opts.limits?.D ?? MAP_KLINE_LIMITS.D,
  };
  const now = opts.now ?? Date.now();
  const map = emptyMap(symbol, opts.dbPath, now, limits);
  map.ticker = readBriefTicker(store, symbol);
  map.klines["240"] = readBriefKlines(store, symbol, "240", limits["240"]);
  map.klines["60"] = readBriefKlines(store, symbol, "60", limits["60"]);
  map.klines.D = readBriefKlines(store, symbol, "D", limits.D);
  return map;
}

export function parseMapSymbols(raw: string | undefined | null): string[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const symbol of parts) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

export type SnapshotMapBatch = {
  ts: number;
  maps: SnapshotMap[];
  meta: {
    db: string;
    count: number;
    note: "htf map — agent draws S/D; no bias";
  };
};

export function buildMapBatch(
  store: MapStore,
  opts: {
    symbols: string[];
    dbPath: string;
    now?: number;
    limits?: Partial<MapLimits>;
  },
): SnapshotMapBatch {
  const now = opts.now ?? Date.now();
  const maps = opts.symbols.map((symbol) => buildMap(store, {
    symbol,
    dbPath: opts.dbPath,
    now,
    limits: opts.limits,
  }));
  return {
    ts: now,
    maps,
    meta: {
      db: opts.dbPath,
      count: maps.length,
      note: "htf map — agent draws S/D; no bias",
    },
  };
}

function mapUsage(): never {
  console.log(`Usage:
  bun run map [SYMBOL ...]
  bun run map --symbols BTCUSDT,ETHUSDT,SOLUSDT

HTF snapshot for MAP (ticker + 4H/1H + daily if backfilled).
One symbol → one object. Several → { maps: [...] }. Cap ${MAP_SYMBOL_CAP}.
No 15m, no S/D, no bias. Default SYMBOL is BTCUSDT.
`);
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function parseMapArgs(argv: string[]): { symbols: string[] } {
  if (argv.includes("--help") || argv.includes("-h")) mapUsage();
  const fromFlag = parseMapSymbols(flag(argv, "--symbols"));
  const positionals = argv.filter((arg) => !arg.startsWith("-") && arg !== flag(argv, "--symbols"));
  const fromPos = parseMapSymbols(positionals.join(","));
  const symbols = fromFlag.length > 0 ? fromFlag : fromPos;
  if (symbols.length === 0) return { symbols: [normalizeBriefSymbol(null)] };
  if (symbols.length > MAP_SYMBOL_CAP) mapUsage();
  return { symbols };
}

async function main(): Promise<void> {
  const { symbols } = parseMapArgs(process.argv.slice(2));
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
    const body = symbols.length === 1
      ? buildMap(store, { symbol: symbols[0], dbPath: config.dbPath })
      : buildMapBatch(store, { symbols, dbPath: config.dbPath });
    console.log(JSON.stringify(body, null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
