import { atrSma, lastBar, type TaBar } from "./bars";
import { candleTags } from "./structure";

export function candlesticks(bars: TaBar[]) {
  const last = lastBar(bars);
  if (!last) return { quality: "missing" as const, reading: null, data: null };
  const tags = candleTags(bars);
  const body = last.close - last.open;
  const reading = tags[0] ?? (body > 0 ? "bull" : body < 0 ? "bear" : "doji");
  return {
    quality: "ok" as const,
    reading,
    data: { tags },
  };
}

type HaBar = { open: number; high: number; low: number; close: number };

function heikinSeries(bars: TaBar[]): HaBar[] {
  const out: HaBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const open = i === 0
      ? (bar.open + bar.close) / 2
      : (out[i - 1]!.open + out[i - 1]!.close) / 2;
    out.push({
      open,
      close,
      high: Math.max(bar.high, open, close),
      low: Math.min(bar.low, open, close),
    });
  }
  return out;
}

export function heikinAshi(bars: TaBar[]) {
  if (bars.length < 3) return { quality: "missing" as const, reading: null, data: null };
  const series = heikinSeries(bars);
  const last = series[series.length - 1]!;
  const bull = last.close >= last.open;
  let run = 1;
  for (let i = series.length - 2; i >= 0; i--) {
    const bar = series[i]!;
    const same = (bar.close >= bar.open) === bull;
    if (!same) break;
    run += 1;
  }
  return {
    quality: "ok" as const,
    reading: bull ? "ha_bull" : "ha_bear",
    data: { run, close: last.close, open: last.open },
  };
}

export function renko(bars: TaBar[]) {
  const atr = atrSma(bars);
  const last = lastBar(bars);
  if (atr == null || !last || bars.length < 5) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const brick = atr;
  let level = bars[0]!.close;
  let dir: 1 | -1 | 0 = 0;
  let run = 0;
  for (let i = 1; i < bars.length; i++) {
    const close = bars[i]!.close;
    while (close >= level + brick) {
      level += brick;
      if (dir === 1) run += 1;
      else {
        dir = 1;
        run = 1;
      }
    }
    while (close <= level - brick) {
      level -= brick;
      if (dir === -1) run += 1;
      else {
        dir = -1;
        run = 1;
      }
    }
  }
  const reading = dir === 1 ? "renko_up" : dir === -1 ? "renko_down" : "none";
  return {
    quality: "ok" as const,
    reading,
    data: { brick, run, level },
  };
}
