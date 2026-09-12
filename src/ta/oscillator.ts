import {
  closesOf,
  lastBar,
  macd,
  roc,
  rsiWilder,
  sma,
  stochastic,
  swingPoints,
  type TaBar,
} from "./bars";

export function momentum(bars: TaBar[]) {
  const closes = closesOf(bars);
  const value = roc(closes, 10);
  if (value == null) return { quality: "missing" as const, reading: null, data: null };
  const reading = value > 0 ? "roc_up" : value < 0 ? "roc_down" : "flat";
  return {
    quality: "ok" as const,
    reading,
    data: { roc10: Number(value.toFixed(4)) },
  };
}

export function oscillators(bars: TaBar[]) {
  const closes = closesOf(bars);
  const rsi = rsiWilder(closes, 14);
  const macdRow = macd(closes);
  const stoch = stochastic(bars);
  if (rsi == null && macdRow == null && stoch == null) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  let reading: string | null = null;
  if (rsi != null) {
    if (rsi >= 70) reading = "rsi_overbought";
    else if (rsi <= 30) reading = "rsi_oversold";
    else reading = "rsi_mid";
  }
  return {
    quality: "ok" as const,
    reading,
    data: {
      rsi14: rsi == null ? null : Number(rsi.toFixed(2)),
      macd: macdRow == null ? null : {
        macd: Number(macdRow.macd.toFixed(6)),
        signal: Number(macdRow.signal.toFixed(6)),
        hist: Number(macdRow.hist.toFixed(6)),
      },
      stoch: stoch == null ? null : {
        k: Number(stoch.k.toFixed(2)),
        d: Number(stoch.d.toFixed(2)),
      },
    },
  };
}

export function divergence(bars: TaBar[]) {
  const closes = closesOf(bars);
  const { highs, lows } = swingPoints(bars);
  if (highs.length < 2 || lows.length < 2 || closes.length < 16) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const rsiAt = (index: number): number | null => rsiWilder(closes.slice(0, index + 1), 14);
  const h1 = highs[highs.length - 2]!;
  const h2 = highs[highs.length - 1]!;
  const l1 = lows[lows.length - 2]!;
  const l2 = lows[lows.length - 1]!;
  const rsiH1 = rsiAt(h1.index);
  const rsiH2 = rsiAt(h2.index);
  const rsiL1 = rsiAt(l1.index);
  const rsiL2 = rsiAt(l2.index);
  let reading: string | null = "none";
  if (rsiH1 != null && rsiH2 != null && h2.price > h1.price && rsiH2 < rsiH1) reading = "bearish_div";
  if (rsiL1 != null && rsiL2 != null && l2.price < l1.price && rsiL2 > rsiL1) reading = "bullish_div";
  return {
    quality: "ok" as const,
    reading,
    data: {
      rsiHighs: [rsiH1, rsiH2],
      rsiLows: [rsiL1, rsiL2],
    },
  };
}

export function volume(bars: TaBar[]) {
  const vols = bars.map((bar) => bar.volume);
  const last = lastBar(bars);
  if (!last || last.volume == null) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const mean = sma(vols, 20);
  if (mean == null || mean <= 0) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const rel = last.volume / mean;
  const reading = rel >= 2 ? "climax" : rel >= 1.2 ? "above_avg" : rel <= 0.5 ? "dry" : "avg";
  return {
    quality: "ok" as const,
    reading,
    data: { last: last.volume, sma20: Number(mean.toFixed(4)), rel: Number(rel.toFixed(4)) },
  };
}
