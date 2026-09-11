import { existsSync, unlinkSync } from "node:fs";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { openDb } from "../feed/bb/db";
import { intervalToMs, parseTimeArg } from "../feed/bb/recovery";
import { agentMapEnabled, decideMapAccept } from "../agent/policy";
import {
  biasFromBars,
  combineHtfBias,
  nearestSwing,
  type BiasBar,
  type SymbolBias,
} from "../agent/bias";
import {
  ZONE_KLINE_LIMITS,
  detectZoneCards,
  intervalMsForTf,
  type DetectBar,
} from "../zones/detect";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { createPaperEngine, type PaperEngine, type PaperUniverse } from "./engine";
import { PaperReject } from "./errors";
import { mapAcceptEnabled, runMapAccept } from "./map-accept";
import {
  createReplayFeed,
  loadReplaySeries,
  replayPrints,
  type ReplayBar,
} from "./replay";
import { asOfTape, type AsOfStore } from "../features/tape";
import type { PaperConfig, PaperSide } from "./types";

export const REPLAY_MAP_MAX_DAYS = 180;
export const DAY_MS = 86_400_000;

export function replayMapDbPath(paperDbPath: string): string {
  return paperDbPath.replace(/\.sqlite$/i, "") + "-replay-map.sqlite";
}

export function replayMapSymbolDb(paperDbPath: string, symbol: string, many: boolean): string {
  const base = replayMapDbPath(paperDbPath);
  if (!many) return base;
  return base.replace(/\.sqlite$/i, `-${symbol}.sqlite`);
}

export function replayMapWindow(opts: {
  fromTs?: number;
  toTs?: number;
  days?: number;
  now?: number;
}): { fromTs: number; toTs: number; days: number } {
  const now = opts.now ?? Date.now();
  if (opts.days != null) {
    if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > REPLAY_MAP_MAX_DAYS) {
      throw new PaperReject("replay_window", "replay-map", {
        days: opts.days,
        max: REPLAY_MAP_MAX_DAYS,
      });
    }
    return { fromTs: now - opts.days * DAY_MS, toTs: now, days: opts.days };
  }
  if (opts.fromTs == null || opts.toTs == null || opts.toTs <= opts.fromTs) {
    throw new PaperReject("replay_window", "replay-map", {
      fromTs: opts.fromTs,
      toTs: opts.toTs,
    });
  }
  const days = Math.max(1, Math.ceil((opts.toTs - opts.fromTs) / DAY_MS));
  return { fromTs: opts.fromTs, toTs: opts.toTs, days };
}

