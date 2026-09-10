import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";
import { fundingCrowded } from "./funding";
import { defaultLiqBucket } from "./liq";
import { peekRiskLimit } from "./rest";
import { bucketPrice } from "./view";

export const LIQ_MODEL_NOTE = "model — not exchange data";
export const DEFAULT_LIQ_MODEL_MMR = "0.005";
export const LIQ_MODEL_ENTRY_INTERVAL = "15";
export const LIQ_MODEL_ENTRY_BARS = 48;
export const LIQ_MODEL_LONG_SHARE_FAIR = 0.5;
export const LIQ_MODEL_LONG_SHARE_CROWDED = 0.65;
export const LIQ_MODEL_MAX_BINS = 300;

/** Public mix — not fitted. Weights sum to 1. */
export const LIQ_MODEL_MIX = [
  { leverage: 10, weight: 0.50 },
  { leverage: 20, weight: 0.35 },
  { leverage: 50, weight: 0.15 },
] as const;

export type LiqModelBin = {
  price: string;
  longSize: string;
  shortSize: string;
};

export type SnapshotLiqModel = {
  symbol: string;
  ts: number;
  lastPrice: string | null;
  oi: string | null;
  oiUsd: string | null;
  mmRate: string;
  mmSource: "risk-limit" | "default";
  maxLeverage: string | null;
  mix: Array<{ leverage: number; weight: number }>;
  longShare: string;
  entries: number;
  bins: LiqModelBin[];
  longSize: string;
  shortSize: string;
  scaled: boolean;
  ok: boolean;
  broken: "missing_oi" | "missing_last" | "missing_entries" | "disabled" | null;
  meta: { db: string; note: typeof LIQ_MODEL_NOTE };
};

export function liqModelEnabled(): boolean {
  return process.env.BYBIT_LIQ_MODEL !== "0";
}

/** Isolated linear (no close-fee). Matches paper `liqPrice` without Dec. */
export function isolatedLiq(
  side: "long" | "short",
  entry: number,
  leverage: number,
  mmRate: number,
): number {
  if (!(entry > 0) || !(leverage > 0)) return 0;
  if (side === "long") {
    const den = 1 - mmRate;
    if (!(den > 0)) return 0;
    const px = entry * (1 - 1 / leverage) / den;
    return px > 0 ? px : 0;
  }
  return entry * (1 + 1 / leverage) / (1 + mmRate);
}

export function liqModelLongShare(fundingRate: string | null | undefined): number {
  const crowded = fundingCrowded(fundingRate ?? null);
  if (crowded === "long") return LIQ_MODEL_LONG_SHARE_CROWDED;
  if (crowded === "short") return 1 - LIQ_MODEL_LONG_SHARE_CROWDED;
  return LIQ_MODEL_LONG_SHARE_FAIR;
}

function emptyModel(
  symbol: string,
  dbPath: string,
  ts: number,
  broken: SnapshotLiqModel["broken"],
  extra: Partial<SnapshotLiqModel> = {},
): SnapshotLiqModel {
  return {
    symbol,
    ts,
    lastPrice: extra.lastPrice ?? null,
    oi: extra.oi ?? null,
    oiUsd: extra.oiUsd ?? null,
    mmRate: extra.mmRate ?? DEFAULT_LIQ_MODEL_MMR,
    mmSource: extra.mmSource ?? "default",
    maxLeverage: extra.maxLeverage ?? null,
    mix: LIQ_MODEL_MIX.map((row) => ({ ...row })),
    longShare: extra.longShare ?? String(LIQ_MODEL_LONG_SHARE_FAIR),
    entries: extra.entries ?? 0,
    bins: [],
    longSize: "0",
    shortSize: "0",
    scaled: false,
    ok: false,
    broken,
    meta: { db: dbPath, note: LIQ_MODEL_NOTE },
  };
}

export type LiqModelStore = Pick<TrackerDb, "listKlines" | "listTickers" | "listOi">;

function resolveMm(symbol: string, override?: { mmRate?: string; mmSource?: "risk-limit" | "default"; maxLeverage?: string | null }) {
  if (override?.mmRate) {
    return {
      mmRate: override.mmRate,
      mmSource: override.mmSource ?? "default",
      maxLeverage: override.maxLeverage ?? null,
    };
  }
  const cached = peekRiskLimit(symbol);
  if (cached) {
    return { mmRate: cached.mmRate, mmSource: "risk-limit" as const, maxLeverage: cached.maxLeverage };
  }
  return { mmRate: DEFAULT_LIQ_MODEL_MMR, mmSource: "default" as const, maxLeverage: null };
}

/**
 * Forward liquidation map. Inventory-capped estimate from OI + 15m VW
 * entries + public leverage mix + isolated MMR. Not exchange positions.
 */
