import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertExecMode, ExecSafetyError, type ExecMode } from "../exec-mode";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { assertSeparateDb, forbiddenKeyEnvNames, loadPaperConfig } from "../paper/config";
import { bybitBaseUrl } from "./client";

const KEY_FILE_NAMES = ["bybit_api_key", "bybit_api_secret"] as const;
const ACCOUNT_TYPES = ["UNIFIED", "CONTRACT", "SPOT", "FUND"] as const;

export type ExecConfig = {
  mode: ExecMode;
  baseUrl: string;
  httpHost: string;
  httpPort: number;
  dbPath: string;
  apiKey: string;
  apiSecret: string;
  accountType: string;
  specMaxAgeHours: number;
};

function strEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

function intEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer env ${name}=${raw}`);
  return n;
}

function readTrimmedFile(path: string): string {
  if (!existsSync(path)) throw new ExecSafetyError(`exec key file not found: ${path}`);
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) throw new ExecSafetyError(`exec key file is empty: ${path}`);
  return raw;
}

/**
 * Keys come from credential files only — systemd `LoadCredential=` maps sources
 * into $CREDENTIALS_DIRECTORY. Plaintext key env vars are refused even though
 * exec is the one process allowed to hold keys.
 */
function readCredentials(env: NodeJS.ProcessEnv): { apiKey: string; apiSecret: string } {
  const keyFile = strEnv(env, "EXEC_KEY_FILE");
  const secretFile = strEnv(env, "EXEC_KEY_SECRET_FILE");
  if (keyFile || secretFile) {
    if (!keyFile || !secretFile) {
      throw new ExecSafetyError("EXEC_KEY_FILE and EXEC_KEY_SECRET_FILE must be set together");
    }
    return { apiKey: readTrimmedFile(keyFile), apiSecret: readTrimmedFile(secretFile) };
  }
  const credDir = strEnv(env, "CREDENTIALS_DIRECTORY");
  if (credDir) {
    return {
      apiKey: readTrimmedFile(resolve(credDir, KEY_FILE_NAMES[0])),
      apiSecret: readTrimmedFile(resolve(credDir, KEY_FILE_NAMES[1])),
    };
  }
  throw new ExecSafetyError(
    "exec reads keys from credential files, never env: set EXEC_KEY_FILE/EXEC_KEY_SECRET_FILE or systemd LoadCredential= (CREDENTIALS_DIRECTORY with bybit_api_key / bybit_api_secret)",
  );
}

export async function loadExecConfig(env: NodeJS.ProcessEnv = process.env): Promise<ExecConfig> {
  const mode = assertExecMode(env);
  const keyEnv = forbiddenKeyEnvNames(env);
  if (keyEnv.length > 0) {
    throw new ExecSafetyError(
      `exec reads keys from credential files, never plaintext env; refuse to start because ${keyEnv.join(", ")} is set`,
    );
  }
  const { apiKey, apiSecret } = readCredentials(env);
  const override = strEnv(env, "EXEC_BASE_URL");
  if (override && mode === "mainnet") {
    throw new ExecSafetyError("EXEC_BASE_URL is a testnet-only override; mainnet always uses the official host");
  }
  const baseUrl = override ?? bybitBaseUrl(mode);
  const accountType = strEnv(env, "EXEC_ACCOUNT_TYPE") ?? "UNIFIED";
  if (!(ACCOUNT_TYPES as readonly string[]).includes(accountType)) {
    throw new ExecSafetyError(`EXEC_ACCOUNT_TYPE must be one of ${ACCOUNT_TYPES.join("|")} (got ${accountType})`);
  }
  const dbPath = resolve(strEnv(env, "EXEC_DB_PATH") ?? "./data/exec.sqlite");
  const paper = await loadPaperConfig();
  const feed = await loadFeedConfig();
  const liveDbPath = resolve(strEnv(env, "LIVE_DB_PATH") ?? "./data/live-shadow.sqlite");
  assertSeparateDb(dbPath, paper.dbPath, feed.dbPath, liveDbPath);
  return {
    mode,
    baseUrl,
    httpHost: strEnv(env, "EXEC_HTTP_HOST") ?? "127.0.0.1",
    httpPort: intEnv(env, "EXEC_HTTP_PORT") ?? 43183,
    dbPath,
    apiKey,
    apiSecret,
    accountType,
    specMaxAgeHours: intEnv(env, "EXEC_SPEC_MAX_AGE_HOURS") ?? 168,
  };
}