function resetDb(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function asDetect(bars: ReplayBar[]): DetectBar[] {
  return bars.map((bar) => ({
    startTs: bar.startTs,
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    confirm: true,
  }));
}

function asBias(bars: ReplayBar[]): BiasBar[] {
  return asDetect(bars).map(({ startTs, open, high, low, close }) => ({
    startTs, open, high, low, close,
  }));
}

function prefixAt(bars: ReplayBar[], lastStartTs: number): ReplayBar[] {
  return bars.filter((bar) => bar.startTs <= lastStartTs);
}

function closedBy(bars: ReplayBar[], asof: number, intervalMs: number): ReplayBar[] {
  return bars.filter((bar) => bar.startTs + intervalMs <= asof);
}

function walkSide(engine: {
  orders: (status: "pending") => Array<{ side: PaperSide }>;
  positions: (status: "open") => Array<{ side: PaperSide }>;
}): PaperSide {
  return engine.orders("pending")[0]?.side
    ?? engine.positions("open")[0]?.side
    ?? "long";
}

export type ReplayMapRequest = {
  symbol: string;
  fromTs: number;
  toTs: number;
};

export type ReplayMapFromFeed = {
  symbols: string[] | "watchlist";
  fromTs?: number;
  toTs?: number;
  days?: number;
  now?: number;
};

export type ReplayMapResult = {
  mode: "paper";
  replayMap: true;
  symbol: string;
  fromTs: number;
  toTs: number;
  days: number;
  htfBars: number;
  ltfBars: number;
  ticks: number;
  slippage: "0";
  quant: "asof" | "missing";
  accepted: string[];
  armed: string[];
  filled: number;
  invalidated: number;
  metrics: ReturnType<PaperEngine["metrics"]>;
  account: ReturnType<PaperEngine["account"]>;
};

export type ReplayMapWatchlist = {
  mode: "paper";
  replayMap: true;
  watchlist: true;
  days: number;
  fromTs: number;
  toTs: number;
  symbols: string[];
  rows: ReplayMapResult[];
  skipped: Array<{ symbol: string; error: string }>;
};

export async function runReplayMap(opts: {
  config: PaperConfig;
  universe: PaperUniverse;
  series: Record<string, ReplayBar[]>;
  request: ReplayMapRequest;
  dbPath: string;
  features?: AsOfStore | null;
}): Promise<ReplayMapResult> {
  const { config, universe, series, request, dbPath } = opts;
  const features = opts.features ?? null;
  if (request.toTs <= request.fromTs) {
    throw new PaperReject("replay_window", "replay-map", {
      fromTs: request.fromTs,
      toTs: request.toTs,
    });
  }
  const symbol = request.symbol.trim().toUpperCase();
  const htfMs = intervalToMs("240");
  const hourMs = intervalToMs("60");
  const m15Ms = intervalToMs("15");
  const all240 = [...(series["240"] ?? [])].sort((a, b) => a.startTs - b.startTs);
  const all60 = [...(series["60"] ?? [])].sort((a, b) => a.startTs - b.startTs);
  const all15 = [...(series["15"] ?? [])].sort((a, b) => a.startTs - b.startTs);
  const htf = all240.filter((bar) => {
    const closeTs = bar.startTs + htfMs;
    return closeTs >= request.fromTs && bar.startTs <= request.toTs;
  });
  if (htf.length === 0) {
    throw new PaperReject("replay_no_bars", "replay-map", { symbol, interval: "240" });
  }

  resetDb(dbPath);
  const store = openPaperDb(dbPath, config.account);
  let quantQuality: "asof" | "missing" = "missing";
  const feed = createReplayFeed({
    symbol,
    series,
    klineClosed: true,
    quantAt: features
      ? (sym, ts) => {
        const closes = prefixAt(all240, ts);
        const lastBar = closes[closes.length - 1];
        const row = asOfTape(features, {
          symbol: sym,
          asof: ts,
          lastPrice: lastBar ? Number(lastBar.close) : null,
          closes: closes.slice(-20).map((item) => item.close),
        });
        if (row.quality === "asof") quantQuality = "asof";
        return row.tape;
      }
      : undefined,
  });
  const engine = createPaperEngine({
    store,
    feed,
    config: { ...config, dbPath, staleMs: Math.max(config.staleMs, 60_000) },
    universe,
  });

  const accepted: string[] = [];
  const armed: string[] = [];
  let ticks = 0;
  let ltfBars = 0;
  const first = htf[0]!;
  feed.setPrint(first.close, Math.min(request.fromTs, first.startTs));

  for (let i = 0; i < htf.length; i++) {
    const bar = htf[i]!;
    const closeTs = bar.startTs + htfMs;
    const asof = Math.min(closeTs, request.toTs);
    const bars240 = prefixAt(all240, bar.startTs).slice(-ZONE_KLINE_LIMITS["240"]);
    const bars60 = closedBy(all60, asof, hourMs).slice(-ZONE_KLINE_LIMITS["60"]);
    const cards = detectZoneCards(asDetect(bars240), {
      symbol,
      tf: "240",
      intervalMs: intervalMsForTf("240"),
      now: asof,
    });
    const bias4h = biasFromBars(asBias(bars240));
    const bias1h = biasFromBars(asBias(bars60));
    const bias: SymbolBias = {
      symbol,
      "240": bias4h,
      "60": bias1h,
      htf: combineHtfBias(bias4h, bias1h),
      klineLagOk: true,
      nearestSwing: nearestSwing(asBias(bars240)),
    };
    const last = Number(bar.close);
    const lastBySymbol = new Map<string, number>([[symbol, last]]);
    if (mapAcceptEnabled()) {
      if (!agentMapEnabled()) {
        const copied = runMapAccept(engine, cards, lastBySymbol, asof);
        for (const id of copied.accepted) {
          if (!accepted.includes(id)) accepted.push(id);
        }
      } else {
        const minRr = engine.account().minRr;
        const asofRow = features
          ? asOfTape(features, {
            symbol,
            asof,
            lastPrice: last,
            closes: bars240.slice(-20).map((item) => item.close),
          })
          : null;
        if (asofRow?.quality === "asof") quantQuality = "asof";
        for (const card of cards) {
          const held = engine.zones("accepted", asof).filter((row) => row.symbol === symbol).length;
          const decision = decideMapAccept({
            card,
            bias,
            last,
            minRr,
            acceptedForSymbol: held,
            tradingAllowed: true,
            now: asof,
            tape: asofRow?.tape ?? null,
          });
          if (!decision.allow) continue;
          try {
            engine.acceptZone(card, asof);
            accepted.push(card.zoneId);
          } catch (error) {
            if (error instanceof PaperReject) {
              if (error.error === "duplicate_zone" || error.error === "ledger_cap") continue;
            }
            throw error;
          }
        }
      }
    }

    const nextStart = htf[i + 1]?.startTs ?? request.toTs + 1;
    const window15 = all15.filter((row) => (
      row.startTs >= closeTs && row.startTs < nextStart && row.startTs <= request.toTs
    ));
    ltfBars += window15.length;
    for (const m15 of window15) {
      const prints = replayPrints(walkSide(engine), m15);
      const step = Math.max(1, Math.floor(m15Ms / 4));
      for (let p = 0; p < prints.length; p++) {
        const ts = m15.startTs + (p + 1) * step;
        feed.setPrint(prints[p]!, ts);
        const marked = await engine.evaluate(ts);
        ticks += 1;
        for (const id of marked.proximity.armed) {
          if (!armed.includes(id)) armed.push(id);
        }
      }
    }
  }

  const span = replayMapWindow({ fromTs: request.fromTs, toTs: request.toTs });
  const metrics = engine.metrics(Math.min(span.days, 365), request.toTs);
  const account = engine.account();
  const filled = engine.orders("filled").length;
  const invalidated = engine.orders("invalidated").length;
  store.close();
  return {
    mode: "paper",
    replayMap: true,
    symbol,
    fromTs: request.fromTs,
    toTs: request.toTs,
    days: span.days,
    htfBars: htf.length,
    ltfBars,
    ticks,
    slippage: "0",
    quant: quantQuality,
    accepted: [...new Set(accepted)],
    armed,
    filled,
    invalidated,
    metrics,
    account,
  };
}

export async function runReplayMapFromFeed(
  request: ReplayMapFromFeed,
): Promise<ReplayMapResult | ReplayMapWatchlist> {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  const window = replayMapWindow({
    fromTs: request.fromTs,
    toTs: request.toTs,
    days: request.days,
    now: request.now,
  });
  const symbols = request.symbols === "watchlist"
    ? [...feedCfg.symbols]
    : request.symbols.map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) {
    throw new PaperReject("replay_window", "replay-map", { symbols: request.symbols });
  }
  const many = symbols.length > 1;
  const feedStore = openDb(feedCfg.dbPath, true);
  const universe: PaperUniverse = { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals };
  const lookback240 = ZONE_KLINE_LIMITS["240"] * intervalToMs("240");
  const lookback60 = ZONE_KLINE_LIMITS["60"] * intervalToMs("60");

  async function one(symbol: string): Promise<ReplayMapResult> {
    const dbPath = replayMapSymbolDb(paper.dbPath, symbol, many);
    assertSeparateDb(dbPath, feedCfg.dbPath);
    assertSeparateDb(paper.dbPath, dbPath);
    const series: Record<string, ReplayBar[]> = {
      "240": loadReplaySeries(feedStore, {
        symbol,
        interval: "240",
        fromTs: window.fromTs - lookback240,
        toTs: window.toTs,
      }),
      "60": loadReplaySeries(feedStore, {
        symbol,
        interval: "60",
        fromTs: window.fromTs - lookback60,
        toTs: window.toTs,
      }),
      "15": loadReplaySeries(feedStore, {
        symbol,
        interval: "15",
        fromTs: window.fromTs,
        toTs: window.toTs,
      }),
    };
    return runReplayMap({
      config: paper,
      universe,
      series,
      request: { symbol, fromTs: window.fromTs, toTs: window.toTs },
      dbPath,
      features: feedStore,
    });
  }

  try {
    if (!many) return await one(symbols[0]!);
    const rows: ReplayMapResult[] = [];
    const skipped: ReplayMapWatchlist["skipped"] = [];
    for (const symbol of symbols) {
      try {
        rows.push(await one(symbol));
      } catch (error) {
        if (error instanceof PaperReject && error.error === "replay_no_bars") {
          skipped.push({ symbol, error: "replay_no_bars" });
          continue;
        }
        throw error;
      }
    }
    return {
      mode: "paper",
      replayMap: true,
      watchlist: true,
      days: window.days,
      fromTs: window.fromTs,
      toTs: window.toTs,
      symbols,
      rows,
      skipped,
    };
  } finally {
    feedStore.close();
  }
}

