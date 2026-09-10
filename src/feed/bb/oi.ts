import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";

/** MAP OI windows. 15m stays on GET /oi, not /map. */
export const OI_INTERVALS = ["5", "15", "60", "240", "D"] as const;
export type OiInterval = (typeof OI_INTERVALS)[number];

export const MAP_OI_INTERVALS = ["60", "240"] as const;
export const MAP_OI_LIMITS = { "240": 20, "60": 24 } as const;

export const OI_NOTE = "quant veto — not a signal";

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
};

export type SnapshotOi = {
  symbol: string;
  interval: OiInterval;
  ts: number;
  bars: OiBar[];
  latest: string | null;
  deltaPct: string | null;
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
  note: typeof OI_NOTE;
};

export function oiEnabled(): boolean {
  return process.env.BYBIT_OI !== "0";
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
    note: OI_NOTE,
  };
}

export function summarizeOi(bars: OiBar[]): Pick<OiSeries, "latest" | "deltaPct"> {
  const latest = bars.length ? bars[bars.length - 1]!.openInterest : null;
  return { latest, deltaPct: oiDeltaPct(bars) };
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
  const { latest, deltaPct } = summarizeOi(bars);
  return {
    symbol,
    interval,
    ts: opts.now ?? Date.now(),
    bars,
    latest,
    deltaPct,
    meta: { db: opts.dbPath, note: OI_NOTE },
  };
}

export function buildMapOi(
  store: OiStore,
  symbol: string,
  tickerOi?: string | null,
): MapOi {
  const h4 = readOiBars(store, symbol, "240", MAP_OI_LIMITS["240"]);
  const h1 = readOiBars(store, symbol, "60", MAP_OI_LIMITS["60"]);
  const primary = h4.length >= 2 ? h4 : h1;
  const { latest, deltaPct } = summarizeOi(primary);
  return {
    "240": h4,
    "60": h1,
    latest: tickerOi?.trim() || latest,
    deltaPct,
    note: OI_NOTE,
  };
}
