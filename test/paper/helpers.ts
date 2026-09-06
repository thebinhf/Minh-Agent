import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPaperConfig } from "../../src/paper/config";
import { openPaperDb, type PaperDb } from "../../src/paper/db";
import { createPaperEngine } from "../../src/paper/engine";
import type { PaperConfig, PaperFeed, PaperKlineSnap, PaperTicker } from "../../src/paper/types";

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
    account: extra.account ?? {
      ...base.account,
      feeRate: "0",
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

export function mockFeed(opts?: {
  lastPrice?: string | null;
  markPrice?: string | null;
  recvTs?: number | null;
  fundingRate?: string | null;
  nextFundingTime?: number | null;
  ok?: boolean;
  klines?: Partial<Record<string, PaperKlineSnap | null>>;
  tickers?: Record<string, Partial<PaperTicker>>;
}): PaperFeed {
  const lastPrice = opts?.lastPrice === undefined ? "63000" : opts.lastPrice;
  const markPrice = opts?.markPrice === undefined ? "63100" : opts.markPrice;
  const recvTs = opts?.recvTs === undefined ? Date.now() : opts.recvTs;
  const fundingRate = opts?.fundingRate === undefined ? null : opts.fundingRate;
  const nextFundingTime = opts?.nextFundingTime === undefined ? null : opts.nextFundingTime;
  return {
    async health() {
      return { ok: opts?.ok ?? true, url: "http://127.0.0.1:43180/health" };
    },
    async ticker(symbol: string) {
      const override = opts?.tickers?.[symbol];
      return {
        symbol,
        lastPrice: override?.lastPrice === undefined ? lastPrice : override.lastPrice,
        markPrice: override?.markPrice === undefined ? markPrice : override.markPrice,
        recvTs: override?.recvTs === undefined ? recvTs : override.recvTs,
        fundingRate: override?.fundingRate === undefined ? fundingRate : override.fundingRate,
        nextFundingTime: override?.nextFundingTime === undefined ? nextFundingTime : override.nextFundingTime,
      };
    },
    async lastKline(symbol: string, interval: string) {
      if (opts?.klines && Object.prototype.hasOwnProperty.call(opts.klines, interval)) {
        return opts.klines[interval] ?? null;
      }
      return { interval, close: lastPrice ?? "1", startTs: Date.now(), confirm: true };
    },
  };
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
