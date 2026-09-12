import { existsSync, unlinkSync } from "node:fs";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { openDb } from "../feed/bb/db";
import { intervalToMs, parseTimeArg } from "../feed/bb/recovery";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { Dec } from "./decimal";
import { createPaperEngine, type PaperUniverse } from "./engine";
import { PaperReject } from "./errors";
import { parseSide } from "./risk";
import type {
  EventView,
  LimitRequest,
  PaperConfig,
  PaperFeed,
  PaperKlineSnap,
  PaperQuantTape,
  PaperSide,
  PaperTicker,
} from "./types";

export const FUNDING_PERIOD_MS = 8 * 60 * 60 * 1000;
export const REPLAY_BAR_CAP = 20_000;
export const REPLAY_BATCH_CAP = 50;

export type ReplayBar = {
  startTs: number;
  open: string;
  high: string;
  low: string;
  close: string;
};

export type ReplayRequest = LimitRequest & {
  fromTs: number;
  toTs: number;
  interval: string;
  fundingRate?: string | null;
};

export type ReplayResult = {
  mode: "paper";
  replay: true;
  symbol: string;
  interval: string;
  fromTs: number;
  toTs: number;
  bars: number;
  ticks: number;
  slippage: "0";
  order: ReturnType<ReturnType<typeof createPaperEngine>["orders"]>[number] | null;
  position: ReturnType<ReturnType<typeof createPaperEngine>["positions"]>[number] | null;
  events: EventView[];
  account: ReturnType<ReturnType<typeof createPaperEngine>["account"]>;
};

export function nextFundingTimeUtc(ts: number): number {
  return Math.floor(ts / FUNDING_PERIOD_MS) * FUNDING_PERIOD_MS + FUNDING_PERIOD_MS;
}

/** Long sees low (OCO/SL/limit) before high (TP). Short the reverse. */
export function replayPrints(side: PaperSide, bar: ReplayBar): string[] {
  const path = side === "long"
    ? [bar.open, bar.low, bar.high, bar.close]
    : [bar.open, bar.high, bar.low, bar.close];
  const out: string[] = [];
  for (const px of path) {
    if (px !== "" && out[out.length - 1] !== px) out.push(px);
  }
  return out;
}

export function replayDbPath(paperDbPath: string): string {
  return paperDbPath.replace(/\.sqlite$/i, "") + "-replay.sqlite";
}

export function replaySetupDbPath(dbPath: string, id: string, index: number): string {
  const slug = id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "setup";
  return dbPath.replace(/\.sqlite$/i, "") + `-${index}-${slug}.sqlite`;
}

export function resetReplayDb(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    unlinkReplayFile(path);
  }
}

