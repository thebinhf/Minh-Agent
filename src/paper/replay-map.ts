import { existsSync, unlinkSync } from "node:fs";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { openDb } from "../feed/bb/db";
import { intervalToMs, parseTimeArg } from "../feed/bb/recovery";
import { agentMapEnabled, bumpSkipReason, decideMapAccept, emptySkipReasons, mergeSkipReasons, type PolicyReason } from "../agent/policy";
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
import { familyStatsFromEngine, familyStatsFromMetrics, mapAcceptEnabled, runMapAccept } from "./map-accept";
import { familyFromCard, familyKey, rankZoneCards, type FamilyStats } from "./score";
import {
  createReplayFeed,
  loadReplaySeries,
  replayPrints,
  type ReplayBar,
} from "./replay";
import { asOfTape, bumpQuantCoverage, emptyQuantCoverage, type AsOfStore, type QuantCoverage } from "../features/tape";
import { asOfShock, type ShockStore } from "../features/shock";
import { taOscFromBars, taBarsFromSnaps } from "../ta/arm-tape";
import { taOscMode, taShockMode, type TaOscTape } from "../agent/ta-gate";
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
  orders: (status: "pending") => Array<{ side: PaperSide; symbol?: string }>;
  positions: (status: "open") => Array<{ side: PaperSide; symbol?: string }>;
}, symbol?: string): PaperSide {
  const pending = engine.orders("pending");
  const open = engine.positions("open");
  if (symbol) {
    return pending.find((row) => row.symbol === symbol)?.side
      ?? open.find((row) => row.symbol === symbol)?.side
      ?? "long";
  }
  return pending[0]?.side ?? open[0]?.side ?? "long";
}

function noteAsOf(
  coverage: QuantCoverage,
  features: AsOfStore | null | undefined,
  opts: {
    symbol: string;
    asof: number;
    lastPrice?: number | null;
    closes?: Array<string | null | undefined>;
  },
): ReturnType<typeof asOfTape> | null {
  if (!features) return null;
  const row = asOfTape(features, opts);
  bumpQuantCoverage(coverage, row.fields);
  return row;
}

function replaySnaps(bars: ReplayBar[], interval: string) {
  return bars.map((bar) => ({
    interval,
    startTs: bar.startTs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? null,
    confirm: true as const,
  }));
}

function oscFromReplay(bars: ReplayBar[]): TaOscTape | null {
  if (taOscMode() !== "accept") return null;
  return taOscFromBars(taBarsFromSnaps(replaySnaps(bars, "240")));
}

function shockFromStore(store: AsOfStore | null | undefined, symbol: string, asof: number): string | null {
  if (taShockMode() !== "arm" || !store) return null;
  if (typeof (store as Partial<ShockStore>).listKlines !== "function") return null;
  return asOfShock(store as unknown as ShockStore, { symbol, asof }).reading;
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
  oneBook?: boolean;
  trainDays?: number;
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
  quantCoverage: QuantCoverage;
  accepted: string[];
  armed: string[];
  filled: number;
  invalidated: number;
  skipReasons: Record<PolicyReason, number>;
  metrics: ReturnType<PaperEngine["metrics"]>;
  account: ReturnType<PaperEngine["account"]>;
};

