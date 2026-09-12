import { loadConfig } from "../feed/bb/config";
import { openDb, type TrackerDb } from "../feed/bb/db";
import { MAP_SYMBOL_CAP, parseMapSymbols, resolveMapSymbols } from "../feed/bb/map";
import { parseTimeArg } from "../feed/bb/recovery";
import { FEATURES_SCAN_DAYS_MAX, scanFeatures, scanWindow } from "./scan";
import { buildFeatures, parseFeaturesAsof } from "./snapshot";

const FEATURES_USAGE = `Usage:
  bun run features [SYMBOL] [--asof ms|ISO]
  bun run features scan [SYMBOL ...] [--days 7] [--from ms|ISO] [--to ms|ISO]

As-of tape + 4H kline shock from the local market DB. Missing stays null.
Does not arm. Scan emits impulse / range_expand / vol_spike / cascade / flow_flip / oi_flush.
`;

function featuresUsage(): never {
  console.log(FEATURES_USAGE);
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function parseDays(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 7;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > FEATURES_SCAN_DAYS_MAX) featuresUsage();
  return n;
}

function parseBound(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  try {
    const n = parseTimeArg(raw);
    if (!Number.isFinite(n) || n <= 0) featuresUsage();
    return n;
  } catch {
    featuresUsage();
  }
}

export function parseFeaturesArgs(argv: string[]):
  | { name: "snapshot"; symbol: string | null; asofRaw: string | null }
  | { name: "scan"; symbols: string[]; days: number; fromRaw: string | null; toRaw: string | null } {
  if (argv.includes("--help") || argv.includes("-h")) featuresUsage();
  if (argv[0] === "scan") {
    const rest = argv.slice(1);
    const fromFlag = parseMapSymbols(flag(rest, "--symbols"));
    const positionals = rest.filter((arg) => (
      !arg.startsWith("-")
      && arg !== flag(rest, "--symbols")
      && arg !== flag(rest, "--days")
      && arg !== flag(rest, "--from")
      && arg !== flag(rest, "--to")
    ));
    const fromPos = parseMapSymbols(positionals.join(","));
    const symbols = fromFlag.length > 0 ? fromFlag : fromPos;
    if (symbols.length > MAP_SYMBOL_CAP) featuresUsage();
    return {
      name: "scan",
      symbols,
      days: parseDays(flag(rest, "--days")),
      fromRaw: flag(rest, "--from") ?? null,
      toRaw: flag(rest, "--to") ?? null,
    };
  }
  const asofRaw = flag(argv, "--asof") ?? null;
  const positionals = argv.filter((arg) => !arg.startsWith("-") && arg !== asofRaw);
  if (positionals.length > 1) featuresUsage();
  return {
    name: "snapshot",
    symbol: positionals[0] ?? null,
    asofRaw,
  };
}

async function withStore<T>(fn: (store: TrackerDb, dbPath: string) => T | Promise<T>): Promise<T> {
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
    return await fn(store, config.dbPath);
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseFeaturesArgs(process.argv.slice(2));
  if (parsed.name === "snapshot") {
    const asof = parseFeaturesAsof(parsed.asofRaw);
    if (typeof asof === "object") {
      console.error(JSON.stringify(asof));
      process.exit(1);
    }
    const body = await withStore((store, dbPath) => (
      buildFeatures(store, { symbol: parsed.symbol, asof, dbPath })
    ));
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (parsed.name === "scan") {
    const config = await loadConfig();
    const symbols = resolveMapSymbols(parsed.symbols, config.symbols ?? []);
    if (symbols.length > MAP_SYMBOL_CAP) featuresUsage();
    const window = scanWindow(parsed.days);
    const fromTs = parseBound(parsed.fromRaw ?? undefined, window.fromTs);
    const toTs = parseBound(parsed.toRaw ?? undefined, window.toTs);
    if (toTs <= fromTs) featuresUsage();
    const body = await withStore((store, dbPath) => (
      scanFeatures(store, {
        symbols,
        dbPath,
        fromTs,
        toTs,
        days: parsed.days,
      })
    ));
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const _never: never = parsed;
  void _never;
  featuresUsage();
}

if (import.meta.main) {
  await main();
}
