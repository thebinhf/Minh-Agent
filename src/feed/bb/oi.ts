import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";

/** MAP OI windows. 15m stays on GET /oi, not /map. */
export const OI_INTERVALS = ["5", "15", "60", "240", "D"] as const;
export type OiInterval = (typeof OI_INTERVALS)[number];

export const MAP_OI_INTERVALS = ["60", "240"] as const;
export const MAP_OI_LIMITS = { "240": 20, "60": 24 } as const;

export const OI_NOTE = "quant veto — not a signal";
export const DEFAULT_OI_EXTREME = "2";

export type OiTrend = "rising" | "falling" | "flat" | null;
export type OiReading = "long_add" | "short_add" | "cover" | "flush" | null;

const BYBIT_INTERVAL_TIME: Record<OiInterval, string> = {
  "5": "5min",
  "15": "15min",
  "60": "1h",
  "240": "4h",
  D: "1d",
};

export type OiBar = {
  startTs: number;
  openInterest: string;
};

export type OiSeries = {
  interval: OiInterval;
  bars: OiBar[];
  latest: string | null;
  deltaPct: string | null;
  trend: OiTrend;
  reading: OiReading;
  priceDeltaPct: string | null;
  extreme: string;
};

export type SnapshotOi = {
  symbol: string;
  interval: OiInterval;
  ts: number;
  bars: OiBar[];
  latest: string | null;
  deltaPct: string | null;
  trend: OiTrend;
  reading: OiReading;
  priceDeltaPct: string | null;
  extreme: string;
  meta: {
    db: string;
    note: typeof OI_NOTE;
  };
};

export type MapOi = {
  "240": OiBar[];
  "60": OiBar[];
  latest: string | null;
  deltaPct: string | null;
  trend: OiTrend;
  reading: OiReading;
  priceDeltaPct: string | null;
  extreme: string;
  note: typeof OI_NOTE;
};

export function oiEnabled(): boolean {
  return process.env.BYBIT_OI !== "0";
}

export function oiExtreme(): string {
  const raw = process.env.BYBIT_OI_EXTREME?.trim();
  if (!raw) return DEFAULT_OI_EXTREME;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? raw : DEFAULT_OI_EXTREME;
}

export function closesDeltaPct(closes: Array<string | null | undefined>): string | null {
  const nums: number[] = [];
  for (const raw of closes) {
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    nums.push(n);
  }
  if (nums.length < 2 || nums[0] === 0) return null;
  return ((nums[nums.length - 1]! - nums[0]!) / nums[0]! * 100).toFixed(4);
}

export function oiTrend(deltaPct: string | null, extreme = oiExtreme()): OiTrend {
  if (deltaPct == null || deltaPct === "") return null;
  const n = Number(deltaPct);
  const floor = Number(extreme);
  if (!Number.isFinite(n) || !Number.isFinite(floor) || floor <= 0) return null;
  if (Math.abs(n) < floor) return "flat";
  return n > 0 ? "rising" : "falling";
}

/**
 * Classic OI/price matrix. Quant veto — not an entry signal.
 * rising+up = long_add; rising+down = short_add; falling+up = cover; falling+down = flush.
 */
export function oiReading(
  oiDeltaPct: string | null,
  priceDeltaPct: string | null,
  extreme = oiExtreme(),
): OiReading {
  const trend = oiTrend(oiDeltaPct, extreme);
  if (trend !== "rising" && trend !== "falling") return null;
  if (priceDeltaPct == null || priceDeltaPct === "") return null;
  const px = Number(priceDeltaPct);
  if (!Number.isFinite(px) || px === 0) return null;
  if (trend === "rising") return px > 0 ? "long_add" : "short_add";
  return px > 0 ? "cover" : "flush";
}

export function parseOiInterval(raw: string | undefined | null): OiInterval | null {
  if (raw == null || raw.trim() === "") return "240";
  const token = raw.trim();
  const upper = token.toUpperCase();
  if (upper === "D") return "D";
  if (token === "5" || token === "15" || token === "60" || token === "240") return token;
  return null;
}

export function toBybitOiInterval(interval: string): string | null {
  const parsed = parseOiInterval(interval);
  if (!parsed) return null;
  return BYBIT_INTERVAL_TIME[parsed];
}

