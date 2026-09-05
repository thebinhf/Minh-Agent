import { resolve } from "node:path";
import type { TrackerConfig } from "./types";

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
  };
}
