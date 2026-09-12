import { loadConfig } from "./config";
import { openDb, type TrackerDb } from "./db";
import { readBriefKlines, type BriefStore } from "./brief";
import type { KlineLagStore, KlineLagSummary } from "./health";
import {
  MAP_LAG_INTERVALS,
  MAP_SYMBOL_CAP,
  klineLagForSymbols,
  parseMapSymbols,
  resolveMapSymbols,
} from "./map";
import {
  ZONE_KLINE_LIMITS,
  intervalMsForTf,
  parseZoneInterval,
  type ZoneInterval,
} from "../../zones/detect";
import { detectAllSetupsFromKlines } from "../../zones/setups";
import type { ZoneCard } from "../../zones/card";

export const ZONE_SUGGEST_NOTE = "suggest-only zone-cards from local klines — no auto-arm, no auto S/D";

export type SnapshotZones = {
  ts: number;
  symbols: string[];
  interval: ZoneInterval;
  zones: ZoneCard[];
  klineLag: KlineLagSummary;
  meta: {
    db: string;
    limits: { "240": number; "60": number };
    suggestOnly: true;
    autoArm: false;
    note: typeof ZONE_SUGGEST_NOTE;
  };
};

export type ZonesStore = BriefStore & KlineLagStore;

export function emptyZones(
  symbols: string[],
  dbPath: string,
  ts: number,
  interval: ZoneInterval = "240",
): SnapshotZones {
  return {
    ts,
    symbols,
    interval,
    zones: [],
    klineLag: {
      ok: true,
      staleMs: 0,
      intervals: [...MAP_LAG_INTERVALS],
      rows: [],
    },
    meta: {
      db: dbPath,
      limits: { ...ZONE_KLINE_LIMITS },
      suggestOnly: true,
      autoArm: false,
      note: ZONE_SUGGEST_NOTE,
    },
  };
}

export function buildZones(
  store: ZonesStore,
  opts: {
    symbols: string[];
    dbPath: string;
    interval?: string | null;
    now?: number;
  },
): SnapshotZones {
  const interval = parseZoneInterval(opts.interval);
  if (interval == null) {
    throw new Error("zones_interval");
  }
  const symbols = opts.symbols.map((item) => item.trim().toUpperCase()).filter(Boolean);
  const now = opts.now ?? Date.now();
  const body = emptyZones(symbols, opts.dbPath, now, interval);
  body.klineLag = klineLagForSymbols(store, symbols, { now });
  const limit = ZONE_KLINE_LIMITS[interval];
  const intervalMs = intervalMsForTf(interval);
  const zones: ZoneCard[] = [];
  for (const symbol of symbols) {
    const klines = readBriefKlines(store, symbol, interval, limit);
    zones.push(...detectAllSetupsFromKlines(klines, { symbol, tf: interval, intervalMs }));
  }
  zones.sort((a, b) => b.baseStartTs - a.baseStartTs || a.zoneId.localeCompare(b.zoneId));
  body.zones = zones;
  return body;
}

function zonesUsage(): never {
  console.log(`Usage:
  bun run zones
  bun run zones [SYMBOL ...]
  bun run zones --symbols BTCUSDT,ETHUSDT [--interval 240|60]

Suggest-only zone-cards from local HTF klines (default 4H).
No args → feed watchlist (cap ${MAP_SYMBOL_CAP}). Does not arm, open, or limit.
Paper still needs bun run paper arm … --zone-id ID after you choose.
`);
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function parseZonesArgs(argv: string[]): { symbols: string[]; interval: ZoneInterval } {
  if (argv.includes("--help") || argv.includes("-h")) zonesUsage();
  const interval = parseZoneInterval(flag(argv, "--interval"));
  if (interval == null) zonesUsage();
  const fromFlag = parseMapSymbols(flag(argv, "--symbols"));
  const positionals = argv.filter((arg) => (
    !arg.startsWith("-") && arg !== flag(argv, "--symbols") && arg !== flag(argv, "--interval")
  ));
  const fromPos = parseMapSymbols(positionals.join(","));
  const symbols = fromFlag.length > 0 ? fromFlag : fromPos;
  if (symbols.length > MAP_SYMBOL_CAP) zonesUsage();
  return { symbols, interval };
}

async function main(): Promise<void> {
  const parsed = parseZonesArgs(process.argv.slice(2));
  const config = await loadConfig();
  const symbols = resolveMapSymbols(parsed.symbols, config.symbols ?? []);
  if (symbols.length > MAP_SYMBOL_CAP) zonesUsage();
  let store: TrackerDb;
  try {
    store = openDb(config.dbPath, true);
  } catch (error) {
    console.error(`Cannot open ${config.dbPath}. Is the tracker running?`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  try {
    const body = buildZones(store, {
      symbols,
      dbPath: config.dbPath,
      interval: parsed.interval,
    });
    console.log(JSON.stringify(body, null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
