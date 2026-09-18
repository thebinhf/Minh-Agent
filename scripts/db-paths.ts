/**
 * Print the mesh's SQLite paths, one per line, resolved through the same
 * loaders each process boots with.
 *
 * A backup script that guesses these paths silently skips the DB it was
 * written to protect: `deploy/backup-db.sh` used `/var/lib/...` defaults while
 * the configs resolve `./data/...`, so the market cache never got snapshotted
 * and the operator saw a green run. Ask the config, not the docs.
 *
 *   bun run scripts/db-paths.ts
 */
import { existsSync } from "node:fs";
import { loadConfig as loadFeedConfig } from "../src/feed/bb/config";
import { loadPaperConfig } from "../src/paper/config";
import { loadLiveConfig } from "../src/live/config";
import { loadExecConfig } from "../src/exec/config";

const rows: Array<{ label: string; path: string }> = [];

async function collect(label: string, get: () => Promise<{ dbPath: string }>): Promise<void> {
  try {
    const cfg = await get();
    rows.push({ label, path: cfg.dbPath });
  } catch (error) {
    // A process that cannot resolve its own config is not a reason to back up
    // half the mesh quietly — name it and keep going so the operator sees all
    // four labels, then exit non-zero if nothing resolves.
    process.stderr.write(
      `[minh:db-paths] ${label}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

await collect("feed", loadFeedConfig);
await collect("paper", loadPaperConfig);
await collect("live-shadow", loadLiveConfig);
await collect("exec", async () => ({ dbPath: (await loadExecConfig()).dbPath }));

if (rows.length === 0) {
  process.stderr.write("[minh:db-paths] no database path resolved\n");
  process.exit(1);
}
for (const row of rows) {
  if (!existsSync(row.path)) {
    process.stderr.write(`[minh:db-paths] ${row.label}: ${row.path} does not exist yet\n`);
    continue;
  }
  process.stdout.write(`${row.path}\n`);
}
