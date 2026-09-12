import { intervalToMs } from "../feed/bb/recovery";
import { type TaBar } from "./bars";
import { TA_METHODS, type TaMethodId, type TaMethodMeta } from "./catalog";
import { candlesticks, heikinAshi, renko } from "./candle";
import { elliott, fvg, gann, harmonic, moonPhases } from "./discretionary";
import { divergence, momentum, oscillators, volume } from "./oscillator";
import {
  bos,
  breakouts,
  choch,
  dynamicSr,
  fibonacci,
  marketStructure,
  reversal,
  supplyDemand,
  supportResistance,
  trendLines,
} from "./structure";

export type TaQuality = "ok" | "missing";

export type TaMethodResult = TaMethodMeta & {
  signal: false;
  quality: TaQuality;
  reading: string | null;
  data: unknown;
};

export type TaPackOpts = {
  symbol: string;
  tf: string;
  intervalMs: number;
  asof: number;
};

function wrap(
  meta: TaMethodMeta,
  row: { quality: TaQuality; reading: string | null; data: unknown },
): TaMethodResult {
  return {
    ...meta,
    signal: false,
    quality: row.quality,
    reading: row.reading,
    data: row.data,
  };
}

export function emptyMethod(meta: TaMethodMeta): TaMethodResult {
  return wrap(meta, { quality: "missing", reading: null, data: null });
}

const DETECTORS: Record<
  TaMethodId,
  (bars: TaBar[], opts: TaPackOpts) => { quality: TaQuality; reading: string | null; data: unknown }
> = {
  fibonacci: (bars) => fibonacci(bars),
  breakouts: (bars) => breakouts(bars),
  reversal: (bars) => reversal(bars),
  elliott: (bars) => elliott(bars),
  fvg: (bars) => fvg(bars),
  candlesticks: (bars) => candlesticks(bars),
  heikin_ashi: (bars) => heikinAshi(bars),
  moon_phases: (_bars, opts) => moonPhases(opts.asof),
  renko: (bars) => renko(bars),
  harmonic: (bars) => harmonic(bars),
  support_resistance: (bars) => supportResistance(bars),
  dynamic_sr: (bars) => dynamicSr(bars),
  trend_lines: (bars) => trendLines(bars),
  gann: (bars) => gann(bars),
  momentum: (bars) => momentum(bars),
  oscillators: (bars) => oscillators(bars),
  divergence: (bars) => divergence(bars),
  volume: (bars) => volume(bars),
  supply_demand: (bars, opts) => supplyDemand(bars, {
    symbol: opts.symbol,
    tf: opts.tf,
    intervalMs: opts.intervalMs,
  }),
  market_structure: (bars) => marketStructure(bars),
  bos: (bars) => bos(bars),
  choch: (bars) => choch(bars),
};

export function packMethods(bars: TaBar[], opts: TaPackOpts): Record<TaMethodId, TaMethodResult> {
  const out = {} as Record<TaMethodId, TaMethodResult>;
  for (const meta of TA_METHODS) {
    out[meta.id] = wrap(meta, DETECTORS[meta.id](bars, opts));
  }
  return out;
}

export function packIntervalMs(tf: string): number {
  return intervalToMs(tf);
}

