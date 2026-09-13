import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applySqliteMemoryPragmas, reclaimWal } from "../sqlite";

export type ExecSpecRow = { asOfTs: number; payload: unknown };

export type ExecDb = ReturnType<typeof openExecDb>;

export function openExecDb(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  applySqliteMemoryPragmas(db, true);
  db.exec(`
    CREATE TABLE IF NOT EXISTS exec_spec (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      as_of_ts INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exec_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT
    );
  `);
  reclaimWal(db);

  const insertEvent = db.prepare(`
    INSERT INTO exec_events (ts, kind, detail) VALUES (?, ?, ?)
  `);
  const upsertSpec = db.prepare(`
    INSERT INTO exec_spec (id, as_of_ts, payload) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET as_of_ts = excluded.as_of_ts, payload = excluded.payload
  `);
  const selectSpec = db.prepare(`SELECT as_of_ts, payload FROM exec_spec WHERE id = 1`);
  const selectEvents = db.prepare(`SELECT id, ts, kind, detail FROM exec_events ORDER BY id DESC LIMIT ?`);

  return {
    dbPath,
    close() {
      reclaimWal(db);
      db.close();
    },
    loadSpec(): ExecSpecRow | null {
      const row = selectSpec.get() as { as_of_ts: number; payload: string } | null;
      if (!row) return null;
      return { asOfTs: row.as_of_ts, payload: JSON.parse(row.payload) as unknown };
    },
    saveSpec(asOfTs: number, payload: unknown) {
      upsertSpec.run(asOfTs, JSON.stringify(payload));
    },
    recordEvent(kind: string, detail?: unknown) {
      insertEvent.run(Date.now(), kind, detail == null ? null : JSON.stringify(detail));
    },
    events(limit = 50) {
      const rows = selectEvents.all(limit) as Array<{
        id: number;
        ts: number;
        kind: string;
        detail: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: row.kind,
        detail: row.detail == null ? null : (JSON.parse(row.detail) as unknown),
      }));
    },
  };
}
