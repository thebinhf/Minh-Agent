import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { createPaperEngine, type PaperEngine } from "./engine";
import { PaperReject, PaperSafetyError, PaperUsageError } from "./errors";
import { httpFeed } from "./feed";
import { parseTimeArg } from "../feed/bb/recovery";
import { bindPaperNotify } from "./notify";
import { runReplayFromFeed } from "./replay";
import type { AlertStatus, OrderStatus, PaperStatus } from "./types";

export const PAPER_USAGE = `Usage:
  bun run paper account
  bun run paper positions [--status open|closed|all]
  bun run paper open SYMBOL --side long|short --sl PRICE --tp PRICE --tf 240,60,15 [--risk-pct 0.03] [--note TEXT]
  bun run paper open SYMBOL --side long --sl PRICE --tps PRICE:PCT,PRICE:PCT --tf 240,60,15 [--leverage 10]
  bun run paper limit SYMBOL --side long|short --price PRICE --sl PRICE --tp PRICE --tf 240,60,15 [--cross] [--invalidate PRICE] [--no-oco]
  bun run paper orders [--status pending|filled|cancelled|rejected|invalidated|all]
  bun run paper cancel ID
  bun run paper alert set SYMBOL --above|--below PRICE [--note TEXT]
  bun run paper alert list [--status armed|fired|cancelled|all]
  bun run paper alert cancel ID
  bun run paper events [--limit N]
  bun run paper close ID
  bun run paper mark
  bun run paper replay SYMBOL --from TIME --to TIME --side long|short --price PRICE --sl PRICE --tp PRICE --tf 240,60,15 [--interval 15] [--funding-rate RATE] [--cross] [--invalidate PRICE] [--no-oco]

Paper simulation only — no API keys, no real orders.
Fills and marks come from the local feed at 127.0.0.1:43180.
--tf is required (comma-separated, at least two feed intervals).
--tp or --tps is required. --tps is PRICE:qtyPct pairs that must sum to 1.
limit --price is the resting entry. Default post-only (reject if last already through).
Pass --cross to fill immediately when last is already through the limit.
OCO is on by default: last through --sl (or --invalidate) cancels the pending before fill.
Pass --no-oco to rest even if invalidation prints.
alert fires once when last prints through the level. No mid-watch PnL spam.
Optional notify: PAPER_NOTIFY=telegram|webhook plus token/URL. Event-once only.
replay walks local klines (backfill first). Same OCO/fee/funding engine; slippage 0. Does not touch the live paper ledger.
`;

export type PaperCliCommand =
  | { name: "account" }
  | { name: "positions"; status: PaperStatus | "all" }
  | {
      name: "open";
      symbol: string;
      side: string;
      stopLoss: string;
      takeProfit?: string;
      takeProfits?: Array<{ price: string; qtyPct: string }>;
      timeframes: string[];
      riskPct?: string;
      leverage?: string;
      note?: string;
    }
  | {
      name: "limit";
      symbol: string;
      side: string;
      limitPrice: string;
      stopLoss: string;
      takeProfit?: string;
      takeProfits?: Array<{ price: string; qtyPct: string }>;
      timeframes: string[];
      riskPct?: string;
      leverage?: string;
      note?: string;
      postOnly: boolean;
      oco: boolean;
      invalidatePrice?: string;
    }
  | { name: "orders"; status: OrderStatus | "all" }
  | { name: "cancel"; id: number }
  | { name: "alert-set"; symbol: string; op: "above" | "below"; price: string; note?: string }
  | { name: "alert-list"; status: AlertStatus | "all" }
  | { name: "alert-cancel"; id: number }
  | { name: "events"; limit: number }
  | { name: "close"; id: number }
  | { name: "mark" }
  | {
      name: "replay";
      symbol: string;
      side: string;
      stopLoss: string;
      takeProfit?: string;
      takeProfits?: Array<{ price: string; qtyPct: string }>;
      timeframes: string[];
      riskPct?: string;
      leverage?: string;
      note?: string;
      limitPrice: string;
      postOnly: boolean;
      oco: boolean;
      invalidatePrice?: string;
      fromTs: number;
      toTs: number;
      interval: string;
      fundingRate?: string;
    };

function parseTps(raw: string): Array<{ price: string; qtyPct: string }> {
  return raw.split(",").map((part) => {
    const [price, qtyPct] = part.split(":");
    if (!price?.trim() || !qtyPct?.trim()) {
      throw new PaperUsageError(PAPER_USAGE);
    }
    return { price: price.trim(), qtyPct: qtyPct.trim() };
  });
}

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

function positionalSymbol(rest: string[]): string | undefined {
  return rest.find((arg) => !arg.startsWith("-"));
}

