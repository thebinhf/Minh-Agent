import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";

export const FUNDING_NOTE = "quant veto — not a signal";
export const MAP_FUNDING_LIMIT = 21;
export const DEFAULT_FUNDING_EXTREME = "0.0003";

export type FundingBar = {
  fundingTs: number;
  fundingRate: string;
};

export type FundingCrowded = "long" | "short" | null;

export type SnapshotFunding = {
  symbol: string;
  ts: number;
  bars: FundingBar[];
  latest: string | null;
  mean: string | null;
  nextFundingTime: string | null;
  crowded: FundingCrowded;
  extreme: string;
  meta: {
    db: string;
    note: typeof FUNDING_NOTE;
  };
};

export type MapFunding = {
  bars: FundingBar[];
  latest: string | null;
  mean: string | null;
  nextFundingTime: string | null;
  crowded: FundingCrowded;
  extreme: string;
  note: typeof FUNDING_NOTE;
};

export function fundingEnabled(): boolean {
  return process.env.BYBIT_FUNDING !== "0";
}

export function fundingExtreme(): string {
  const raw = process.env.BYBIT_FUNDING_EXTREME?.trim();
  if (!raw) return DEFAULT_FUNDING_EXTREME;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? raw : DEFAULT_FUNDING_EXTREME;
}

export function parseRestFundingList(list: unknown): FundingBar[] {
  if (!Array.isArray(list)) return [];
  const bars: FundingBar[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { fundingRate?: unknown; fundingRateTimestamp?: unknown };
    const fundingTs = Number(rec.fundingRateTimestamp);
    const fundingRate = rec.fundingRate == null ? "" : String(rec.fundingRate).trim();
    if (!Number.isFinite(fundingTs) || fundingRate === "") continue;
    bars.push({ fundingTs, fundingRate });
  }
  bars.sort((a, b) => a.fundingTs - b.fundingTs);
  const seen = new Set<number>();
  const unique: FundingBar[] = [];
  for (const bar of bars) {
    if (seen.has(bar.fundingTs)) continue;
    seen.add(bar.fundingTs);
    unique.push(bar);
  }
  return unique;
}

export function fundingMean(bars: FundingBar[]): string | null {
  if (bars.length === 0) return null;
  let sum = 0;
  for (const bar of bars) {
    const n = Number(bar.fundingRate);
    if (!Number.isFinite(n)) return null;
    sum += n;
  }
  return (sum / bars.length).toFixed(8);
}

export function fundingCrowded(latest: string | null, extreme = fundingExtreme()): FundingCrowded {
  if (latest == null || latest === "") return null;
  const rate = Number(latest);
  const floor = Number(extreme);
  if (!Number.isFinite(rate) || !Number.isFinite(floor) || floor <= 0) return null;
  if (Math.abs(rate) < floor) return null;
  return rate > 0 ? "long" : "short";
}

export function emptyMapFunding(): MapFunding {
  return {
    bars: [],
    latest: null,
    mean: null,
    nextFundingTime: null,
    crowded: null,
    extreme: fundingExtreme(),
    note: FUNDING_NOTE,
  };
}

export type FundingStore = Pick<TrackerDb, "listFunding">;

export function readFundingBars(
  store: FundingStore,
  symbol: string,
  limit: number,
  endTs?: number,
): FundingBar[] {
  const rows = store.listFunding({ symbol, limit, maxLimit: limit, endTs });
  const bars: FundingBar[] = [];
  for (const row of rows) {
    const fundingTs = Number(row.funding_ts);
    const fundingRate = row.funding_rate == null ? "" : String(row.funding_rate);
    if (!Number.isFinite(fundingTs) || fundingRate === "") continue;
    bars.push({ fundingTs, fundingRate });
  }
  bars.sort((a, b) => a.fundingTs - b.fundingTs);
  return bars;
}

export function summarizeFunding(bars: FundingBar[], ticker?: { fundingRate?: string | null; nextFundingTime?: string | null }): {
  latest: string | null;
  mean: string | null;
  nextFundingTime: string | null;
  crowded: FundingCrowded;
  extreme: string;
} {
  const extreme = fundingExtreme();
  const fromTape = bars.length ? bars[bars.length - 1]!.fundingRate : null;
  const latest = ticker?.fundingRate?.trim() || fromTape;
  return {
    latest,
    mean: fundingMean(bars),
    nextFundingTime: ticker?.nextFundingTime?.trim() || null,
    crowded: fundingCrowded(latest, extreme),
    extreme,
  };
}

export function buildFunding(
  store: FundingStore,
  opts: {
    symbol?: string | null;
    dbPath: string;
    limit?: number;
    now?: number;
    ticker?: { fundingRate?: string | null; nextFundingTime?: string | null };
  },
): SnapshotFunding {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const limit = Math.min(Math.max(opts.limit ?? MAP_FUNDING_LIMIT, 1), 200);
  const bars = readFundingBars(store, symbol, limit);
  const stats = summarizeFunding(bars, opts.ticker);
  return {
    symbol,
    ts: opts.now ?? Date.now(),
    bars,
    ...stats,
    meta: { db: opts.dbPath, note: FUNDING_NOTE },
  };
}

export function buildMapFunding(
  store: FundingStore,
  symbol: string,
  ticker?: { fundingRate?: string | null; nextFundingTime?: string | null },
): MapFunding {
  const bars = readFundingBars(store, symbol, MAP_FUNDING_LIMIT);
  return {
    bars,
    ...summarizeFunding(bars, ticker),
    note: FUNDING_NOTE,
  };
}
