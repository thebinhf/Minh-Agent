import { resolve } from "node:path";
import type { RecoveryConfig, TrackerConfig } from "./types";

/** Documented Japan public REST host. Verified to serve /v5/market/kline from a US cloud VM. */
export const DEFAULT_REST_FALLBACKS = ["https://api.manepa.jp"];

export const DEFAULT_RECOVERY: RecoveryConfig = {
  pongStaleMs: 60_000,
  watchdogIntervalMs: 10_000,
  watchdogGraceMs: 30_000,
  subscribeChunkSize: 10,
  subscribeRetries: 3,
  subscribeRetryDelayMs: 1_000,
  subscribeAckTimeoutMs: 5_000,
  restRetries: 3,
  restRetryDelayMs: 400,
  restTimeoutMs: 10_000,
  gapFill: true,
  klineLagMs: 180_000,
};

const DEFAULT_CONFIG_PATH = resolve(import.meta.dir, "config.json");

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer env ${name}=${raw}`);
  }
  return n;
}

function strEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

export async function loadConfig(
  configPath = process.env.BYBIT_CONFIG ?? DEFAULT_CONFIG_PATH,
): Promise<TrackerConfig> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const base = (await file.json()) as TrackerConfig;
  const dbPath = strEnv("BYBIT_DB_PATH") ?? base.dbPath;

  return {
    ...base,
    endpoint: strEnv("BYBIT_WS_ENDPOINT") ?? base.endpoint,
    restEndpoint: strEnv("BYBIT_REST_ENDPOINT") ?? base.restEndpoint ?? "https://api.bybit.com",
    restFallbacks: restFallbackList(base.restFallbacks),
    httpHost: strEnv("BYBIT_HTTP_HOST") ?? base.httpHost,
    httpPort: intEnv("BYBIT_HTTP_PORT") ?? base.httpPort,
    dbPath: resolve(process.cwd(), dbPath),
    symbols: csv(process.env.BYBIT_SYMBOLS) ?? base.symbols,
    klineIntervals: csv(process.env.BYBIT_KLINE_INTERVALS) ?? base.klineIntervals,
    orderbook: {
      depth: intEnv("BYBIT_ORDERBOOK_DEPTH") ?? base.orderbook.depth,
      symbols: csv(process.env.BYBIT_ORDERBOOK_SYMBOLS) ?? base.orderbook.symbols,
    },
    pingIntervalMs: intEnv("BYBIT_PING_INTERVAL_MS") ?? base.pingIntervalMs,
    retention: {
      ...base.retention,
      klinesDays: intEnv("BYBIT_KLINES_DAYS") ?? base.retention.klinesDays,
      liquidationsHours: intEnv("BYBIT_LIQ_HOURS") ?? base.retention.liquidationsHours ?? 48,
    },
    recovery: {
      ...DEFAULT_RECOVERY,
      ...base.recovery,
      pongStaleMs: intEnv("BYBIT_PONG_STALE_MS") ?? base.recovery?.pongStaleMs ?? DEFAULT_RECOVERY.pongStaleMs,
      klineLagMs: intEnv("BYBIT_KLINE_LAG_MS") ?? base.recovery?.klineLagMs ?? DEFAULT_RECOVERY.klineLagMs,
      gapFill: process.env.BYBIT_GAP_FILL === "0" ? false : (base.recovery?.gapFill ?? DEFAULT_RECOVERY.gapFill),
    },
  };
}

function restFallbackList(fileValue: string[] | undefined): string[] {
  if (process.env.BYBIT_REST_FALLBACKS === "") return [];
  return csv(process.env.BYBIT_REST_FALLBACKS) ?? fileValue ?? DEFAULT_REST_FALLBACKS;
}