export function oiIntervalsFromEnv(fallback: readonly string[] = MAP_OI_INTERVALS): OiInterval[] {
  const raw = process.env.BYBIT_OI_INTERVALS;
  if (!raw || raw.trim() === "") {
    return fallback.filter((item): item is OiInterval => parseOiInterval(item) != null);
  }
  const out: OiInterval[] = [];
  for (const part of raw.split(",")) {
    const interval = parseOiInterval(part);
    if (interval && !out.includes(interval)) out.push(interval);
  }
  return out;
}

export function parseRestOiList(list: unknown): OiBar[] {
  if (!Array.isArray(list)) return [];
  const bars: OiBar[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { openInterest?: unknown; timestamp?: unknown };
    const startTs = Number(rec.timestamp);
    const openInterest = rec.openInterest == null ? "" : String(rec.openInterest).trim();
    if (!Number.isFinite(startTs) || openInterest === "") continue;
    bars.push({ startTs, openInterest });
  }
  bars.sort((a, b) => a.startTs - b.startTs);
  const seen = new Set<number>();
  const unique: OiBar[] = [];
  for (const bar of bars) {
    if (seen.has(bar.startTs)) continue;
    seen.add(bar.startTs);
    unique.push(bar);
  }
  return unique;
}

export function oiDeltaPct(bars: OiBar[]): string | null {
  if (bars.length < 2) return null;
  const first = Number(bars[0]?.openInterest);
  const last = Number(bars[bars.length - 1]?.openInterest);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  return ((last - first) / first * 100).toFixed(4);
}

export function emptyMapOi(): MapOi {
  return {
    "240": [],
    "60": [],
    latest: null,
    deltaPct: null,
    trend: null,
    reading: null,
    priceDeltaPct: null,
    extreme: oiExtreme(),
    note: OI_NOTE,
  };
}

export function summarizeOi(
  bars: OiBar[],
  opts: { tickerOi?: string | null; closes?: Array<string | null | undefined> } = {},
): Pick<OiSeries, "latest" | "deltaPct" | "trend" | "reading" | "priceDeltaPct" | "extreme"> {
  const extreme = oiExtreme();
  const latest = opts.tickerOi?.trim() || (bars.length ? bars[bars.length - 1]!.openInterest : null);
  const deltaPct = oiDeltaPct(bars);
  const priceDeltaPct = closesDeltaPct(opts.closes ?? []);
  return {
    latest,
    deltaPct,
    trend: oiTrend(deltaPct, extreme),
    reading: oiReading(deltaPct, priceDeltaPct, extreme),
    priceDeltaPct,
    extreme,
  };
}

export type OiStore = Pick<TrackerDb, "listOi">;

export function readOiBars(
  store: OiStore,
  symbol: string,
  interval: OiInterval,
  limit: number,
): OiBar[] {
  const rows = store.listOi({ symbol, interval, limit, maxLimit: limit });
  const bars: OiBar[] = [];
  for (const row of rows) {
    const startTs = Number(row.start_ts);
    const openInterest = row.open_interest == null ? "" : String(row.open_interest);
    if (!Number.isFinite(startTs) || openInterest === "") continue;
    bars.push({ startTs, openInterest });
  }
  bars.sort((a, b) => a.startTs - b.startTs);
  return bars;
}

export function buildOi(
  store: OiStore,
  opts: { symbol?: string | null; interval?: string | null; dbPath: string; limit?: number; now?: number },
): SnapshotOi | { error: "oi_interval"; allowed: readonly string[] } {
  const interval = parseOiInterval(opts.interval);
  if (interval == null) {
    return { error: "oi_interval", allowed: OI_INTERVALS };
  }
  const symbol = normalizeBriefSymbol(opts.symbol);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const bars = readOiBars(store, symbol, interval, limit);
  const stats = summarizeOi(bars);
  return {
    symbol,
    interval,
    ts: opts.now ?? Date.now(),
    bars,
    ...stats,
    meta: { db: opts.dbPath, note: OI_NOTE },
  };
}

export function buildMapOi(
  store: OiStore,
  symbol: string,
  tickerOi?: string | null,
  closes?: Array<string | null | undefined>,
): MapOi {
  const h4 = readOiBars(store, symbol, "240", MAP_OI_LIMITS["240"]);
  const h1 = readOiBars(store, symbol, "60", MAP_OI_LIMITS["60"]);
  const primary = h4.length >= 2 ? h4 : h1;
  const stats = summarizeOi(primary, { tickerOi, closes });
  return {
    "240": h4,
    "60": h1,
    ...stats,
    note: OI_NOTE,
  };
}