function parseOpenish(rest: string[]): {
  symbol: string;
  side: string;
  stopLoss: string;
  takeProfit?: string;
  takeProfits?: Array<{ price: string; qtyPct: string }>;
  timeframes: string[];
  riskPct?: string;
  leverage?: string;
  note?: string;
} {
  const symbol = positionalSymbol(rest);
  const side = flag(rest, "--side");
  const sl = flag(rest, "--sl");
  const tp = flag(rest, "--tp");
  const tps = flag(rest, "--tps");
  const tf = flag(rest, "--tf");
  const leverage = flag(rest, "--leverage");
  if (!symbol || !side || !sl || !tf || (!tp && !tps)) throw new PaperUsageError(PAPER_USAGE);
  return {
    symbol,
    side,
    stopLoss: sl,
    ...(tp ? { takeProfit: tp } : {}),
    ...(tps ? { takeProfits: parseTps(tps) } : {}),
    timeframes: tf.split(",").map((item) => item.trim()).filter(Boolean),
    riskPct: flag(rest, "--risk-pct"),
    ...(leverage ? { leverage } : {}),
    note: flag(rest, "--note"),
  };
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
  if (command === "cancel") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) throw new PaperUsageError(PAPER_USAGE);
    return { name: "cancel", id };
  }
  if (command === "orders") {
    const status = flag(rest, "--status") ?? "pending";
    if (
      status !== "pending" && status !== "filled" && status !== "cancelled"
      && status !== "rejected" && status !== "invalidated" && status !== "all"
    ) {
      throw new PaperUsageError(PAPER_USAGE);
    }
    return { name: "orders", status };
  }
  if (command === "events") {
    const limitRaw = flag(rest, "--limit");
    const limit = limitRaw ? Number(limitRaw) : 50;
    if (!Number.isInteger(limit) || limit <= 0) throw new PaperUsageError(PAPER_USAGE);
    return { name: "events", limit };
  }
  if (command === "alert") {
    const [sub, ...alertRest] = rest;
    if (sub === "list") {
      const status = flag(alertRest, "--status") ?? "armed";
      if (status !== "armed" && status !== "fired" && status !== "cancelled" && status !== "all") {
        throw new PaperUsageError(PAPER_USAGE);
      }
      return { name: "alert-list", status };
    }
    if (sub === "cancel") {
      const id = Number(alertRest[0]);
      if (!Number.isInteger(id) || id <= 0) throw new PaperUsageError(PAPER_USAGE);
      return { name: "alert-cancel", id };
    }
    if (sub === "set") {
      const symbol = positionalSymbol(alertRest);
      const above = flag(alertRest, "--above");
      const below = flag(alertRest, "--below");
      if (!symbol || (!above && !below) || (above && below)) throw new PaperUsageError(PAPER_USAGE);
      return {
        name: "alert-set",
        symbol,
        op: above ? "above" : "below",
        price: (above ?? below)!,
        note: flag(alertRest, "--note"),
      };
    }
    throw new PaperUsageError(PAPER_USAGE);
  }
  if (command === "open") {
    return { name: "open", ...parseOpenish(rest) };
  }
  if (command === "limit") {
    const price = flag(rest, "--price");
    if (!price) throw new PaperUsageError(PAPER_USAGE);
    return {
      name: "limit",
      ...parseOpenish(rest),
      limitPrice: price,
      postOnly: !rest.includes("--cross"),
      oco: !rest.includes("--no-oco"),
      invalidatePrice: flag(rest, "--invalidate"),
    };
  }
  if (command === "replay") {
    const price = flag(rest, "--price");
    const fromRaw = flag(rest, "--from");
    const toRaw = flag(rest, "--to");
    if (!price || !fromRaw || !toRaw) throw new PaperUsageError(PAPER_USAGE);
    let fromTs: number;
    let toTs: number;
    try {
      fromTs = parseTimeArg(fromRaw);
      toTs = parseTimeArg(toRaw);
    } catch {
      throw new PaperUsageError(PAPER_USAGE);
    }
    return {
      name: "replay",
      ...parseOpenish(rest),
      limitPrice: price,
      postOnly: !rest.includes("--cross"),
      oco: !rest.includes("--no-oco"),
      invalidatePrice: flag(rest, "--invalidate"),
      fromTs,
      toTs,
      interval: flag(rest, "--interval") ?? "15",
      fundingRate: flag(rest, "--funding-rate"),
    };
  }
  throw new PaperUsageError(PAPER_USAGE);
}

export async function runPaperCommand(engine: PaperEngine, command: PaperCliCommand): Promise<unknown> {
  if (command.name === "account") return engine.account();
  if (command.name === "positions") {
    return { mode: "paper", positions: engine.positions(command.status) };
  }
  if (command.name === "orders") {
    return { mode: "paper", orders: engine.orders(command.status) };
  }
  if (command.name === "alert-list") {
    return { mode: "paper", alerts: engine.alerts(command.status) };
  }
  if (command.name === "events") {
    return { mode: "paper", events: engine.events(command.limit) };
  }
  if (command.name === "mark") return engine.mark();
  if (command.name === "close") return engine.close(command.id);
  if (command.name === "cancel") return engine.cancelOrder(command.id);
  if (command.name === "alert-cancel") return engine.cancelAlert(command.id);
  if (command.name === "alert-set") {
    return engine.setAlert({
      symbol: command.symbol,
      op: command.op,
      price: command.price,
      note: command.note,
    });
  }
  if (command.name === "limit") {
    return engine.limit({
      symbol: command.symbol,
      side: command.side,
      limitPrice: command.limitPrice,
      stopLoss: command.stopLoss,
      takeProfit: command.takeProfit,
      takeProfits: command.takeProfits,
      timeframes: command.timeframes,
      riskPct: command.riskPct,
      leverage: command.leverage,
      note: command.note,
      postOnly: command.postOnly,
      oco: command.oco,
      invalidatePrice: command.invalidatePrice,
    });
  }
  return engine.open({
    symbol: command.symbol,
    side: command.side,
    stopLoss: command.stopLoss,
    takeProfit: command.takeProfit,
    takeProfits: command.takeProfits,
    timeframes: command.timeframes,
    riskPct: command.riskPct,
    leverage: command.leverage,
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
    onEvent: bindPaperNotify(paper.notify),
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

  if (command.name === "replay") {
    try {
      const body = await runReplayFromFeed(command);
      console.log(JSON.stringify(body, null, 2));
    } catch (error) {
      if (error instanceof PaperSafetyError) {
        console.error(`[minh:paper] ${error.message}`);
        process.exit(1);
      }
      if (error instanceof PaperReject) {
        console.log(JSON.stringify(error.toJSON(), null, 2));
        process.exit(1);
      }
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    return;
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