function unlinkReplayFile(path: string): void {
  const delaysMs = [0, 25, 50, 100, 200, 400];
  let last: unknown;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) Bun.sleepSync(delayMs);
    try {
      if (existsSync(path)) unlinkSync(path);
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

function lastBarAtOrBefore(series: ReplayBar[], ts: number): ReplayBar | null {
  let found: ReplayBar | null = null;
  for (const bar of series) {
    if (bar.startTs <= ts) found = bar;
    else break;
  }
  return found;
}

function lastClosedBar(series: ReplayBar[], ts: number, intervalMs: number): ReplayBar | null {
  let found: ReplayBar | null = null;
  for (const bar of series) {
    if (bar.startTs + intervalMs <= ts) found = bar;
    else break;
  }
  return found;
}

export function createReplayFeed(opts: {
  symbol?: string;
  series?: Record<string, ReplayBar[]>;
  seriesBySymbol?: Record<string, Record<string, ReplayBar[]>>;
  fundingRate?: string | null;
  /** Only return a kline after it has closed (startTs + interval ≤ cursor). ARM 15m. */
  klineClosed?: boolean;
  /** As-of quant at the cursor. Missing = do not invent. */
  quantAt?: (symbol: string, ts: number) => PaperQuantTape | null;
}): PaperFeed & {
  setPrint: (last: string, ts: number, forSymbol?: string) => void;
  cursorTs: () => number;
  bumpFunding: (now: number) => void;
} {
  const books = new Map<string, Record<string, ReplayBar[]>>();
  if (opts.seriesBySymbol) {
    for (const [sym, raw] of Object.entries(opts.seriesBySymbol)) {
      const sorted: Record<string, ReplayBar[]> = {};
      for (const [interval, bars] of Object.entries(raw)) {
        sorted[interval] = [...bars].sort((a, b) => a.startTs - b.startTs);
      }
      books.set(sym.toUpperCase(), sorted);
    }
  }
  const primary = (opts.symbol ?? [...books.keys()][0] ?? "").toUpperCase();
  if (opts.series && primary) {
    const sorted: Record<string, ReplayBar[]> = {};
    for (const [interval, bars] of Object.entries(opts.series)) {
      sorted[interval] = [...bars].sort((a, b) => a.startTs - b.startTs);
    }
    books.set(primary, sorted);
  }

  let cursorTs = 0;
  const tickers = new Map<string, PaperTicker>();

  function blankTicker(sym: string): PaperTicker {
    return {
      symbol: sym,
      lastPrice: null,
      markPrice: null,
      recvTs: null,
      fundingRate: opts.fundingRate ?? null,
      nextFundingTime: null,
    };
  }

  if (primary) tickers.set(primary, blankTicker(primary));

  const feed = {
    cursorTs() {
      return cursorTs;
    },
    setPrint(last: string, ts: number, forSymbol?: string) {
      const key = (forSymbol ?? primary).toUpperCase();
      cursorTs = ts;
      const prev = tickers.get(key) ?? blankTicker(key);
      let nextFundingTime = prev.nextFundingTime;
      if (opts.fundingRate) {
        if (nextFundingTime == null) nextFundingTime = nextFundingTimeUtc(ts);
      } else {
        nextFundingTime = null;
      }
      tickers.set(key, {
        ...prev,
        lastPrice: last,
        markPrice: last,
        recvTs: ts,
        fundingRate: opts.fundingRate ?? null,
        nextFundingTime,
      });
    },
    bumpFunding(now: number) {
      for (const [key, ticker] of tickers) {
        if (ticker.fundingRate == null || ticker.nextFundingTime == null) continue;
        let next = ticker.nextFundingTime;
        while (next <= now) next += FUNDING_PERIOD_MS;
        tickers.set(key, { ...ticker, nextFundingTime: next });
      }
    },
    async health() {
      return { ok: true, url: "replay", klineLagOk: true };
    },
    async ticker(query: string) {
      return tickers.get(query.toUpperCase()) ?? null;
    },
    async tickers() {
      return [...tickers.values()].filter((row) => row.lastPrice);
    },
    async lastKline(query: string, interval: string): Promise<PaperKlineSnap | null> {
      const bars = books.get(query.toUpperCase())?.[interval] ?? [];
      const bar = opts.klineClosed
        ? lastClosedBar(bars, cursorTs, intervalToMs(interval))
        : lastBarAtOrBefore(bars, cursorTs);
      if (!bar) return null;
      return { interval, open: bar.open, close: bar.close, startTs: bar.startTs, confirm: true };
    },
    async quant(query: string): Promise<PaperQuantTape | null> {
      if (!opts.quantAt) return null;
      return opts.quantAt(query.toUpperCase(), cursorTs);
    },
  };
  return feed;
}

export function loadReplaySeries(
  store: {
    listKlines: (opts: {
      symbol?: string;
      interval?: string;
      limit?: number;
      startTs?: number;
      endTs?: number;
      maxLimit?: number;
    }) => unknown[];
  },
  opts: { symbol: string; interval: string; fromTs: number; toTs: number; cap?: number },
): ReplayBar[] {
  const intervalMs = intervalToMs(opts.interval);
  const span = Math.max(0, opts.toTs - opts.fromTs);
  const needed = Math.ceil(span / intervalMs) + 40;
  const cap = Math.min(Math.max(opts.cap ?? Math.max(REPLAY_BAR_CAP, needed), 50), 80_000);
  const rows = store.listKlines({
    symbol: opts.symbol,
    interval: opts.interval,
    startTs: opts.fromTs - 10 * intervalMs,
    endTs: opts.toTs,
    limit: cap,
    maxLimit: cap,
  }) as Array<{
    start_ts: number;
    open: string | null;
    high: string | null;
    low: string | null;
    close: string | null;
  }>;
  return rows
    .slice()
    .reverse()
    .filter((row) => row.open && row.high && row.low && row.close)
    .map((row) => ({
      startTs: row.start_ts,
      open: row.open as string,
      high: row.high as string,
      low: row.low as string,
      close: row.close as string,
    }));
}

export async function runReplay(opts: {
  config: PaperConfig;
  universe: PaperUniverse;
  series: Record<string, ReplayBar[]>;
  request: ReplayRequest;
  dbPath: string;
}): Promise<ReplayResult> {
  const { config, universe, series, request, dbPath } = opts;
  if (request.toTs <= request.fromTs) {
    throw new PaperReject("replay_window", "replay", { fromTs: request.fromTs, toTs: request.toTs });
  }
  const symbol = request.symbol.trim().toUpperCase();
  const side = parseSide(request.side);
  const walk = [...(series[request.interval] ?? [])]
    .filter((bar) => bar.startTs >= request.fromTs && bar.startTs <= request.toTs)
    .sort((a, b) => a.startTs - b.startTs);
  if (walk.length === 0) {
    throw new PaperReject("replay_no_bars", "replay", { symbol, interval: request.interval });
  }
  if (walk.length > REPLAY_BAR_CAP) {
    throw new PaperReject("replay_too_many_bars", "replay", { bars: walk.length, cap: REPLAY_BAR_CAP });
  }

  resetReplayDb(dbPath);
  const store = openPaperDb(dbPath, config.account);
  try {
    const feed = createReplayFeed({ symbol, series, fundingRate: request.fundingRate });
    const engine = createPaperEngine({
      store,
      feed,
      config: { ...config, dbPath, staleMs: Math.max(config.staleMs, 60_000) },
      universe,
    });

    const first = walk[0]!;
    feed.setPrint(first.open, Math.min(request.fromTs, first.startTs));
    await engine.limit({
      symbol,
      side: request.side,
      limitPrice: request.limitPrice,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      takeProfits: request.takeProfits,
      timeframes: request.timeframes,
      riskPct: request.riskPct,
      leverage: request.leverage,
      note: request.note,
      postOnly: request.postOnly,
      oco: request.oco,
      invalidatePrice: request.invalidatePrice,
    }, feed.cursorTs());

    const events: EventView[] = [];
    let ticks = 0;
    const step = Math.max(1, Math.floor(intervalToMs(request.interval) / 4));
    for (const bar of walk) {
      const prints = replayPrints(side, bar);
      for (let i = 0; i < prints.length; i++) {
        const ts = bar.startTs + i * step;
        feed.setPrint(prints[i]!, ts);
        const marked = await engine.evaluate(ts);
        events.push(...marked.events);
        ticks += 1;
        feed.bumpFunding(ts);
        if (marked.filled.length > 0) break;
      }
    }

    const orders = engine.orders("all");
    const positions = engine.positions("all");
    const account = engine.account();
    return {
      mode: "paper",
      replay: true,
      symbol,
      interval: request.interval,
      fromTs: request.fromTs,
      toTs: request.toTs,
      bars: walk.length,
      ticks,
      slippage: "0",
      order: orders[0] ?? null,
      position: positions[0] ?? null,
      events,
      account,
    };
  } finally {
    store.close();
  }
}

export async function runReplayFromFeed(request: ReplayRequest): Promise<ReplayResult> {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  const dbPath = replayDbPath(paper.dbPath);
  assertSeparateDb(dbPath, feedCfg.dbPath);
  assertSeparateDb(paper.dbPath, dbPath);
  const feedStore = openDb(feedCfg.dbPath, true);
  try {
    const intervals = [...new Set([request.interval, ...request.timeframes])];
    const series: Record<string, ReplayBar[]> = {};
    for (const interval of intervals) {
      series[interval] = loadReplaySeries(feedStore, {
        symbol: request.symbol.trim().toUpperCase(),
        interval,
        fromTs: request.fromTs,
        toTs: request.toTs,
      });
    }
    return await runReplay({
      config: paper,
      universe: { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals },
      series,
      request,
      dbPath,
    });
  } finally {
    feedStore.close();
  }
}

export type ReplayBatchSetup = ReplayRequest & { id: string };

export type ReplayBatchRow = {
  id: string;
  symbol: string;
  side: string;
  outcome: string;
  orderStatus: string | null;
  closeReason: string | null;
  realizedPnl: string | null;
  error?: string;
};

export type ReplayBatchResult = {
  mode: "paper";
  replayBatch: true;
  setups: number;
  filled: number;
  invalidated: number;
  pending: number;
  closed: { sl: number; tp: number; liq: number; manual: number };
  realizedPnl: string;
  rows: ReplayBatchRow[];
};

function asText(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return String(value);
}

function parseBatchTime(raw: unknown, fallback?: number): number | undefined {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  try {
    return parseTimeArg(String(raw));
  } catch {
    throw new PaperReject("replay_batch", "replay", { field: "from/to", value: raw });
  }
}

function parseTimeframes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function parseReplayBatchJson(raw: unknown): ReplayBatchSetup[] {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(root?.setups)
      ? root.setups
      : null;
  if (!list) throw new PaperReject("replay_batch", "replay", { reason: "need setups array" });
  if (list.length === 0) throw new PaperReject("replay_batch", "replay", { reason: "empty" });
  if (list.length > REPLAY_BATCH_CAP) {
    throw new PaperReject("replay_too_many_setups", "replay", { setups: list.length, cap: REPLAY_BATCH_CAP });
  }
  const defaults = root && !Array.isArray(raw) ? root : {};
  const defaultFrom = parseBatchTime(defaults.from);
  const defaultTo = parseBatchTime(defaults.to);
  const defaultInterval = asText(defaults.interval) ?? "15";
  const defaultFunding = asText(defaults.fundingRate) ?? null;
  return list.map((item, index) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const symbol = asText(row.symbol);
    const side = asText(row.side);
    const price = asText(row.price ?? row.limitPrice);
    const sl = asText(row.sl ?? row.stopLoss);
    const tp = asText(row.tp ?? row.takeProfit);
    const timeframes = parseTimeframes(row.tf ?? row.timeframes ?? defaults.tf ?? defaults.timeframes);
    const fromTs = parseBatchTime(row.from, defaultFrom);
    const toTs = parseBatchTime(row.to, defaultTo);
    if (!symbol || !side || !price || !sl || !tp || timeframes.length < 2 || fromTs == null || toTs == null) {
      throw new PaperReject("replay_batch", "replay", { index, symbol, reason: "missing fields" });
    }
    return {
      id: asText(row.id) ?? `${index + 1}:${symbol.trim().toUpperCase()}`,
      symbol,
      side,
      limitPrice: price,
      stopLoss: sl,
      takeProfit: tp,
      timeframes,
      riskPct: asText(row.riskPct ?? row["risk-pct"]),
      leverage: asText(row.leverage),
      note: asText(row.note),
      postOnly: row.postOnly !== false && row.cross !== true,
      oco: row.oco !== false,
      invalidatePrice: asText(row.invalidate ?? row.invalidatePrice),
      fromTs,
      toTs,
      interval: asText(row.interval) ?? defaultInterval,
      fundingRate: asText(row.fundingRate) ?? defaultFunding,
    };
  });
}

