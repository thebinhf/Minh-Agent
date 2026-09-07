import { resolve } from "node:path";
import { PaperSafetyError } from "./errors";
import type { PaperAccountSeed, PaperConfig } from "./types";

const DEFAULT_CONFIG_PATH = resolve(import.meta.dir, "config.json");

const KEY_ENV_NAMES = [
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET",
  "BYBIT_SECRET_KEY",
  "BYBIT_SECRET",
  "BYBIT_APIKEY",
] as const;

function strEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : raw;
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

function looksLikeKeyEnv(name: string): boolean {
  if ((KEY_ENV_NAMES as readonly string[]).includes(name)) return true;
  return /^BYBIT_.*(?:API_KEY|API_SECRET|SECRET_KEY|APIKEY)$/i.test(name);
}

/** Paper never uses keys. Presence of key-like Bybit env vars is a hard refuse. */
export function forbiddenKeyEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((name) => {
    const value = env[name];
    if (value === undefined || value === "") return false;
    return looksLikeKeyEnv(name);
  }).sort();
}

export function assertNoApiKeys(env: NodeJS.ProcessEnv = process.env): void {
  const names = forbiddenKeyEnvNames(env);
  if (names.length === 0) return;
  throw new PaperSafetyError(
    `paper never uses API keys; refuse to start because ${names.join(", ")} is set`,
  );
}

export function assertSeparateDb(paperDbPath: string, feedDbPath: string): void {
  if (resolve(paperDbPath) === resolve(feedDbPath)) {
    throw new PaperSafetyError(
      `PAPER_DB_PATH must not equal BYBIT_DB_PATH (${resolve(paperDbPath)})`,
    );
  }
}

function normalizeAccount(raw: PaperAccountSeed): PaperAccountSeed {
  return {
    name: raw.name,
    quote: raw.quote,
    startingCash: raw.startingCash,
    riskPctMin: raw.riskPctMin,
    riskPctMax: raw.riskPctMax,
    defaultRiskPct: raw.defaultRiskPct,
    minRr: raw.minRr === undefined || raw.minRr === "" ? null : raw.minRr,
    feeRate: raw.feeRate ?? "0",
    makerFeeRate: raw.makerFeeRate ?? "0.0002",
    leverageMin: raw.leverageMin ?? "1",
    leverageMax: raw.leverageMax ?? "25",
    defaultLeverage: raw.defaultLeverage ?? "1",
    mmRate: raw.mmRate ?? "0.005",
    marginMode: raw.marginMode === "cross" ? "cross" : "isolated",
  };
}

export async function loadPaperConfig(
  configPath = process.env.PAPER_CONFIG ?? DEFAULT_CONFIG_PATH,
): Promise<PaperConfig> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`Missing paper config file: ${configPath}`);
  }
  const base = (await file.json()) as PaperConfig;
  const dbPath = strEnv("PAPER_DB_PATH") ?? base.dbPath;
  return {
    httpHost: strEnv("PAPER_HTTP_HOST") ?? base.httpHost,
    httpPort: intEnv("PAPER_HTTP_PORT") ?? base.httpPort,
    dbPath: resolve(process.cwd(), dbPath),
    feedUrl: (strEnv("PAPER_FEED_URL") ?? base.feedUrl).replace(/\/$/, ""),
    staleMs: intEnv("PAPER_STALE_MS") ?? base.staleMs,
    tickMs: intEnv("PAPER_TICK_MS") ?? base.tickMs ?? 400,
    account: normalizeAccount(base.account),
  };
}
