import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";
import { bucketPrice } from "./view";

export const LIQ_NOTE = "quant veto — not a signal";
export const MAP_LIQ_WINDOW_MS = 4 * 3_600_000;
export const LIQ_BURST_MS = 5 * 60_000;
export const DEFAULT_LIQ_BAND = "0.01";
export const DEFAULT_LIQ_HOURS = 24;
export const LIQ_HEATMAP_MAX_PRINTS = 5_000;
export const LIQ_HEATMAP_MAX_BINS = 300;

/** Bybit: Buy = long liquidated; Sell = short liquidated. */
export type LiqSide = "Buy" | "Sell";

export type LiqPrint = {
  symbol: string;
  side: LiqSide;
  price: string;
  size: string;
  exchTs: number;
};

export type LiqBin = {
  price: string;
  longSize: string;
  shortSize: string;
  count: number;
};

export type SnapshotLiqHeatmap = {
  symbol: string;
  ts: number;
  windowMs: number;
  bucket: string;
  lastPrice: string | null;
  bins: LiqBin[];
  longSize: string;
  shortSize: string;
  count: number;
  cascade: boolean;
  meta: {
    db: string;
    note: typeof LIQ_NOTE;
  };
};

export type MapLiq = {
  longSize: string;
  shortSize: string;
  count: number;
  below: string;
  above: string;
  cascade: boolean;
  note: typeof LIQ_NOTE;
};

export function liqEnabled(): boolean {
  return process.env.BYBIT_LIQ !== "0";
}

export function liqBand(): number {
  const raw = process.env.BYBIT_LIQ_BAND?.trim() || DEFAULT_LIQ_BAND;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Number(DEFAULT_LIQ_BAND);
}

export function parseLiqSide(raw: unknown): LiqSide | null {
  return raw === "Buy" || raw === "Sell" ? raw : null;
}

export function parseLiqPrints(data: unknown, fallbackSymbol?: string): LiqPrint[] {
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const out: LiqPrint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const side = parseLiqSide(rec.S);
    const price = rec.p == null ? "" : String(rec.p).trim();
    const size = rec.v == null ? "" : String(rec.v).trim();
    const exchTs = Number(rec.T);
    const symbol = String(rec.s ?? fallbackSymbol ?? "").trim().toUpperCase();
    if (!side || !symbol || price === "" || size === "" || !Number.isFinite(exchTs)) continue;
    out.push({ symbol, side, price, size, exchTs });
  }
  return out;
}

export function defaultLiqBucket(last: number): number {
  if (!Number.isFinite(last) || last <= 0) return 10;
  if (last >= 10_000) return 50;
  if (last >= 1_000) return 5;
  if (last >= 100) return 1;
  if (last >= 10) return 0.1;
  return 0.01;
}

export function liqCascade(
  prints: Array<{ exchTs: number; size: string }>,
  now: number,
  windowMs = MAP_LIQ_WINDOW_MS,
  burstMs = LIQ_BURST_MS,
): boolean {
  if (prints.length === 0) return false;
  const floor = now - windowMs;
  let windowSize = 0;
  let burstSize = 0;
  for (const print of prints) {
    if (print.exchTs < floor) continue;
    const n = Number(print.size);
    if (!Number.isFinite(n)) continue;
    windowSize += n;
    if (print.exchTs >= now - burstMs) burstSize += n;
  }
  if (windowSize <= 0 || burstSize <= 0) return false;
  const slots = Math.max(windowMs / burstMs, 1);
  return burstSize >= 3 * (windowSize / slots);
}

