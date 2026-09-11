import { resolve } from "node:path";
import { assertNoApiKeys, loadPaperConfig } from "../paper/config";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { PaperSafetyError } from "../paper/errors";

function strEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer env ${name}=${raw}`);
  return n;
}

function assertDistinctPath(a: string, b: string, message: string): void {
  if (resolve(a) === resolve(b)) throw new PaperSafetyError(message);
}

export type LiveConfig = {
  httpHost: string;
  httpPort: number;
  dbPath: string;
  feedUrl: string;
  tickMs: number;
  minRr: string | null;
};

export function liveEnabled(): boolean {
  return process.env.LIVE_SHADOW !== "0";
}

export async function loadLiveConfig(): Promise<LiveConfig> {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feed = await loadFeedConfig();
  const dbPath = resolve(strEnv("LIVE_DB_PATH") ?? "./data/live-shadow.sqlite");
  assertDistinctPath(dbPath, paper.dbPath, `LIVE_DB_PATH must not equal PAPER_DB_PATH (${resolve(dbPath)})`);
  assertDistinctPath(dbPath, feed.dbPath, `LIVE_DB_PATH must not equal BYBIT_DB_PATH (${resolve(dbPath)})`);
  assertDistinctPath(paper.dbPath, feed.dbPath, `PAPER_DB_PATH must not equal BYBIT_DB_PATH (${resolve(paper.dbPath)})`);
  return {
    httpHost: strEnv("LIVE_HTTP_HOST") ?? "127.0.0.1",
    httpPort: intEnv("LIVE_HTTP_PORT") ?? 43182,
    dbPath,
    feedUrl: strEnv("LIVE_FEED_URL") ?? paper.feedUrl ?? "http://127.0.0.1:43180",
    tickMs: intEnv("LIVE_TICK_MS") ?? 400,
    minRr: strEnv("LIVE_MIN_RR") ?? paper.account.minRr,
  };
}
