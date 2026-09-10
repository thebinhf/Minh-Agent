/**
 * MAP bias from existing `/map` / map-close payloads.
 * `/map` stays "no bias" — this layer reads klines, it does not change the HTTP contract.
 */

export const MAP_BIASES = ["bull", "bear", "aside"] as const;
export type MapBias = (typeof MAP_BIASES)[number];

/** Mid-range of the recent swing → STAND ASIDE (operator playbook). */
export const BIAS_MID_RANGE = { low: 0.35, high: 0.65 } as const;

export type MapKlineLike = {
  start_ts?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  confirm?: unknown;
};

export type BiasBar = {
  startTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type SymbolBias = {
  symbol: string;
  "240": MapBias;
  "60": MapBias;
  htf: MapBias;
  klineLagOk: boolean;
};

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function barsFromMapKlines(rows: unknown): BiasBar[] {
  if (!Array.isArray(rows)) return [];
  const out: BiasBar[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as MapKlineLike;
    if (item.confirm === false) continue;
    const startTs = num(item.start_ts);
    const open = num(item.open);
    const high = num(item.high);
    const low = num(item.low);
    const close = num(item.close);
    if (startTs == null || open == null || high == null || low == null || close == null) continue;
    if (!(high >= low) || !(high >= Math.max(open, close)) || !(low <= Math.min(open, close))) continue;
    out.push({ startTs, open, high, low, close });
  }
  out.sort((a, b) => a.startTs - b.startTs);
  return out;
}

function rangePosition(close: number, swingHigh: number, swingLow: number): number {
  const span = swingHigh - swingLow;
  if (!(span > 0)) return 0.5;
  return (close - swingLow) / span;
}

/**
 * Confirmed HTF bars only. Mid-range → aside. Close vs prior close + swing location.
 */
export function biasFromBars(bars: BiasBar[]): MapBias {
  if (bars.length < 2) return "aside";
  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (const bar of bars) {
    if (bar.high > swingHigh) swingHigh = bar.high;
    if (bar.low < swingLow) swingLow = bar.low;
  }
  const pos = rangePosition(last.close, swingHigh, swingLow);
  if (pos > BIAS_MID_RANGE.low && pos < BIAS_MID_RANGE.high) return "aside";
  if (pos >= BIAS_MID_RANGE.high && last.close > prev.close) return "bull";
  if (pos <= BIAS_MID_RANGE.low && last.close < prev.close) return "bear";
  return "aside";
}

/** 4H leads; 1H must agree. Mixed or either aside → do not fade. */
export function combineHtfBias(bias4h: MapBias, bias1h: MapBias): MapBias {
  switch (bias4h) {
    case "aside":
      return "aside";
    case "bull":
      return bias1h === "bull" ? "bull" : "aside";
    case "bear":
      return bias1h === "bear" ? "bear" : "aside";
    default: {
      const _exhaustive: never = bias4h;
      return _exhaustive;
    }
  }
}

function klineLagOkFrom(raw: unknown, symbol: string): boolean {
  if (!raw || typeof raw !== "object") return true;
  const lag = raw as { ok?: unknown; rows?: unknown };
  const rows = Array.isArray(lag.rows) ? lag.rows : [];
  const mine = rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    return String((row as { symbol?: unknown }).symbol ?? "").toUpperCase() === symbol;
  });
  if (mine.length > 0) {
    return mine.every((row) => (row as { stale?: unknown }).stale !== true);
  }
  return lag.ok !== false;
}

function mapItems(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  const row = body as { maps?: unknown };
  if (Array.isArray(row.maps)) return row.maps;
  return [body];
}

export function biasFromMapItem(raw: unknown): SymbolBias | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as {
    symbol?: unknown;
    klines?: { "240"?: unknown; "60"?: unknown };
    klineLag?: unknown;
  };
  const symbol = String(rec.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const bias4h = biasFromBars(barsFromMapKlines(rec.klines?.["240"]));
  const bias1h = biasFromBars(barsFromMapKlines(rec.klines?.["60"]));
  return {
    symbol,
    "240": bias4h,
    "60": bias1h,
    htf: combineHtfBias(bias4h, bias1h),
    klineLagOk: klineLagOkFrom(rec.klineLag, symbol),
  };
}

export function readMapBias(body: unknown): Map<string, SymbolBias> {
  const out = new Map<string, SymbolBias>();
  for (const item of mapItems(body)) {
    const bias = biasFromMapItem(item);
    if (!bias) continue;
    out.set(bias.symbol, bias);
  }
  return out;
}

export function isMapBias(raw: unknown): raw is MapBias {
  return raw === "bull" || raw === "bear" || raw === "aside";
}