export async function runReplayMapWatchlist(opts: {
  config: PaperConfig;
  universe: PaperUniverse;
  seriesBySymbol: Record<string, Record<string, ReplayBar[]>>;
  fromTs: number;
  toTs: number;
  features?: AsOfStore | null;
}): Promise<ReplayMapWatchlist> {
  const window = replayMapWindow({ fromTs: opts.fromTs, toTs: opts.toTs });
  const symbols = Object.keys(opts.seriesBySymbol);
  const rows: ReplayMapResult[] = [];
  const skipped: ReplayMapWatchlist["skipped"] = [];
  for (const symbol of symbols) {
    try {
      rows.push(await runReplayMap({
        config: opts.config,
        universe: opts.universe,
        series: opts.seriesBySymbol[symbol]!,
        request: { symbol, fromTs: window.fromTs, toTs: window.toTs },
        dbPath: replayMapSymbolDb(opts.config.dbPath, symbol, true),
        features: opts.features ?? null,
      }));
    } catch (error) {
      if (error instanceof PaperReject && error.error === "replay_no_bars") {
        skipped.push({ symbol, error: "replay_no_bars" });
        continue;
      }
      throw error;
    }
  }
  return {
    mode: "paper",
    replayMap: true,
    watchlist: true,
    days: window.days,
    fromTs: window.fromTs,
    toTs: window.toTs,
    symbols,
    rows,
    skipped,
  };
}

export function parseReplayMapTimes(fromRaw: string, toRaw: string): { fromTs: number; toTs: number } {
  return { fromTs: parseTimeArg(fromRaw), toTs: parseTimeArg(toRaw) };
}