export type ReplayMapBook = {
  mode: "paper";
  replayMap: true;
  watchlist: true;
  oneBook: true;
  days: number;
  fromTs: number;
  toTs: number;
  symbols: string[];
  skipped: Array<{ symbol: string; error: string }>;
  htfBars: number;
  ltfBars: number;
  ticks: number;
  slippage: "0";
  quant: "asof" | "missing";
  quantCoverage: QuantCoverage;
  accepted: string[];
  armed: string[];
  filled: number;
  invalidated: number;
  skipReasons: Record<PolicyReason, number>;
  metrics: ReturnType<PaperEngine["metrics"]>;
  account: ReturnType<PaperEngine["account"]>;
  trainDays?: number;
  train?: {
    days: number;
    fromTs: number;
    toTs: number;
    familyFloor: Array<{ family: string } & FamilyStats>;
    metrics: ReturnType<PaperEngine["metrics"]>;
    account: ReturnType<PaperEngine["account"]>;
  };
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
  trainDays?: number;
  familyByKey?: Map<string, FamilyStats>;
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
  const quantCoverage = emptyQuantCoverage();
  const feed = createReplayFeed({
    symbol,
    series,
    klineClosed: true,
    quantAt: features
      ? (sym, ts) => {
        const closes = prefixAt(all240, ts);
        const lastBar = closes[closes.length - 1];
        const row = noteAsOf(quantCoverage, features, {
          symbol: sym,
          asof: ts,
          lastPrice: lastBar ? Number(lastBar.close) : null,
          closes: closes.slice(-20).map((item) => item.close),
        });
        if (row?.quality === "asof") quantQuality = "asof";
        return row?.tape ?? null;
      }
      : undefined,
    shockAt: (sym, ts) => shockFromStore(features, sym, ts),
  });
  const engine = createPaperEngine({
    store,
    feed,
    config: { ...config, dbPath, staleMs: Math.max(config.staleMs, 60_000) },
    universe,
  });

  const accepted: string[] = [];
  const armed: string[] = [];
  const skipReasons = emptySkipReasons();
  let ticks = 0;
  let ltfBars = 0;
  let frozen: Map<string, FamilyStats> | null = opts.familyByKey ?? null;
  const trainEnd = opts.trainDays != null
    ? request.fromTs + opts.trainDays * DAY_MS
    : null;
  const first = htf[0]!;
  feed.setPrint(first.close, Math.min(request.fromTs, first.startTs), symbol);

  for (let i = 0; i < htf.length; i++) {
    const bar = htf[i]!;
    const closeTs = bar.startTs + htfMs;
    const asof = Math.min(closeTs, request.toTs);
    if (trainEnd != null && frozen == null && closeTs > trainEnd) {
      frozen = familyStatsFromEngine(engine, trainEnd, opts.trainDays!);
    }
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
    const elapsedDays = Math.max(1, Math.min(365, Math.ceil((asof - request.fromTs) / DAY_MS)));
    const familyByKey = frozen ?? familyStatsFromEngine(engine, asof, elapsedDays);
    if (mapAcceptEnabled()) {
      if (!agentMapEnabled()) {
        const copied = runMapAccept(engine, cards, lastBySymbol, asof, familyByKey);
        mergeSkipReasons(skipReasons, copied.skipReasons);
        for (const id of copied.accepted) {
          if (!accepted.includes(id)) accepted.push(id);
        }
      } else {
        const minRr = engine.account().minRr;
        const asofRow = noteAsOf(quantCoverage, features, {
          symbol,
          asof,
          lastPrice: last,
          closes: bars240.slice(-20).map((item) => item.close),
        });
        if (asofRow?.quality === "asof") quantQuality = "asof";
        const ranked = rankZoneCards(cards, (card) => (
          familyByKey.get(familyKey(familyFromCard(card)))?.score ?? null
        ));
        for (const card of ranked) {
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
            family: familyByKey.get(familyKey(familyFromCard(card))) ?? null,
            osc: oscFromReplay(bars240),
          });
          if (!decision.allow) {
            bumpSkipReason(skipReasons, decision.reason);
            continue;
          }
          try {
            engine.acceptZone(card, asof);
            accepted.push(card.zoneId);
          } catch (error) {
            if (error instanceof PaperReject) {
              if (error.error === "duplicate_zone") continue;
              if (error.error === "ledger_cap") {
                bumpSkipReason(skipReasons, "ledger_cap");
                continue;
              }
            }
            throw error;
          }
        }
      }
    }

    const nextStart = htf[i + 1]?.startTs ?? request.toTs + 1;
    // Contiguous 4H: nextStart === closeTs, so < nextStart is empty. Walk until the
    // next 4H close (closeTs + 4h). Gaps keep the exclusive nextStart bound.
    const windowEnd = nextStart > closeTs ? nextStart : closeTs + htfMs;
    const window15 = all15.filter((row) => (
      row.startTs >= closeTs && row.startTs < windowEnd && row.startTs <= request.toTs
    ));
    ltfBars += window15.length;
    for (const m15 of window15) {
      const prints = replayPrints(walkSide(engine, symbol), m15);
      const step = Math.max(1, Math.floor(m15Ms / 4));
      for (let p = 0; p < prints.length; p++) {
        const ts = m15.startTs + (p + 1) * step;
        feed.setPrint(prints[p]!, ts, symbol);
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
    quantCoverage,
    accepted: [...new Set(accepted)],
    armed,
    filled,
    invalidated,
    skipReasons,
    metrics,
    account,
  };
}

