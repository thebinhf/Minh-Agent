import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPaperConfig } from "../../src/paper/config";
import { openPaperDb, type PaperDb } from "../../src/paper/db";
import { createPaperEngine } from "../../src/paper/engine";
import type { PaperConfig, PaperDepth, PaperFeed, PaperKlineSnap, PaperTicker } from "../../src/paper/types";

export const UNIVERSE = {
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  intervals: ["5", "15", "60", "240"],
};

export function tempDir(prefix = "minh-paper-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function paperConfig(dir: string, extra: Partial<PaperConfig> = {}): Promise<PaperConfig> {
  const base = await loadPaperConfig();
  return {
    ...base,
    ...extra,
    dbPath: extra.dbPath ?? join(dir, "paper.sqlite"),
    httpHost: extra.httpHost ?? "127.0.0.1",
    httpPort: extra.httpPort ?? 0,
    tickMs: extra.tickMs ?? 0,
    account: extra.account ?? {
      ...base.account,
      minRr: null,
      feeRate: "0",
      makerFeeRate: "0",
      defaultLeverage: "1",
      leverageMin: "1",
      leverageMax: "25",
      mmRate: "0.005",
      marginMode: "isolated",
    },
  };
}

export async function tempStore(dir?: string): Promise<{ dir: string; store: PaperDb; config: PaperConfig }> {
  const root = dir ?? tempDir();
  const config = await paperConfig(root);
  return { dir: root, store: openPaperDb(config.dbPath, config.account), config };
}

function tickerRow(symbol: string, opts?: {
  lastPrice?: string | null;
  markPrice?: string | null;
  recvTs?: number | null;
  fundingRate?: string | null;
  nextFundingTime?: number | null;
  tickers?: Record<string, Partial<PaperTicker>>;
}): PaperTicker {
  const override = opts?.tickers?.[symbol];
  const lastPrice = opts?.lastPrice === undefined ? "63000" : opts.lastPrice;
  const markPrice = opts?.markPrice === undefined ? "63100" : opts.markPrice;
  const recvTs = opts?.recvTs === undefined ? Date.now() : opts.recvTs;
  const fundingRate = opts?.fundingRate === undefined ? null : opts.fundingRate;
  const nextFundingTime = opts?.nextFundingTime === undefined ? null : opts.nextFundingTime;
  return {
    symbol,
    lastPrice: override?.lastPrice === undefined ? lastPrice : override.lastPrice,
    markPrice: override?.markPrice === undefined ? markPrice : override.markPrice,
    recvTs: override?.recvTs === undefined ? recvTs : override.recvTs,
    fundingRate: override?.fundingRate === undefined ? fundingRate : override.fundingRate,
    nextFundingTime: override?.nextFundingTime === undefined ? nextFundingTime : override.nextFundingTime,
  };
}

export function mockDepth(opts: {
  symbol?: string;
  recvTs?: number | null;
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
}): PaperDepth {
  const bids = (opts.bids ?? []).map(([price, size]) => ({ price, size }));
  const asks = (opts.asks ?? []).map(([price, size]) => ({ price, size }));
  return {
    symbol: opts.symbol ?? "BTCUSDT",
    recvTs: opts.recvTs === undefined ? Date.now() : opts.recvTs,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bids,
    asks,
  };
}

export function mockFeed(opts?: {
  lastPrice?: string | null;
  markPrice?: string | null;
  recvTs?: number | null;
  fundingRate?: string | null;
  nextFundingTime?: number | null;
  ok?: boolean;
  klines?: Partial<Record<string, PaperKlineSnap | null>>;
  tickers?: Record<string, Partial<PaperTicker>>;
  klineLagOk?: boolean;
  depth?: PaperDepth | null | ((symbol: string) => PaperDepth | null);
}): PaperFeed {
  const feed: PaperFeed = {
    async health() {
      return { ok: opts?.ok ?? true, url: "http://127.0.0.1:43180/health", klineLagOk: opts?.klineLagOk ?? true };
    },
    async ticker(symbol: string) {
      return tickerRow(symbol, opts);
    },
    async tickers() {
      const symbols = opts?.tickers ? Object.keys(opts.tickers) : [];
      const out: PaperTicker[] = [];
      for (const symbol of symbols) {
        const row = await feed.ticker(symbol);
        if (row) out.push(row);
      }
      return out;
    },
    async lastKline(symbol: string, interval: string) {
      if (opts?.klines && Object.prototype.hasOwnProperty.call(opts.klines, interval)) {
        return opts.klines[interval] ?? null;
      }
      return { interval, close: opts?.lastPrice ?? "63000", startTs: Date.now(), confirm: true };
    },
  };
  if (opts && Object.prototype.hasOwnProperty.call(opts, "depth")) {
    feed.depth = async (symbol: string) => {
      const depth = opts.depth;
      if (typeof depth === "function") return depth(symbol);
      return depth ?? null;
    };
  }
  return feed;
}

export async function paperEngine(feed: PaperFeed = mockFeed(), dir?: string) {
  const ctx = await tempStore(dir);
  const engine = createPaperEngine({
    store: ctx.store,
    feed,
    config: ctx.config,
    universe: UNIVERSE,
  });
  return { ...ctx, engine, feed };
}

export const OPEN_LONG = {
  symbol: "BTCUSDT",
  side: "long",
  stopLoss: "60000",
  takeProfit: "66000",
  timeframes: ["240", "60", "15"],
  riskPct: "0.03",
};