export function buildLiqModel(
  store: LiqModelStore,
  opts: {
    symbol?: string | null;
    dbPath: string;
    now?: number;
    mmRate?: string;
    mmSource?: "risk-limit" | "default";
    maxLeverage?: string | null;
    bucket?: number | null;
  },
): SnapshotLiqModel {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const now = opts.now ?? Date.now();
  if (!liqModelEnabled()) {
    return emptyModel(symbol, opts.dbPath, now, "disabled");
  }
  const mm = resolveMm(symbol, {
    mmRate: opts.mmRate,
    mmSource: opts.mmSource,
    maxLeverage: opts.maxLeverage,
  });
  const mmRate = Number(mm.mmRate);
  const ticker = store.listTickers(symbol)[0] as {
    last_price?: unknown;
    open_interest?: unknown;
    open_interest_value?: unknown;
    funding_rate?: unknown;
  } | undefined;
  const last = Number(ticker?.last_price);
  const oi = ticker?.open_interest == null ? null : String(ticker.open_interest);
  const oiValue = ticker?.open_interest_value == null ? null : String(ticker.open_interest_value);
  let oiUsd = Number(oiValue);
  if (!(oiUsd > 0) && oi != null && last > 0) oiUsd = Number(oi) * last;
  const fundingRate = ticker?.funding_rate == null ? null : String(ticker.funding_rate);
  const longShare = liqModelLongShare(fundingRate);

  if (!(last > 0)) {
    return emptyModel(symbol, opts.dbPath, now, "missing_last", { mmRate: mm.mmRate, mmSource: mm.mmSource, maxLeverage: mm.maxLeverage, oi, longShare: String(longShare) });
  }
  if (!(oiUsd > 0)) {
    return emptyModel(symbol, opts.dbPath, now, "missing_oi", {
      mmRate: mm.mmRate, mmSource: mm.mmSource, maxLeverage: mm.maxLeverage,
      lastPrice: String(ticker?.last_price), oi, longShare: String(longShare),
    });
  }

  const rows = store.listKlines({
    symbol,
    interval: LIQ_MODEL_ENTRY_INTERVAL,
    confirm: true,
    limit: LIQ_MODEL_ENTRY_BARS,
    maxLimit: LIQ_MODEL_ENTRY_BARS,
  }) as Array<{ close?: unknown; turnover?: unknown; volume?: unknown }>;
  const entries: Array<{ close: number; weight: number }> = [];
  for (const row of rows) {
    const close = Number(row.close);
    const turnover = Number(row.turnover);
    const volume = Number(row.volume);
    const weight = turnover > 0 ? turnover : volume > 0 ? volume * close : 0;
    if (!(close > 0) || !(weight > 0)) continue;
    entries.push({ close, weight });
  }
  const weightSum = entries.reduce((sum, row) => sum + row.weight, 0);
  if (entries.length === 0 || !(weightSum > 0)) {
    return emptyModel(symbol, opts.dbPath, now, "missing_entries", {
      mmRate: mm.mmRate, mmSource: mm.mmSource, maxLeverage: mm.maxLeverage,
      lastPrice: String(ticker?.last_price), oi, oiUsd: String(oiUsd), longShare: String(longShare),
    });
  }

  const bucket = opts.bucket != null && opts.bucket > 0 ? opts.bucket : defaultLiqBucket(last);
  const bins = new Map<string, { long: number; short: number }>();
  let longSize = 0;
  let shortSize = 0;
  const sideCap = oiUsd / 2;

  for (const entry of entries) {
    const barShare = entry.weight / weightSum;
    for (const { leverage, weight } of LIQ_MODEL_MIX) {
      const longNotional = oiUsd * longShare * barShare * weight;
      const shortNotional = oiUsd * (1 - longShare) * barShare * weight;
      const longPx = isolatedLiq("long", entry.close, leverage, mmRate);
      const shortPx = isolatedLiq("short", entry.close, leverage, mmRate);
      if (longPx > 0 && longNotional > 0) {
        const key = bucketPrice(String(longPx), bucket);
        const cell = bins.get(key) ?? { long: 0, short: 0 };
        cell.long += longNotional;
        bins.set(key, cell);
        longSize += longNotional;
      }
      if (shortPx > 0 && shortNotional > 0) {
        const key = bucketPrice(String(shortPx), bucket);
        const cell = bins.get(key) ?? { long: 0, short: 0 };
        cell.short += shortNotional;
        bins.set(key, cell);
        shortSize += shortNotional;
      }
    }
  }

  let scaled = false;
  const scaleSide = (side: "long" | "short", total: number) => {
    if (!(total > sideCap * (1 + 1e-9))) return total;
    const factor = sideCap / total;
    scaled = true;
    for (const cell of bins.values()) {
      if (side === "long") cell.long *= factor;
      else cell.short *= factor;
    }
    return sideCap;
  };
  longSize = scaleSide("long", longSize);
  shortSize = scaleSide("short", shortSize);

  const sorted = [...bins.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
  return {
    symbol,
    ts: now,
    lastPrice: String(ticker?.last_price),
    oi,
    oiUsd: String(oiUsd),
    mmRate: mm.mmRate,
    mmSource: mm.mmSource,
    maxLeverage: mm.maxLeverage,
    mix: LIQ_MODEL_MIX.map((row) => ({ ...row })),
    longShare: String(longShare),
    entries: entries.length,
    bins: sorted.slice(0, LIQ_MODEL_MAX_BINS).map(([price, cell]) => ({
      price,
      longSize: String(cell.long),
      shortSize: String(cell.short),
    })),
    longSize: String(longSize),
    shortSize: String(shortSize),
    scaled,
    ok: true,
    broken: null,
    meta: { db: opts.dbPath, note: LIQ_MODEL_NOTE },
  };
}