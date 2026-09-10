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
import {
  DEFAULT_KLINE_LAG_MS,
  buildKlineLag,
  type KlineLagStore,
  type KlineLagSummary,
} from "./health";
import { buildMapOi, emptyMapOi, type MapOi, type OiStore } from "./oi";
import { buildMapFunding, emptyMapFunding, type FundingStore, type MapFunding } from "./funding";

/** HTF-only windows for MAP. No 15m — that stays on /brief and /chart. */
export const MAP_KLINE_LIMITS = {
  "240": 20,
  "60": 24,
  D: 30,
} as const;

/** Full public watchlist (10). One GET /map at 4H close. */
export const MAP_SYMBOL_CAP = 10;

/** Lag that blocks drawing HTF zones. 15m is EVENT /confirm, not MAP. */
export const MAP_LAG_INTERVALS = ["60", "240"] as const;

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
  klineLag: KlineLagSummary;
  oi: MapOi;
  funding: MapFunding;
  meta: {
    db: string;
    limits: MapLimits;
    note: "htf map — agent draws S/D; no bias";
  };
};

export type MapStore = BriefStore & KlineLagStore & OiStore & FundingStore;

export function emptyKlineLag(staleMs = DEFAULT_KLINE_LAG_MS): KlineLagSummary {
  return {
    ok: true,
    staleMs,
    intervals: [...MAP_LAG_INTERVALS],
    rows: [],
  };
}

export function emptyMap(symbol: string, dbPath: string, ts: number, limits: MapLimits = { ...MAP_KLINE_LIMITS }): SnapshotMap {
  return {
    symbol,
    ts,
    ticker: { ...EMPTY_TICKER },
    klines: { "240": [], "60": [], D: [] },
    klineLag: emptyKlineLag(),
    oi: emptyMapOi(),
    funding: emptyMapFunding(),
    meta: {
      db: dbPath,
      limits,
      note: "htf map — agent draws S/D; no bias",
    },
  };
}

export function klineLagForSymbols(
  store: KlineLagStore,
  symbols: string[],
  opts: { now?: number; staleMs?: number } = {},
): KlineLagSummary {
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  if (want.size === 0) return emptyKlineLag(opts.staleMs);
  const summaries = [...want].map((symbol) => buildKlineLag(store, {
    now: opts.now,
    staleMs: opts.staleMs,
    symbol,
    intervals: MAP_LAG_INTERVALS,
  }));
  const rows = summaries.flatMap((item) => item.rows);
  return {
    ok: rows.every((row) => !row.stale),
    staleMs: summaries[0]?.staleMs ?? DEFAULT_KLINE_LAG_MS,
    intervals: [...MAP_LAG_INTERVALS],
    rows,
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
  map.klineLag = klineLagForSymbols(store, [symbol], { now });
  map.oi = buildMapOi(
    store,
    symbol,
    map.ticker.openInterest,
    map.klines["240"].map((bar) => bar.close),
  );
  map.funding = buildMapFunding(store, symbol, {
    fundingRate: map.ticker.fundingRate,
    nextFundingTime: map.ticker.nextFundingTime,
  });
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
  klineLag: KlineLagSummary;
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
    klineLag: klineLagForSymbols(store, opts.symbols, { now }),
    meta: {
      db: opts.dbPath,
      count: maps.length,
      note: "htf map — agent draws S/D; no bias",
    },
  };
}

function mapUsage(): never {
  console.log(`Usage:
  bun run map
  bun run map [SYMBOL ...]
  bun run map --symbols BTCUSDT,ETHUSDT,SOLUSDT

HTF snapshot for MAP (ticker + 4H/1H + daily if backfilled + klineLag).
No args → feed watchlist (cap ${MAP_SYMBOL_CAP}). One symbol → one object.
Several → { maps, klineLag }. No 15m, no S/D, no bias.
`);
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

/** Empty symbols → caller uses the feed watchlist. */
export function parseMapArgs(argv: string[]): { symbols: string[] } {
  if (argv.includes("--help") || argv.includes("-h")) mapUsage();
  const fromFlag = parseMapSymbols(flag(argv, "--symbols"));
  const positionals = argv.filter((arg) => !arg.startsWith("-") && arg !== flag(argv, "--symbols"));
  const fromPos = parseMapSymbols(positionals.join(","));
  const symbols = fromFlag.length > 0 ? fromFlag : fromPos;
  if (symbols.length > MAP_SYMBOL_CAP) mapUsage();
  return { symbols };
}

export function resolveMapSymbols(listed: string[], watchlist: string[]): string[] {
  const symbols = listed.length > 0 ? listed : parseMapSymbols(watchlist.join(","));
  if (symbols.length === 0) return [normalizeBriefSymbol(null)];
  return symbols;
}

async function main(): Promise<void> {
  const parsed = parseMapArgs(process.argv.slice(2));
  const config = await loadConfig();
  const symbols = resolveMapSymbols(parsed.symbols, config.symbols ?? []);
  if (symbols.length > MAP_SYMBOL_CAP) mapUsage();
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
