import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { createPaperEngine, type PaperEngine } from "./engine";
import { PaperReject, PaperSafetyError, PaperUsageError } from "./errors";
import { httpFeed } from "./feed";
import type { PaperStatus } from "./types";

export const PAPER_USAGE = `Usage:
  bun run paper account
  bun run paper positions [--status open|closed|all]
  bun run paper open SYMBOL --side long|short --sl PRICE --tp PRICE --tf 240,60,15 [--risk-pct 0.03] [--note TEXT]
  bun run paper close ID
  bun run paper mark

Paper simulation only — no API keys, no real orders.
Fills and marks come from the local feed at 127.0.0.1:43180.
--tf is required (comma-separated, at least two feed intervals).
`;

export type PaperCliCommand =
  | { name: "account" }
  | { name: "positions"; status: PaperStatus | "all" }
  | {
      name: "open";
      symbol: string;
      side: string;
      stopLoss: string;
      takeProfit: string;
      timeframes: string[];
      riskPct?: string;
      note?: string;
    }
  | { name: "close"; id: number }
  | { name: "mark" };

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new PaperUsageError(PAPER_USAGE);
  }
  return value;
}

function hasHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function parsePaperArgs(argv: string[]): PaperCliCommand {
  if (argv.length === 0 || hasHelp(argv)) {
    throw new PaperUsageError(PAPER_USAGE);
  }
  const [command, ...rest] = argv;
  if (command === "account") return { name: "account" };
  if (command === "positions") {
    const status = flag(rest, "--status") ?? "open";
    if (status !== "open" && status !== "closed" && status !== "all") {
      throw new PaperUsageError(PAPER_USAGE);
    }
    return { name: "positions", status };
  }
  if (command === "mark") return { name: "mark" };
  if (command === "close") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) throw new PaperUsageError(PAPER_USAGE);
    return { name: "close", id };
  }
  if (command === "open") {
    const symbol = rest.find((arg) => !arg.startsWith("-"));
    const side = flag(rest, "--side");
    const sl = flag(rest, "--sl");
    const tp = flag(rest, "--tp");
    const tf = flag(rest, "--tf");
    if (!symbol || !side || !sl || !tp || !tf) throw new PaperUsageError(PAPER_USAGE);
    return {
      name: "open",
      symbol,
      side,
      stopLoss: sl,
      takeProfit: tp,
      timeframes: tf.split(",").map((item) => item.trim()).filter(Boolean),
      riskPct: flag(rest, "--risk-pct"),
      note: flag(rest, "--note"),
    };
  }
  throw new PaperUsageError(PAPER_USAGE);
}

export async function runPaperCommand(engine: PaperEngine, command: PaperCliCommand): Promise<unknown> {
  if (command.name === "account") return engine.account();
  if (command.name === "positions") {
    return { mode: "paper", positions: engine.positions(command.status) };
  }
  if (command.name === "mark") return engine.mark();
  if (command.name === "close") return engine.close(command.id);
  return engine.open({
    symbol: command.symbol,
    side: command.side,
    stopLoss: command.stopLoss,
    takeProfit: command.takeProfit,
    timeframes: command.timeframes,
    riskPct: command.riskPct,
    note: command.note,
  });
}

export async function createPaperCliEngine() {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  assertSeparateDb(paper.dbPath, feedCfg.dbPath);
  const store = openPaperDb(paper.dbPath, paper.account);
  const feed = httpFeed(paper.feedUrl);
  const engine = createPaperEngine({
    store,
    feed,
    config: paper,
    universe: { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals },
  });
  return { engine, store, paper };
}

async function main(): Promise<void> {
  let command: PaperCliCommand;
  try {
    command = parsePaperArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof PaperUsageError) {
      console.log(error.message);
      process.exit(2);
    }
    throw error;
  }

  let runtime;
  try {
    runtime = await createPaperCliEngine();
  } catch (error) {
    if (error instanceof PaperSafetyError) {
      console.error(`[minh:paper] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  try {
    const body = await runPaperCommand(runtime.engine, command);
    console.log(JSON.stringify(body, null, 2));
  } catch (error) {
    if (error instanceof PaperReject) {
      console.log(JSON.stringify(error.toJSON(), null, 2));
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    runtime.store.close();
  }
}

if (import.meta.main) {
  await main();
}
