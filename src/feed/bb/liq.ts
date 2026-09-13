import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";
import type { OiReading } from "./oi";
import { bucketPrice } from "./view";

export const LIQ_NOTE = "quant veto — not a signal";
export const MAP_LIQ_WINDOW_MS = 4 * 3_600_000;
export const LIQ_BURST_MS = 5 * 60_000;
export const DEFAULT_LIQ_BAND = "0.01";
export const DEFAULT_LIQ_HOURS = 24;
export const LIQ_HEATMAP_MAX_PRINTS = 5_000;
export const LIQ_HEATMAP_MAX_BINS = 300;
/**
 * Ceiling for `?hours` when no retention is supplied. Otherwise the heatmap
 * window is capped by `retention.liquidationsHours`, because that prune window
 * is the entire print tape this host will ever hold — `liquidations` is WS-only
 * with no REST backfill.
 */
export const LIQ_HEATMAP_FALLBACK_MAX_HOURS = 48;
export const LIQ_SIDE_RATIO = 0.7;
export const LIQ_INTENSITY_MIN = 3;
export const LIQ_WALK_MIN_PRINTS = 4;
export const LIQ_COLD_MIN_PRINTS = 8;

/** Bybit: Buy = long liquidated; Sell = short liquidated. */
export type LiqSide = "Buy" | "Sell";
export type CascadeSide = "long" | "short" | null;

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

export type MapLiqCascade = {
  active: boolean;
  side: CascadeSide;
  intensity: string | null;
  walk: boolean;
  fuel: string;
};

