import { resolve } from "node:path";
import { decisionLogFile } from "./decision-log";
import {
  corpusDbPath,
  formatCorpusSummary,
  ingestDecisionFile,
  openCorpusDb,
  summarizeCorpus,
} from "./corpus";

export type AgentArgs = { name: "corpus" | "help"; file: string | null; db: string | null; days: number; json: boolean };

const USAGE = `usage: bun run agent corpus [--file <decisions.jsonl>] [--db <sqlite>] [--days N] [--json]
       default file = $MINH_DECISION_FILE or data/decisions.jsonl
       default db   = $MINH_DECISION_DB or data/decisions.sqlite
       --days N counts back from the newest decision, not from today
make one: MINH_DECISION_FILE=data/decisions.jsonl bun run paper replay-map --days 180 --one-book
`;

export function parseAgentArgs(argv: string[]): AgentArgs {
  const out: AgentArgs = { name: "help", file: null, db: null, days: 90, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "corpus") out.name = "corpus";
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.name = "help";
    else if (arg === "--file") out.file = String(argv[++i] ?? "");
    else if (arg === "--db") out.db = String(argv[++i] ?? "");
    else if (arg === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--days needs a number >= 1");
      out.days = Math.floor(n);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

export async function runAgent(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  let args: AgentArgs;
  try {
    args = parseAgentArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${USAGE}`);
    return 2;
  }
  if (args.name === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const file = resolve(args.file ?? decisionLogFile() ?? "data/decisions.jsonl");
  const dbPath = args.db ? resolve(args.db) : corpusDbPath();
  const handle = Bun.file(file);
  if (!(await handle.exists())) {
    process.stderr.write(`no decision file at ${file}\n${USAGE}`);
    return 1;
  }
  const corpus = openCorpusDb(dbPath);
  try {
    const ingest = await ingestDecisionFile(corpus, file);
    const summary = summarizeCorpus(corpus, args.days);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ db: dbPath, ingest, summary }, null, 2)}\n`);
    } else {
      process.stdout.write(`ingest ${ingest.file}: ${ingest.parsed} parsed, ${ingest.inserted} new, ${ingest.skippedUnparseable} unparseable\n`);
      if (ingest.verdictConflicts > 0) {
        process.stdout.write(
          `WARNING ${ingest.verdictConflicts} card-closes already had a different verdict in this db and kept the first.`
          + ` One walk re-evaluates a standing card, which is normal; two flag arms in one db is not — give each arm its own --db\n`,
        );
      }
      process.stdout.write(formatCorpusSummary(summary));
    }
  } finally {
    corpus.close();
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runAgent();
}
