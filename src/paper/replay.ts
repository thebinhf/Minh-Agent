import { existsSync, unlinkSync } from "node:fs";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { openDb } from "../feed/bb/db";
import { intervalToMs } from "../feed/bb/recovery";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { createPaperEngine, type PaperUniverse } from "./engine";
import { PaperReject } from "./errors";
import { parseSide } from "./risk";
import type {
  EventView,
  LimitRequest,
  PaperConfig,
  PaperFeed,
  PaperKlineSnap,
  PaperSide,
  PaperTicker,
} from "./types";

export const FUNDING_PERIOD_MS = 8 * 60 * 60 * 1000;
export const REPLAY_BAR_CAP = 20_000;

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

export function resetReplayDb(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function lastBarAtOrBefore(series: ReplayBar[], ts: number): ReplayBar | null {
  let found: ReplayBar | null = null;
  for (const bar of series) {
    if (bar.startTs <= ts) found = bar;
    else break;
  }
  return found;
}

export function createReplayFeed(opts: {
  symbol: string;
  series: Record<string, ReplayBar[]>;
  fundingRate?: string | null;
}): PaperFeed & { setPrint: (last: string, ts: number) => void; cursorTs: () => number; bumpFunding: (now: number) => void } {
  const symbol = opts.symbol.toUpperCase();
  const series: Record<string, ReplayBar[]> = {};
  for (const [interval, bars] of Object.entries(opts.series)) {
    series[interval] = [...bars].sort((a, b) => a.startTs - b.startTs);
  }
  let cursorTs = 0;
  let ticker: PaperTicker = {
    symbol,
    lastPrice: null,
    markPrice: null,
    recvTs: null,
    fundingRate: opts.fundingRate ?? null,
    nextFundingTime: null,
  };

  const feed = {
    cursorTs() {
      return cursorTs;
    },
    setPrint(last: string, ts: number) {
      cursorTs = ts;
      let nextFundingTime = ticker.nextFundingTime;
      if (opts.fundingRate) {
        if (nextFundingTime == null) nextFundingTime = nextFundingTimeUtc(ts);
      } else {
        nextFundingTime = null;
      }
      ticker = {
        ...ticker,
        lastPrice: last,
        markPrice: last,
        recvTs: ts,
        fundingRate: opts.fundingRate ?? null,
        nextFundingTime,
      };
    },
    bumpFunding(now: number) {
      if (ticker.fundingRate == null || ticker.nextFundingTime == null) return;
      let next = ticker.nextFundingTime;
      while (next <= now) next += FUNDING_PERIOD_MS;
      ticker = { ...ticker, nextFundingTime: next };
    },
    async health() {
      return { ok: true, url: "replay" };
    },
    async ticker(query: string) {
      return query.toUpperCase() === symbol ? ticker : null;
    },
    async tickers() {
      return ticker.lastPrice ? [ticker] : [];
    },
    async lastKline(query: string, interval: string): Promise<PaperKlineSnap | null> {
      if (query.toUpperCase() !== symbol) return null;
      const bar = lastBarAtOrBefore(series[interval] ?? [], cursorTs);
      if (!bar) return null;
      return { interval, close: bar.close, startTs: bar.startTs, confirm: true };
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
  opts: { symbol: string; interval: string; fromTs: number; toTs: number },
): ReplayBar[] {
  const intervalMs = intervalToMs(opts.interval);
  const rows = store.listKlines({
    symbol: opts.symbol,
    interval: opts.interval,
    startTs: opts.fromTs - 10 * intervalMs,
    endTs: opts.toTs,
    limit: REPLAY_BAR_CAP,
    maxLimit: REPLAY_BAR_CAP,
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
  store.close();
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
