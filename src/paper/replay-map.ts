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
import type { PaperConfig, PaperSide } from "./types";

export function replayMapDbPath(paperDbPath: string): string {
  return paperDbPath.replace(/\.sqlite$/i, "") + "-replay-map.sqlite";
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

export type ReplayMapResult = {
  mode: "paper";
  replayMap: true;
  symbol: string;
  fromTs: number;
  toTs: number;
  htfBars: number;
  ltfBars: number;
  ticks: number;
  slippage: "0";
  quant: "missing";
  accepted: string[];
  armed: string[];
  filled: number;
  invalidated: number;
  metrics: ReturnType<PaperEngine["metrics"]>;
  account: ReturnType<PaperEngine["account"]>;
};

export async function runReplayMap(opts: {
  config: PaperConfig;
  universe: PaperUniverse;
  series: Record<string, ReplayBar[]>;
  request: ReplayMapRequest;
  dbPath: string;
}): Promise<ReplayMapResult> {
  const { config, universe, series, request, dbPath } = opts;
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
  const feed = createReplayFeed({ symbol, series, klineClosed: true });
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
            tape: null,
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

  const metrics = engine.metrics(7, request.toTs);
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
    htfBars: htf.length,
    ltfBars,
    ticks,
    slippage: "0",
    quant: "missing",
    accepted: [...new Set(accepted)],
    armed,
    filled,
    invalidated,
    metrics,
    account,
  };
}

export async function runReplayMapFromFeed(request: ReplayMapRequest): Promise<ReplayMapResult> {
  assertNoApiKeys();
  const paper = await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  const dbPath = replayMapDbPath(paper.dbPath);
  assertSeparateDb(dbPath, feedCfg.dbPath);
  assertSeparateDb(paper.dbPath, dbPath);
  const feedStore = openDb(feedCfg.dbPath, true);
  try {
    const lookback240 = ZONE_KLINE_LIMITS["240"] * intervalToMs("240");
    const lookback60 = ZONE_KLINE_LIMITS["60"] * intervalToMs("60");
    const symbol = request.symbol.trim().toUpperCase();
    const series: Record<string, ReplayBar[]> = {
      "240": loadReplaySeries(feedStore, {
        symbol,
        interval: "240",
        fromTs: request.fromTs - lookback240,
        toTs: request.toTs,
      }),
      "60": loadReplaySeries(feedStore, {
        symbol,
        interval: "60",
        fromTs: request.fromTs - lookback60,
        toTs: request.toTs,
      }),
      "15": loadReplaySeries(feedStore, {
        symbol,
        interval: "15",
        fromTs: request.fromTs,
        toTs: request.toTs,
      }),
    };
    const universe: PaperUniverse = { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals };
    return await runReplayMap({
      config: paper,
      universe,
      series,
      request: { ...request, symbol },
      dbPath,
    });
  } finally {
    feedStore.close();
  }
}

export function parseReplayMapTimes(fromRaw: string, toRaw: string): { fromTs: number; toTs: number } {
  return { fromTs: parseTimeArg(fromRaw), toTs: parseTimeArg(toRaw) };
}
