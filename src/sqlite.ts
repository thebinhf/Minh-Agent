import { Database } from "bun:sqlite";

/** Negative cache_size is KiB. 4 MiB page cache — do not grow with DB file. */
export const SQLITE_CACHE_KIB = 4096;
/** ~2 MiB WAL (500 × 4 KiB pages) before autocheckpoint. */
export const SQLITE_WAL_AUTOCHECKPOINT = 500;
/** Hard cap on WAL file bytes. */
export const SQLITE_JOURNAL_SIZE_LIMIT = 8 * 1024 * 1024;

export type WalCheckpoint = {
  busy: number;
  log: number;
  checkpointed: number;
};

export function applySqliteMemoryPragmas(db: Database, writable: boolean): void {
  db.exec(`PRAGMA cache_size = -${SQLITE_CACHE_KIB};`);
  db.exec("PRAGMA mmap_size = 0;");
  if (!writable) return;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT};`);
  db.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT};`);
}

export function walCheckpoint(db: Database, mode: "PASSIVE" | "TRUNCATE"): WalCheckpoint {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  return {
    busy: Number(row?.busy ?? 0),
    log: Number(row?.log ?? 0),
    checkpointed: Number(row?.checkpointed ?? 0),
  };
}

/**
 * PASSIVE first (does not wait on readers). TRUNCATE only when PASSIVE
 * finished — otherwise a 5s busy_timeout would stall HTTP / WS writes.
 */
export function reclaimWal(db: Database): {
  passive: WalCheckpoint;
  truncated: boolean;
  truncate: WalCheckpoint | null;
} {
  const passive = walCheckpoint(db, "PASSIVE");
  if (passive.busy !== 0) {
    db.exec("PRAGMA shrink_memory;");
    return { passive, truncated: false, truncate: null };
  }
  const truncate = walCheckpoint(db, "TRUNCATE");
  db.exec("PRAGMA shrink_memory;");
  return { passive, truncated: truncate.busy === 0, truncate };
}
