import { loadConfig } from "../feed/bb/config";
import { openDb, type TrackerDb } from "../feed/bb/db";
import { normalizeBriefSymbol } from "../feed/bb/brief";
import { parseTaInterval } from "./catalog";
import { buildTa, parseTaAsof } from "./snapshot";

function usage(): never {
  console.log(`Usage:
  bun run ta
  bun run ta [SYMBOL]
  bun run ta --symbol BTCUSDT --interval 240 --asof 2026-08-01T00:00:00.000Z

Overlay pack from local klines (22 methods). Not a signal. Does not arm.
Default interval 240. ICT labels are confirm, not detectors. Missing ≠ 0.
`);
  process.exit(2);
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function parseTaArgs(argv: string[]): { symbol: string; interval: string; asofRaw: string | undefined } {
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const symbol = normalizeBriefSymbol(flag(argv, "--symbol") ?? argv.find((arg) => !arg.startsWith("-")) ?? null);
  const interval = flag(argv, "--interval") ?? "240";
  if (typeof parseTaInterval(interval) === "object") usage();
  return { symbol, interval, asofRaw: flag(argv, "--asof") };
}

async function main(): Promise<void> {
  const parsed = parseTaArgs(process.argv.slice(2));
  const asof = parseTaAsof(parsed.asofRaw);
  if (typeof asof === "object") {
    console.error("bad --asof");
    process.exit(2);
  }
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
    const body = buildTa(store, {
      symbol: parsed.symbol,
      interval: parsed.interval,
      asof,
      dbPath: config.dbPath,
    });
    console.log(JSON.stringify(body, null, 2));
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