export async function runReplayMapFromFeed(
  request: ReplayMapFromFeed,
): Promise<ReplayMapResult | ReplayMapWatchlist | ReplayMapBook> {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  const window = replayMapWindow({
    fromTs: request.fromTs,
    toTs: request.toTs,
    days: request.days,
    now: request.now,
  });
  if (request.trainDays != null) {
    if (!Number.isInteger(request.trainDays) || request.trainDays < 1 || request.trainDays >= window.days) {
      throw new PaperReject("replay_window", "replay-map", {
        trainDays: request.trainDays,
        days: window.days,
      });
    }
  }
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

  function loadSeries(symbol: string): Record<string, ReplayBar[]> {
    return {
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
  }

  try {
    if (request.oneBook) {
      const seriesBySymbol: Record<string, Record<string, ReplayBar[]>> = {};
      const skipped: ReplayMapBook["skipped"] = [];
      for (const symbol of symbols) {
        const series = loadSeries(symbol);
        if ((series["240"] ?? []).length === 0) {
          skipped.push({ symbol, error: "replay_no_bars" });
          continue;
        }
        seriesBySymbol[symbol] = series;
      }
      return await runReplayMapBook({
        config: paper,
        universe,
        seriesBySymbol,
        fromTs: window.fromTs,
        toTs: window.toTs,
        skipped,
        features: feedStore,
        trainDays: request.trainDays,
        dbPath: replayMapDbPath(paper.dbPath),
        feedDbPath: feedCfg.dbPath,
      });
    }

    async function one(symbol: string): Promise<ReplayMapResult> {
      const dbPath = replayMapSymbolDb(paper.dbPath, symbol, many);
      assertSeparateDb(dbPath, feedCfg.dbPath);
      assertSeparateDb(paper.dbPath, dbPath);
      return runReplayMap({
        config: paper,
        universe,
        series: loadSeries(symbol),
        request: { symbol, fromTs: window.fromTs, toTs: window.toTs },
        dbPath,
        features: feedStore,
        trainDays: request.trainDays,
      });
    }

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

export async function runReplayMapBook(opts: {
  config: PaperConfig;
  universe: PaperUniverse;
  seriesBySymbol: Record<string, Record<string, ReplayBar[]>>;
  fromTs: number;
  toTs: number;
  dbPath: string;
  feedDbPath: string;
  skipped?: ReplayMapBook["skipped"];
  features?: AsOfStore | null;
  trainDays?: number;
}): Promise<ReplayMapBook> {
  const window = replayMapWindow({ fromTs: opts.fromTs, toTs: opts.toTs });
  const symbols = Object.keys(opts.seriesBySymbol);
  if (symbols.length === 0) {
    throw new PaperReject("replay_window", "replay-map", { symbols });
  }
  assertSeparateDb(opts.dbPath, opts.feedDbPath);
  assertSeparateDb(opts.config.dbPath, opts.dbPath);

  const htfMs = intervalToMs("240");
  const hourMs = intervalToMs("60");
  const m15Ms = intervalToMs("15");
  const features = opts.features ?? null;

  type BookEvent =
    | { ts: number; order: 0; symbol: string; bar: ReplayBar; nextStart: number }
    | { ts: number; order: 1; symbol: string; m15: ReplayBar };

  const books = new Map<string, {
    all240: ReplayBar[];
    all60: ReplayBar[];
    all15: ReplayBar[];
    htf: ReplayBar[];
  }>();
  const events: BookEvent[] = [];
  let htfBars = 0;

  for (const symbol of symbols) {
    const series = opts.seriesBySymbol[symbol]!;
    const all240 = [...(series["240"] ?? [])].sort((a, b) => a.startTs - b.startTs);
    const all60 = [...(series["60"] ?? [])].sort((a, b) => a.startTs - b.startTs);
    const all15 = [...(series["15"] ?? [])].sort((a, b) => a.startTs - b.startTs);
    const htf = all240.filter((bar) => {
      const closeTs = bar.startTs + htfMs;
      return closeTs >= window.fromTs && bar.startTs <= window.toTs;
    });
    if (htf.length === 0) continue;
    books.set(symbol, { all240, all60, all15, htf });
    htfBars += htf.length;
    for (let i = 0; i < htf.length; i++) {
      const bar = htf[i]!;
      const closeTs = bar.startTs + htfMs;
      const nextStart = htf[i + 1]?.startTs ?? window.toTs + 1;
      const windowEnd = nextStart > closeTs ? nextStart : closeTs + htfMs;
      events.push({ ts: closeTs, order: 0, symbol, bar, nextStart });
      for (const m15 of all15) {
        if (m15.startTs >= closeTs && m15.startTs < windowEnd && m15.startTs <= window.toTs) {
          events.push({ ts: m15.startTs, order: 1, symbol, m15 });
        }
      }
    }
  }
  if (events.length === 0) {
    throw new PaperReject("replay_no_bars", "replay-map", { symbols, interval: "240" });
  }
  events.sort((a, b) => a.ts - b.ts || a.order - b.order || a.symbol.localeCompare(b.symbol));

  resetDb(opts.dbPath);
  const store = openPaperDb(opts.dbPath, opts.config.account);
  let quantQuality: "asof" | "missing" = "missing";
  const quantCoverage = emptyQuantCoverage();
  const feed = createReplayFeed({
    seriesBySymbol: opts.seriesBySymbol,
    klineClosed: true,
    quantAt: features
      ? (sym, ts) => {
        const book = books.get(sym);
        const closes = prefixAt(book?.all240 ?? [], ts);
        const lastBar = closes[closes.length - 1];
        const row = noteAsOf(quantCoverage, features, {
          symbol: sym,
          asof: ts,
          lastPrice: lastBar ? Number(lastBar.close) : null,
          closes: closes.slice(-20).map((item) => item.close),
        });
        if (row?.quality === "asof") quantQuality = "asof";
        return row?.tape ?? null;
      }
      : undefined,
    shockAt: (sym, ts) => shockFromStore(features, sym, ts),
  });
  const engine = createPaperEngine({
    store,
    feed,
    config: { ...opts.config, dbPath: opts.dbPath, staleMs: Math.max(opts.config.staleMs, 60_000) },
    universe: opts.universe,
  });

  const firstHtf = events.find((item) => item.order === 0);
  if (firstHtf && firstHtf.order === 0) {
    feed.setPrint(firstHtf.bar.close, Math.min(window.fromTs, firstHtf.bar.startTs), firstHtf.symbol);
  }

  const accepted: string[] = [];
  const armed: string[] = [];
  const skipReasons = emptySkipReasons();
  let ticks = 0;
  let ltfBars = 0;
  let frozen: Map<string, FamilyStats> | null = null;
  let train: ReplayMapBook["train"];
  const trainEnd = opts.trainDays != null ? window.fromTs + opts.trainDays * DAY_MS : null;

  for (const event of events) {
    if (trainEnd != null && frozen == null && event.ts > trainEnd) {
      const metrics = engine.metrics(opts.trainDays!, trainEnd);
      frozen = familyStatsFromMetrics(metrics);
      train = {
        days: opts.trainDays!,
        fromTs: window.fromTs,
        toTs: trainEnd,
        familyFloor: metrics.byFamily.map((row) => ({
          family: row.family,
          score: row.score,
          trades: row.trades,
          avgRealizedRr: row.avgRealizedRr ?? null,
        })),
        metrics,
        account: engine.account(),
      };
    }
    if (event.order === 0) {
      const { symbol, bar } = event;
      const book = books.get(symbol)!;
      const closeTs = bar.startTs + htfMs;
      const asof = Math.min(closeTs, window.toTs);
      const bars240 = prefixAt(book.all240, bar.startTs).slice(-ZONE_KLINE_LIMITS["240"]);
      const bars60 = closedBy(book.all60, asof, hourMs).slice(-ZONE_KLINE_LIMITS["60"]);
      const cards = detectZoneCards(asDetect(bars240), {
        symbol,
        tf: "240",
        intervalMs: intervalMsForTf("240"),
        now: asof,
      });
      const bias: SymbolBias = {
        symbol,
        "240": biasFromBars(asBias(bars240)),
        "60": biasFromBars(asBias(bars60)),
        htf: combineHtfBias(biasFromBars(asBias(bars240)), biasFromBars(asBias(bars60))),
        klineLagOk: true,
        nearestSwing: nearestSwing(asBias(bars240)),
      };
      const last = Number(bar.close);
      const lastBySymbol = new Map<string, number>([[symbol, last]]);
      const elapsedDays = Math.max(1, Math.min(365, Math.ceil((asof - window.fromTs) / DAY_MS)));
      const familyByKey = frozen ?? familyStatsFromEngine(engine, asof, elapsedDays);
      if (mapAcceptEnabled()) {
        if (!agentMapEnabled()) {
          const copied = runMapAccept(engine, cards, lastBySymbol, asof, familyByKey);
          mergeSkipReasons(skipReasons, copied.skipReasons);
          for (const id of copied.accepted) {
            if (!accepted.includes(id)) accepted.push(id);
          }
        } else {
          const minRr = engine.account().minRr;
          const asofRow = noteAsOf(quantCoverage, features, {
            symbol,
            asof,
            lastPrice: last,
            closes: bars240.slice(-20).map((item) => item.close),
          });
          if (asofRow?.quality === "asof") quantQuality = "asof";
          const ranked = rankZoneCards(cards, (card) => (
            familyByKey.get(familyKey(familyFromCard(card)))?.score ?? null
          ));
          for (const card of ranked) {
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
              family: familyByKey.get(familyKey(familyFromCard(card))) ?? null,
            });
            if (!decision.allow) {
              bumpSkipReason(skipReasons, decision.reason);
              continue;
            }
            try {
              engine.acceptZone(card, asof);
              accepted.push(card.zoneId);
            } catch (error) {
              if (error instanceof PaperReject) {
                if (error.error === "duplicate_zone") continue;
                if (error.error === "ledger_cap") {
                  bumpSkipReason(skipReasons, "ledger_cap");
                  continue;
                }
              }
              throw error;
            }
          }
        }
      }
      continue;
    }

    ltfBars += 1;
    const prints = replayPrints(walkSide(engine, event.symbol), event.m15);
    const step = Math.max(1, Math.floor(m15Ms / 4));
    for (let p = 0; p < prints.length; p++) {
      const ts = event.m15.startTs + (p + 1) * step;
      feed.setPrint(prints[p]!, ts, event.symbol);
      const marked = await engine.evaluate(ts);
      ticks += 1;
      for (const id of marked.proximity.armed) {
        if (!armed.includes(id)) armed.push(id);
      }
    }
  }

  const metrics = engine.metrics(Math.min(window.days, 365), window.toTs);
  const account = engine.account();
  const filled = engine.orders("filled").length;
  const invalidated = engine.orders("invalidated").length;
  store.close();
  return {
    mode: "paper",
    replayMap: true,
    watchlist: true,
    oneBook: true,
    days: window.days,
    fromTs: window.fromTs,
    toTs: window.toTs,
    symbols,
    skipped: opts.skipped ?? [],
    htfBars,
    ltfBars,
    ticks,
    slippage: "0",
    quant: quantQuality,
    quantCoverage,
    accepted: [...new Set(accepted)],
    armed,
    filled,
    invalidated,
    skipReasons,
    metrics,
    account,
    ...(opts.trainDays != null ? { trainDays: opts.trainDays } : {}),
    ...(train ? { train } : {}),
  };
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
