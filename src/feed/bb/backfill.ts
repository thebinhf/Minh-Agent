import { loadConfig } from "./config";
import { openDb } from "./db";
import { decodeDumpBytes, inferDumpMeta, parseKlineDump } from "./dump";
import { parseTimeArg } from "./recovery";
import { fillKlineHistory, probeRestHosts, type RestFetch } from "./rest";
import { PA_KLINE_INTERVALS, type TrackerConfig } from "./types";

export type BackfillSource = "rest" | { file: string };

export type BackfillOptions = {
  source: BackfillSource;
  symbols: string[];
  intervals: string[];
  start: number;
  end: number;
  now?: number;
  fetchImpl?: RestFetch;
  signal?: AbortSignal;
};

function usage(): never {
  console.log(`Usage:
  bun run backfill [--from rest] [--symbol BTCUSDT,ETHUSDT] [--interval 15,60,240] [--days N]
  bun run backfill --from ./klines.json --symbol BTCUSDT --interval 15
  bun run backfill --from https://public.bybit.com/kline_for_metatrader4/BTCUSDT/2025/BTCUSDT_15_2025-01-01_2025-01-31.csv.gz
  bun run backfill --probe

Public linear klines only. No API keys. Live WS is not started.

  --from rest|PATH|URL   REST (default) or a JSON/CSV dump (gzip ok)
  --symbol LIST          default: config symbols
  --interval LIST        default: 15,60,240
  --days N               lookback from --end (default: retention.klinesDays)
  --start TIME           epoch ms or ISO
  --end TIME             epoch ms or ISO (default: now)
  --probe                print which public REST hosts answer /v5/market/time
`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function csvArg(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export function parseBackfillArgs(
  argv: string[],
  config: TrackerConfig,
  now = Date.now(),
): BackfillOptions | { probe: true } {
  if (argv.includes("--help") || argv.includes("-h")) usage();
  if (argv.includes("--probe")) return { probe: true };

  const from = flag(argv, "--from") ?? "rest";
  const symbols = csvArg(flag(argv, "--symbol") ?? flag(argv, "--symbols")) ?? config.symbols;
  const intervals = csvArg(flag(argv, "--interval") ?? flag(argv, "--intervals"))
    ?? [...PA_KLINE_INTERVALS];
  const end = flag(argv, "--end") ? parseTimeArg(flag(argv, "--end")!) : now;
  const startRaw = flag(argv, "--start");
  const daysRaw = flag(argv, "--days");
  const days = daysRaw !== undefined ? Number(daysRaw) : config.retention.klinesDays;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid --days ${daysRaw}`);
  }
  const start = startRaw ? parseTimeArg(startRaw) : end - days * 86_400_000;
  if (start >= end) {
    throw new Error("--start must be earlier than --end");
  }

  return {
    source: from === "rest" ? "rest" : { file: from },
    symbols,
    intervals,
    start,
    end,
    now,
  };
}

export async function runBackfill(
  config: TrackerConfig,
  store: Pick<ReturnType<typeof openDb>, "saveKline" | "setMeta" | "klineStats">,
  options: BackfillOptions,
): Promise<{ series: number; candles: number; errors: number; source: string; host?: string }> {
  const now = options.now ?? Date.now();
  if (options.source === "rest") {
    const result = await fillKlineHistory(config, store, {
      symbols: options.symbols,
      intervals: options.intervals,
      start: options.start,
      end: options.end,
      now,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
    store.setMeta("last_backfill", JSON.stringify({
      ...result,
      source: "rest",
      start: options.start,
      end: options.end,
      ts: now,
    }));
    return { ...result, source: "rest" };
  }

  const dump = await loadDump(options.source.file, options.symbols, options.intervals, now);
  let candles = 0;
  for (const candle of dump.candles) {
    store.saveKline(dump.symbol, candle, now);
    candles += 1;
  }
  const result = { series: 1, candles, errors: 0, source: options.source.file };
  store.setMeta("last_backfill", JSON.stringify({ ...result, ts: now }));
  return result;
}

async function loadDump(
  spec: string,
  symbols: string[],
  intervals: string[],
  now: number,
): Promise<{ symbol: string; candles: ReturnType<typeof parseKlineDump>["candles"] }> {
  const inferred = inferDumpMeta(spec);
  const bytes = await readDumpBytes(spec);
  const interval = (intervals.length === 1 ? intervals[0] : undefined)
    ?? inferred.interval
    ?? intervals[0];
  const parsed = parseKlineDump(decodeDumpBytes(bytes), {
    interval: interval ?? "",
    now,
    symbol: symbols.length === 1 ? symbols[0] : inferred.symbol,
  });
  const symbol = (symbols.length === 1 ? symbols[0] : undefined) ?? parsed.symbol ?? inferred.symbol;
  const resolvedInterval = interval || parsed.interval;
  if (!symbol || !resolvedInterval) {
    throw new Error("Dump needs --symbol and --interval (or a Bybit filename like BTCUSDT_15_....csv)");
  }
  const candles = parsed.candles.map((candle) => ({ ...candle, interval: resolvedInterval }));
  return { symbol, candles };
}

async function readDumpBytes(spec: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(spec)) {
    const res = await fetch(spec);
    if (!res.ok) {
      throw new Error(`Dump URL HTTP ${res.status}: ${spec}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  const file = Bun.file(spec);
  if (!(await file.exists())) {
    throw new Error(`Dump not found: ${spec}`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const parsed = parseBackfillArgs(process.argv.slice(2), config);

  if ("probe" in parsed) {
    const results = await probeRestHosts(config);
    console.log(JSON.stringify({ results }, null, 2));
    const ok = results.some((row) => row.ok);
    if (!ok) {
      console.error("[minh:bb] no public REST host answered. Use --from JSON/CSV dump.");
      process.exit(1);
    }
    return;
  }

  const days = Math.round((parsed.end - parsed.start) / 86_400_000);
  if (days > config.retention.klinesDays) {
    console.warn(
      `[minh:bb] backfill window ${days}d exceeds retention.klinesDays=${config.retention.klinesDays}. ` +
        `Tracker prune will drop older confirmed candles. Set BYBIT_KLINES_DAYS=${days} to keep them.`,
    );
  }

  const store = openDb(config.dbPath);
  try {
    const result = await runBackfill(config, store, parsed);
    const stats = store.klineStats(
      parsed.symbols.length === 1 ? parsed.symbols[0] : undefined,
      parsed.intervals.length === 1 ? parsed.intervals[0] : undefined,
    );
    console.log(JSON.stringify({
      ok: result.errors === 0 && result.candles > 0,
      ...result,
      db: config.dbPath,
      start: parsed.start,
      end: parsed.end,
      stats,
    }, null, 2));
    if (result.errors > 0 || result.candles === 0) {
      if (parsed.source === "rest") {
        console.error("[minh:bb] REST backfill did not finish. Dump klines on a working host and rerun --from <file>.");
      }
      process.exit(1);
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  await main();
}