export function replayOutcome(result: ReplayResult): Pick<ReplayBatchRow, "outcome" | "orderStatus" | "closeReason" | "realizedPnl"> {
  const orderStatus = result.order?.status ?? null;
  const closeReason = result.position?.status === "closed" ? (result.position.closeReason ?? null) : null;
  const realizedPnl = result.position?.status === "closed" ? (result.position.realizedPnl ?? "0") : null;
  let outcome = "pending";
  if (orderStatus === "invalidated") outcome = "invalidated";
  else if (closeReason) outcome = closeReason;
  else if (orderStatus === "filled") outcome = "filled";
  else if (orderStatus === "rejected") outcome = "rejected";
  return { outcome, orderStatus, closeReason, realizedPnl };
}

export async function runReplayBatch(opts: {
  config: PaperConfig;
  universe: PaperUniverse;
  seriesFor: (setup: ReplayBatchSetup) => Record<string, ReplayBar[]>;
  setups: ReplayBatchSetup[];
  dbPath: string;
}): Promise<ReplayBatchResult> {
  const rows: ReplayBatchRow[] = [];
  for (const setup of opts.setups) {
    try {
      const result = await runReplay({
        config: opts.config,
        universe: opts.universe,
        series: opts.seriesFor(setup),
        request: setup,
        dbPath: replaySetupDbPath(opts.dbPath, setup.id, rows.length),
      });
      rows.push({ id: setup.id, symbol: result.symbol, side: setup.side, ...replayOutcome(result) });
    } catch (error) {
      const message = error instanceof PaperReject ? error.error : (error instanceof Error ? error.message : String(error));
      rows.push({
        id: setup.id,
        symbol: setup.symbol.trim().toUpperCase(),
        side: setup.side,
        outcome: "error",
        orderStatus: null,
        closeReason: null,
        realizedPnl: null,
        error: message,
      });
    }
  }
  const closed = { sl: 0, tp: 0, liq: 0, manual: 0 };
  let realized = Dec.zero();
  let filled = 0;
  let invalidated = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.outcome === "filled") filled += 1;
    if (row.outcome === "invalidated") invalidated += 1;
    if (row.outcome === "pending") pending += 1;
    if (row.outcome === "sl") closed.sl += 1;
    if (row.outcome === "tp") closed.tp += 1;
    if (row.outcome === "liq") closed.liq += 1;
    if (row.outcome === "manual") closed.manual += 1;
    if (row.realizedPnl) realized = realized.add(Dec.from(row.realizedPnl));
  }
  return {
    mode: "paper",
    replayBatch: true,
    setups: opts.setups.length,
    filled,
    invalidated,
    pending,
    closed,
    realizedPnl: realized.toText(),
    rows,
  };
}

