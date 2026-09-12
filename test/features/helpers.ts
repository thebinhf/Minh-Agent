import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type TrackerDb } from "../../src/feed/bb/db";

const dirs: string[] = [];
const stores: TrackerDb[] = [];

export function tempMarketDb(prefix: string): { dbPath: string; store: TrackerDb } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  const store = openDb(dbPath);
  stores.push(store);
  return { dbPath, store };
}

function unlinkQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Windows may still hold the handle until process exit.
  }
}

export function cleanupMarketDbs(): void {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    unlinkQuiet(join(dir, "market.sqlite"));
    unlinkQuiet(join(dir, "market.sqlite-wal"));
    unlinkQuiet(join(dir, "market.sqlite-shm"));
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Temp leftover is OK — assertions already ran.
    }
  }
}