function sumSize(prints: LiqPrint[], pred: (print: LiqPrint) => boolean): number {
  let sum = 0;
  for (const print of prints) {
    if (!pred(print)) continue;
    const n = Number(print.size);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

export function emptyMapLiq(): MapLiq {
  return {
    longSize: "0",
    shortSize: "0",
    count: 0,
    below: "0",
    above: "0",
    cascade: false,
    note: LIQ_NOTE,
  };
}

export type LiqStore = Pick<TrackerDb, "listLiquidations">;

function rowsToPrints(rows: Array<{
  symbol: string;
  side: string;
  price: string;
  size: string;
  exch_ts: number;
}>): LiqPrint[] {
  const out: LiqPrint[] = [];
  for (const row of rows) {
    const side = parseLiqSide(row.side);
    if (!side) continue;
    out.push({
      symbol: row.symbol,
      side,
      price: String(row.price),
      size: String(row.size),
      exchTs: Number(row.exch_ts),
    });
  }
  return out;
}

export function buildMapLiq(
  store: LiqStore,
  symbol: string,
  lastPrice: string | null | undefined,
  now = Date.now(),
): MapLiq {
  const rows = store.listLiquidations({
    symbol,
    startTs: now - MAP_LIQ_WINDOW_MS,
    limit: LIQ_HEATMAP_MAX_PRINTS,
    maxLimit: LIQ_HEATMAP_MAX_PRINTS,
  });
  const prints = rowsToPrints(rows);
  const last = Number(lastPrice);
  const band = liqBand();
  const longSize = sumSize(prints, (p) => p.side === "Buy");
  const shortSize = sumSize(prints, (p) => p.side === "Sell");
  let below = 0;
  let above = 0;
  if (Number.isFinite(last) && last > 0) {
    const lo = last * (1 - band);
    const hi = last * (1 + band);
    below = sumSize(prints, (p) => p.side === "Buy" && Number(p.price) <= last && Number(p.price) >= lo);
    above = sumSize(prints, (p) => p.side === "Sell" && Number(p.price) >= last && Number(p.price) <= hi);
  }
  return {
    longSize: String(longSize),
    shortSize: String(shortSize),
    count: prints.length,
    below: String(below),
    above: String(above),
    cascade: liqCascade(prints, now),
    note: LIQ_NOTE,
  };
}

export function buildLiqHeatmap(
  store: LiqStore,
  opts: {
    symbol?: string | null;
    dbPath: string;
    now?: number;
    hours?: number;
    bucket?: number | null;
    lastPrice?: string | null;
  },
): SnapshotLiqHeatmap {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const now = opts.now ?? Date.now();
  const hours = Math.min(Math.max(opts.hours ?? DEFAULT_LIQ_HOURS, 1), 48);
  const windowMs = hours * 3_600_000;
  const last = Number(opts.lastPrice);
  const bucket = opts.bucket != null && opts.bucket > 0
    ? opts.bucket
    : defaultLiqBucket(Number.isFinite(last) ? last : 0);
  const rows = store.listLiquidations({
    symbol,
    startTs: now - windowMs,
    limit: LIQ_HEATMAP_MAX_PRINTS,
    maxLimit: LIQ_HEATMAP_MAX_PRINTS,
  });
  const prints = rowsToPrints(rows);
  const bins = new Map<string, { long: number; short: number; count: number }>();
  let longSize = 0;
  let shortSize = 0;
  for (const print of prints) {
    const key = bucketPrice(print.price, bucket);
    const cell = bins.get(key) ?? { long: 0, short: 0, count: 0 };
    const n = Number(print.size) || 0;
    if (print.side === "Buy") {
      cell.long += n;
      longSize += n;
    } else {
      cell.short += n;
      shortSize += n;
    }
    cell.count += 1;
    bins.set(key, cell);
  }
  const sorted = [...bins.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
  const trimmed = sorted.slice(0, LIQ_HEATMAP_MAX_BINS);
  return {
    symbol,
    ts: now,
    windowMs,
    bucket: String(bucket),
    lastPrice: opts.lastPrice ?? null,
    bins: trimmed.map(([price, cell]) => ({
      price,
      longSize: String(cell.long),
      shortSize: String(cell.short),
      count: cell.count,
    })),
    longSize: String(longSize),
    shortSize: String(shortSize),
    count: prints.length,
    cascade: liqCascade(prints, now, windowMs),
    meta: { db: opts.dbPath, note: LIQ_NOTE },
  };
}