export type SnapshotLiqHeatmap = {
  symbol: string;
  ts: number;
  windowMs: number;
  /** Span the returned prints actually cover. Null when there are no prints. */
  coveredMs: number | null;
  /** True when the print budget or a tape gap left part of `windowMs` uncovered. */
  truncated: boolean;
  bucket: string;
  lastPrice: string | null;
  bins: LiqBin[];
  longSize: string;
  shortSize: string;
  count: number;
  cascade: MapLiqCascade;
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
  cascade: MapLiqCascade;
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

function sumSize(prints: LiqPrint[], pred: (print: LiqPrint) => boolean): number {
  let sum = 0;
  for (const print of prints) {
    if (!pred(print)) continue;
    const n = Number(print.size);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

function median(nums: number[]): number | null {
  const finite = nums.filter((n) => Number.isFinite(n));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function emptyCascade(): MapLiqCascade {
  return { active: false, side: null, intensity: null, walk: false, fuel: "0" };
}

export function liqWalk(
  prints: LiqPrint[],
  side: LiqSide,
  now: number,
  burstMs: number,
  bucket: number,
): boolean {
  const burst = prints
    .filter((print) => print.side === side && print.exchTs >= now - burstMs && print.exchTs <= now)
    .sort((a, b) => a.exchTs - b.exchTs);
  if (burst.length < LIQ_WALK_MIN_PRINTS || !(bucket > 0)) return false;
  const mid = Math.floor(burst.length / 2);
  const first = median(burst.slice(0, mid).map((print) => Number(print.price)));
  const last = median(burst.slice(mid).map((print) => Number(print.price)));
  if (first == null || last == null) return false;
  if (side === "Buy") return last <= first - bucket;
  return last >= first + bucket;
}

function oiConfirms(side: "long" | "short", reading?: OiReading): boolean {
  if (side === "long") return reading === "flush";
  return reading === "cover";
}

/**
 * Cascade = same-side burst + (price walk OR matching OI flush/cover).
 * Intensity uses baseline *outside* the 5m burst so a quiet tape cannot trip.
 * Fuel is remaining same-side prints near last — not the burst itself.
 */
export function liqCascade(opts: {
  prints: LiqPrint[];
  now: number;
  windowMs?: number;
  burstMs?: number;
  lastPrice?: number | null;
  below?: number;
  above?: number;
  oiReading?: OiReading;
}): MapLiqCascade {
  const windowMs = opts.windowMs ?? MAP_LIQ_WINDOW_MS;
  const burstMs = opts.burstMs ?? LIQ_BURST_MS;
  const windowPrints = opts.prints.filter((print) =>
    print.exchTs >= opts.now - windowMs && print.exchTs <= opts.now
  );
  const burstPrints = windowPrints.filter((print) => print.exchTs >= opts.now - burstMs);
  const burstLong = sumSize(burstPrints, (print) => print.side === "Buy");
  const burstShort = sumSize(burstPrints, (print) => print.side === "Sell");
  const burstTotal = burstLong + burstShort;
  if (burstTotal <= 0) return emptyCascade();

  let side: "long" | "short" | null = null;
  let liqSide: LiqSide | null = null;
  if (burstLong / burstTotal >= LIQ_SIDE_RATIO) {
    side = "long";
    liqSide = "Buy";
  } else if (burstShort / burstTotal >= LIQ_SIDE_RATIO) {
    side = "short";
    liqSide = "Sell";
  }

  const burstSize = side === "long" ? burstLong : side === "short" ? burstShort : burstTotal;
  const baselinePrints = windowPrints.filter((print) => print.exchTs < opts.now - burstMs);
  const baselineSize = liqSide
    ? sumSize(baselinePrints, (print) => print.side === liqSide)
    : sumSize(baselinePrints, () => true);
  const slots = Math.max(windowMs / burstMs, 1);
  const baselineAvg = baselineSize / Math.max(slots - 1, 1);
  const intensity = baselineAvg > 0 ? burstSize / baselineAvg : null;
  const last = opts.lastPrice != null && Number.isFinite(opts.lastPrice) && opts.lastPrice > 0
    ? opts.lastPrice
    : median(burstPrints.map((print) => Number(print.price)));
  const walk = liqSide != null
    ? liqWalk(burstPrints, liqSide, opts.now, burstMs, defaultLiqBucket(last ?? 0))
    : false;
  const fuel = side === "long"
    ? String(opts.below ?? 0)
    : side === "short"
      ? String(opts.above ?? 0)
      : "0";
  const burstCount = liqSide
    ? burstPrints.filter((print) => print.side === liqSide).length
    : burstPrints.length;
  const strong = intensity != null && intensity >= LIQ_INTENSITY_MIN;
  const confirmed = walk || (side != null && oiConfirms(side, opts.oiReading));
  const coldStart = intensity == null && walk && burstCount >= LIQ_COLD_MIN_PRINTS;

  return {
    active: side != null && ((strong && confirmed) || coldStart),
    side,
    intensity: intensity == null ? null : intensity.toFixed(2),
    walk,
    fuel,
  };
}

export function emptyMapLiq(): MapLiq {
  return {
    longSize: "0",
    shortSize: "0",
    count: 0,
    below: "0",
    above: "0",
    cascade: emptyCascade(),
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

function nearLast(prints: LiqPrint[], last: number, band: number): { below: number; above: number } {
  if (!Number.isFinite(last) || last <= 0) return { below: 0, above: 0 };
  const lo = last * (1 - band);
  const hi = last * (1 + band);
  return {
    below: sumSize(prints, (print) => print.side === "Buy" && Number(print.price) <= last && Number(print.price) >= lo),
    above: sumSize(prints, (print) => print.side === "Sell" && Number(print.price) >= last && Number(print.price) <= hi),
  };
}

export function buildMapLiq(
  store: LiqStore,
  symbol: string,
  lastPrice: string | null | undefined,
  now = Date.now(),
  oiReading?: OiReading,
): MapLiq {
  const rows = store.listLiquidations({
    symbol,
    startTs: now - MAP_LIQ_WINDOW_MS,
    endTs: now,
    limit: LIQ_HEATMAP_MAX_PRINTS,
    maxLimit: LIQ_HEATMAP_MAX_PRINTS,
  });
  const prints = rowsToPrints(rows);
  const last = Number(lastPrice);
  const near = nearLast(prints, last, liqBand());
  const longSize = sumSize(prints, (print) => print.side === "Buy");
  const shortSize = sumSize(prints, (print) => print.side === "Sell");
  return {
    longSize: String(longSize),
    shortSize: String(shortSize),
    count: prints.length,
    below: String(near.below),
    above: String(near.above),
    cascade: liqCascade({
      prints,
      now,
      lastPrice: Number.isFinite(last) ? last : null,
      below: near.below,
      above: near.above,
      oiReading,
    }),
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
    oiReading?: OiReading;
    retention?: { liquidationsHours?: number };
  },
): SnapshotLiqHeatmap {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const now = opts.now ?? Date.now();
  const maxHours = Math.max(
    1,
    Math.round(opts.retention?.liquidationsHours ?? LIQ_HEATMAP_FALLBACK_MAX_HOURS),
  );
  const hours = Math.min(Math.max(opts.hours ?? DEFAULT_LIQ_HOURS, 1), maxHours);
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
  let oldestTs: number | null = null;
  let newestTs: number | null = null;
  for (const print of prints) {
    if (oldestTs === null || print.exchTs < oldestTs) oldestTs = print.exchTs;
    if (newestTs === null || print.exchTs > newestTs) newestTs = print.exchTs;
  }
  const coveredMs = oldestTs === null || newestTs === null ? null : newestTs - oldestTs;
  const truncated = rows.length >= LIQ_HEATMAP_MAX_PRINTS
    || oldestTs === null
    || oldestTs > now - windowMs;
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
  const near = nearLast(prints, last, liqBand());
  return {
    symbol,
    ts: now,
    windowMs,
    coveredMs,
    truncated,
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
    cascade: liqCascade({
      prints,
      now,
      windowMs,
      lastPrice: Number.isFinite(last) ? last : null,
      below: near.below,
      above: near.above,
      oiReading: opts.oiReading,
    }),
    meta: { db: opts.dbPath, note: LIQ_NOTE },
  };
}