export async function runReplayBatchFromFeed(filePath: string): Promise<ReplayBatchResult> {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  const dbPath = replayDbPath(paper.dbPath);
  assertSeparateDb(dbPath, feedCfg.dbPath);
  assertSeparateDb(paper.dbPath, dbPath);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new PaperReject("replay_batch_file", "replay", { path: filePath });
  }
  const setups = parseReplayBatchJson(JSON.parse(await file.text()));
  const feedStore = openDb(feedCfg.dbPath, true);
  const cache = new Map<string, Record<string, ReplayBar[]>>();
  try {
    return await runReplayBatch({
      config: paper,
      universe: { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals },
      dbPath,
      setups,
      seriesFor(setup) {
        const symbol = setup.symbol.trim().toUpperCase();
        const hit = cache.get(symbol);
        if (hit) return hit;
        const intervals = [...new Set([setup.interval, ...setup.timeframes, ...setups.flatMap((item) => (
          item.symbol.trim().toUpperCase() === symbol ? [item.interval, ...item.timeframes] : []
        ))])];
        const fromTs = Math.min(...setups.filter((item) => item.symbol.trim().toUpperCase() === symbol).map((item) => item.fromTs));
        const toTs = Math.max(...setups.filter((item) => item.symbol.trim().toUpperCase() === symbol).map((item) => item.toTs));
        const series: Record<string, ReplayBar[]> = {};
        for (const interval of intervals) {
          series[interval] = loadReplaySeries(feedStore, { symbol, interval, fromTs, toTs });
        }
        cache.set(symbol, series);
        return series;
      },
    });
  } finally {
    feedStore.close();
  }
}
