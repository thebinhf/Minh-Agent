/**
 * MAP bias from existing `/map` / map-close payloads.
 * `/map` stays "no bias" — this layer reads klines, it does not change the HTTP contract.
 *
 * Locked: 4H HH/HL = bull, LH/LL = bear, mixed = chop.
 * 1H must not oppose 4H. 1H chop does **not** override 4H — policy stands aside mid-range.
 */

export const MAP_BIASES = ["bull", "bear", "chop"] as const;
export type MapBias = (typeof MAP_BIASES)[number];

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

export type SwingPoint = {
  index: number;
  price: number;
};

export type SwingRange = {
  high: number;
  low: number;
};

export type SymbolBias = {
  symbol: string;
  "240": MapBias;
  "60": MapBias;
  htf: MapBias;
  klineLagOk: boolean;
  nearestSwing: SwingRange | null;
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

/** 3-bar fractal swings. Last bar cannot confirm a swing (needs a neighbor after). */
export function swingPoints(bars: BiasBar[]): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1]!;
    const bar = bars[i]!;
    const next = bars[i + 1]!;
    if (bar.high > prev.high && bar.high > next.high) {
      highs.push({ index: i, price: bar.high });
    }
    if (bar.low < prev.low && bar.low < next.low) {
      lows.push({ index: i, price: bar.low });
    }
  }
  return { highs, lows };
}

export function nearestSwing(bars: BiasBar[]): SwingRange | null {
  const { highs, lows } = swingPoints(bars);
  if (highs.length === 0 || lows.length === 0) return null;
  return { high: highs[highs.length - 1]!.price, low: lows[lows.length - 1]!.price };
}

/**
 * 4H/1H structure. HH+HL = bull, LH+LL = bear, mixed or not enough swings = chop.
 * Mid-range is a policy stand-aside, not a bias label.
 */
export function biasFromBars(bars: BiasBar[]): MapBias {
  const { highs, lows } = swingPoints(bars);
  if (highs.length < 2 || lows.length < 2) return "chop";
  const lastH = highs[highs.length - 1]!.price;
  const prevH = highs[highs.length - 2]!.price;
  const lastL = lows[lows.length - 1]!.price;
  const prevL = lows[lows.length - 2]!.price;
  const hh = lastH > prevH;
  const lh = lastH < prevH;
  const hl = lastL > prevL;
  const ll = lastL < prevL;
  if (hh && hl) return "bull";
  if (lh && ll) return "bear";
  return "chop";
}

/** Last strictly between nearest swing H and L. */
export function isMidRange(last: number | undefined, swing: SwingRange | null): boolean {
  if (swing == null || last == null || !Number.isFinite(last)) return false;
  const lo = Math.min(swing.high, swing.low);
  const hi = Math.max(swing.high, swing.low);
  return last > lo && last < hi;
}

/** 1H chop does not override 4H. 1H oppose 4H → chop. Mixed 4H = chop. */
export function combineHtfBias(bias4h: MapBias, bias1h: MapBias): MapBias {
  switch (bias4h) {
    case "chop":
      return "chop";
    case "bull":
    case "bear":
      switch (bias1h) {
        case "chop":
          return bias4h;
        case "bull":
        case "bear":
          return bias1h === bias4h ? bias4h : "chop";
        default: {
          const _exhaustive: never = bias1h;
          return _exhaustive;
        }
      }
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
  const bars4h = barsFromMapKlines(rec.klines?.["240"]);
  const bars1h = barsFromMapKlines(rec.klines?.["60"]);
  const bias4h = biasFromBars(bars4h);
  const bias1h = biasFromBars(bars1h);
  return {
    symbol,
    "240": bias4h,
    "60": bias1h,
    htf: combineHtfBias(bias4h, bias1h),
    klineLagOk: klineLagOkFrom(rec.klineLag, symbol),
    nearestSwing: nearestSwing(bars4h),
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
  return raw === "bull" || raw === "bear" || raw === "chop";
}
