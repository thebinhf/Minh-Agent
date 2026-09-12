import type { BriefKline } from "../feed/bb/brief";

export type TaBar = {
  startTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  confirm: boolean;
};

export type SwingPoint = {
  index: number;
  price: number;
  kind: "high" | "low";
};

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function roundPrice(n: number): number {
  return Number(n.toFixed(8));
}

export function roundRatio(n: number): number {
  return Number(n.toFixed(4));
}

/** Closed bars only. Volume stays null when the row has none — not 0. */
export function barsFromKlines(rows: BriefKline[], asof?: number, intervalMs?: number): TaBar[] {
  const out: TaBar[] = [];
  const cap = asof != null && intervalMs != null ? asof - intervalMs : null;
  for (const row of rows) {
    if (row.confirm === false) continue;
    const startTs = row.start_ts;
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    if (startTs == null || open == null || high == null || low == null || close == null) continue;
    if (!(high >= low) || !(high >= Math.max(open, close)) || !(low <= Math.min(open, close))) continue;
    if (cap != null && startTs > cap) continue;
    const volume = num(row.volume);
    out.push({
      startTs,
      open,
      high,
      low,
      close,
      volume: volume != null && volume >= 0 ? volume : null,
      confirm: true,
    });
  }
  out.sort((a, b) => a.startTs - b.startTs);
  return out;
}

function trueRange(bar: TaBar, prevClose: number): number {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** SMA ATR ending at last bar. Null until `period` true-ranges exist. */
export function atrSma(bars: TaBar[], period = 14): number | null {
  const end = bars.length - 1;
  if (end < period) return null;
  const start = end - period + 1;
  if (start < 1) return null;
  let sum = 0;
  for (let i = start; i <= end; i++) {
    sum += trueRange(bars[i]!, bars[i - 1]!.close);
  }
  const atr = sum / period;
  return atr > 0 ? atr : null;
}

export function sma(values: Array<number | null>, period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(-period);
  if (window.some((v) => v == null || !Number.isFinite(v))) return null;
  const sum = window.reduce<number>((acc, v) => acc + (v as number), 0);
  return sum / period;
}

export function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function lastEma(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  const v = series[series.length - 1];
  return v == null ? null : v;
}

/** Wilder RSI. Null until `period` changes exist. */
export function rsiWilder(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function roc(closes: number[], period = 10): number | null {
  if (closes.length < period + 1) return null;
  const prev = closes[closes.length - 1 - period]!;
  const last = closes[closes.length - 1]!;
  if (prev === 0) return null;
  return ((last - prev) / prev) * 100;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9): {
  macd: number;
  signal: number;
  hist: number;
} | null {
  if (closes.length < slow + signal) return null;
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  const line: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastE[i] == null || slowE[i] == null) continue;
    line.push(fastE[i]! - slowE[i]!);
  }
  if (line.length < signal) return null;
  const sigSeries = emaSeries(line, signal);
  const last = line[line.length - 1]!;
  const sig = sigSeries[sigSeries.length - 1];
  if (sig == null) return null;
  return { macd: last, signal: sig, hist: last - sig };
}

export function stochastic(bars: TaBar[], period = 14, smooth = 3): { k: number; d: number } | null {
  if (bars.length < period + smooth - 1) return null;
  const raw: number[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    const window = bars.slice(i - period + 1, i + 1);
    let hi = -Infinity;
    let lo = Infinity;
    for (const bar of window) {
      if (bar.high > hi) hi = bar.high;
      if (bar.low < lo) lo = bar.low;
    }
    const range = hi - lo;
    raw.push(range === 0 ? 50 : ((window[window.length - 1]!.close - lo) / range) * 100);
  }
  if (raw.length < smooth) return null;
  const k = sma(raw, smooth);
  const d = sma(raw, Math.min(smooth, raw.length));
  if (k == null || d == null) return null;
  return { k, d };
}

/** 3-bar fractal swings. Last bar cannot confirm. */
export function swingPoints(bars: TaBar[]): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1]!;
    const bar = bars[i]!;
    const next = bars[i + 1]!;
    if (bar.high > prev.high && bar.high > next.high) {
      highs.push({ index: i, price: bar.high, kind: "high" });
    }
    if (bar.low < prev.low && bar.low < next.low) {
      lows.push({ index: i, price: bar.low, kind: "low" });
    }
  }
  return { highs, lows };
}

/** Alternating XABCD-style path from last swings, newest last. */
export function alternatingSwings(bars: TaBar[], count: number): SwingPoint[] {
  const { highs, lows } = swingPoints(bars);
  const mixed = [...highs, ...lows].sort((a, b) => a.index - b.index);
  const out: SwingPoint[] = [];
  for (const pt of mixed) {
    const last = out[out.length - 1];
    if (last && last.kind === pt.kind) {
      if (pt.kind === "high" && pt.price >= last.price) out[out.length - 1] = pt;
      else if (pt.kind === "low" && pt.price <= last.price) out[out.length - 1] = pt;
      continue;
    }
    out.push(pt);
  }
  return out.slice(-count);
}

export function lastBar(bars: TaBar[]): TaBar | null {
  return bars.length ? bars[bars.length - 1]! : null;
}

export function closesOf(bars: TaBar[]): number[] {
  return bars.map((bar) => bar.close);
}
