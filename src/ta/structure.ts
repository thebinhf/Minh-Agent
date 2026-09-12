import { biasFromBars, type MapBias } from "../agent/bias";
import { detectZoneCards } from "../zones/detect";
import {
  alternatingSwings,
  atrSma,
  closesOf,
  lastBar,
  lastEma,
  roundPrice,
  swingPoints,
  type TaBar,
} from "./bars";

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export function fibonacci(bars: TaBar[]) {
  const swings = alternatingSwings(bars, 2);
  const last = lastBar(bars);
  if (swings.length < 2 || last == null) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const a = swings[0]!;
  const b = swings[1]!;
  const impulse = b.price - a.price;
  if (impulse === 0) return { quality: "missing" as const, reading: null, data: null };
  const levels = FIB_RATIOS.map((ratio) => ({
    ratio,
    price: roundPrice(b.price - impulse * ratio),
  }));
  let nearest = levels[0]!;
  let dist = Math.abs(last.close - nearest.price);
  for (const level of levels) {
    const d = Math.abs(last.close - level.price);
    if (d < dist) {
      nearest = level;
      dist = d;
    }
  }
  return {
    quality: "ok" as const,
    reading: `fib_${nearest.ratio}`,
    data: {
      from: roundPrice(a.price),
      to: roundPrice(b.price),
      direction: impulse > 0 ? "up" : "down",
      nearest: nearest.ratio,
      levels,
    },
  };
}

export function breakouts(bars: TaBar[]) {
  const { highs, lows } = swingPoints(bars);
  const last = lastBar(bars);
  const atr = atrSma(bars);
  if (!last || highs.length === 0 || lows.length === 0 || atr == null) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const swingHigh = highs[highs.length - 1]!;
  const swingLow = lows[lows.length - 1]!;
  const prev = bars[bars.length - 2];
  const pad = atr * 0.1;
  const bull = last.close > swingHigh.price + pad && prev != null && prev.close <= swingHigh.price;
  const bear = last.close < swingLow.price - pad && prev != null && prev.close >= swingLow.price;
  const reading = bull ? "bull_break" : bear ? "bear_break" : "inside";
  return {
    quality: "ok" as const,
    reading,
    data: {
      swingHigh: roundPrice(swingHigh.price),
      swingLow: roundPrice(swingLow.price),
    },
  };
}

function candleTags(bars: TaBar[]): string[] {
  if (bars.length < 2) return [];
  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  const range = last.high - last.low;
  if (range <= 0) return ["doji"];
  const body = Math.abs(last.close - last.open);
  const upper = last.high - Math.max(last.open, last.close);
  const lower = Math.min(last.open, last.close) - last.low;
  const tags: string[] = [];
  if (body <= range * 0.1) tags.push("doji");
  if (lower >= body * 2 && last.close >= last.low + range * 0.66) tags.push("hammer");
  if (upper >= body * 2 && last.close <= last.high - range * 0.66) tags.push("shooting_star");
  if (lower >= body * 2 || upper >= body * 2) tags.push("pin");
  const prevBody = Math.abs(prev.close - prev.open);
  const prevBear = prev.close < prev.open;
  const prevBull = prev.close > prev.open;
  const lastBull = last.close > last.open;
  const lastBear = last.close < last.open;
  if (prevBear && lastBull && last.open <= prev.close && last.close >= prev.open && body > prevBody) {
    tags.push("bullish_engulfing");
  }
  if (prevBull && lastBear && last.open >= prev.close && last.close <= prev.open && body > prevBody) {
    tags.push("bearish_engulfing");
  }
  return tags;
}

export function reversal(bars: TaBar[]) {
  const br = breakouts(bars);
  const last = lastBar(bars);
  const { highs, lows } = swingPoints(bars);
  if (!last || br.quality === "missing") {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const tags = candleTags(bars);
  const atLow = lows.length > 0 && last.low <= lows[lows.length - 1]!.price;
  const atHigh = highs.length > 0 && last.high >= highs[highs.length - 1]!.price;
  let reading: string | null = null;
  if (br.reading === "bull_break" && last.close < (br.data?.swingHigh ?? last.close)) reading = "failed_bull_break";
  if (br.reading === "bear_break" && last.close > (br.data?.swingLow ?? last.close)) reading = "failed_bear_break";
  if (atLow && (tags.includes("hammer") || tags.includes("bullish_engulfing"))) reading = "bull_reversal";
  if (atHigh && (tags.includes("shooting_star") || tags.includes("bearish_engulfing"))) reading = "bear_reversal";
  return {
    quality: "ok" as const,
    reading,
    data: { tags, atLow, atHigh },
  };
}

export function supportResistance(bars: TaBar[]) {
  const { highs, lows } = swingPoints(bars);
  if (highs.length === 0 && lows.length === 0) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const last = lastBar(bars);
  const resistance = highs.slice(-4).map((p) => roundPrice(p.price));
  const support = lows.slice(-4).map((p) => roundPrice(p.price));
  let reading: string | null = null;
  if (last) {
    const nearS = support.some((p) => Math.abs(last.close - p) / last.close < 0.002);
    const nearR = resistance.some((p) => Math.abs(last.close - p) / last.close < 0.002);
    if (nearS) reading = "at_support";
    else if (nearR) reading = "at_resistance";
    else reading = "between";
  }
  return {
    quality: "ok" as const,
    reading,
    data: { support, resistance },
  };
}

export function dynamicSr(bars: TaBar[]) {
  const closes = closesOf(bars);
  const ema20 = lastEma(closes, 20);
  const ema50 = lastEma(closes, 50);
  const last = lastBar(bars);
  if (ema20 == null || last == null) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const reading = last.close >= ema20 ? "above_ema20" : "below_ema20";
  return {
    quality: "ok" as const,
    reading,
    data: {
      ema20: roundPrice(ema20),
      ema50: ema50 == null ? null : roundPrice(ema50),
    },
  };
}

export function trendLines(bars: TaBar[]) {
  const { highs, lows } = swingPoints(bars);
  if (highs.length < 2 && lows.length < 2) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const last = lastBar(bars);
  const support = lows.length >= 2
    ? lineAt(lows[lows.length - 2]!, lows[lows.length - 1]!, bars.length - 1)
    : null;
  const resistance = highs.length >= 2
    ? lineAt(highs[highs.length - 2]!, highs[highs.length - 1]!, bars.length - 1)
    : null;
  let reading: string | null = null;
  if (last && support != null && last.close >= support) reading = "above_support";
  if (last && resistance != null && last.close <= resistance) reading = "below_resistance";
  if (last && support != null && resistance != null && last.close > support && last.close < resistance) {
    reading = "in_channel";
  }
  return {
    quality: "ok" as const,
    reading,
    data: {
      support: support == null ? null : roundPrice(support),
      resistance: resistance == null ? null : roundPrice(resistance),
    },
  };
}

function lineAt(
  a: { index: number; price: number },
  b: { index: number; price: number },
  x: number,
): number | null {
  const dx = b.index - a.index;
  if (dx === 0) return null;
  const slope = (b.price - a.price) / dx;
  return a.price + slope * (x - a.index);
}

export function marketStructure(bars: TaBar[]) {
  if (bars.length < 5) return { quality: "missing" as const, reading: null, data: null };
  const biasBars = bars.map((bar) => ({
    startTs: bar.startTs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
  const bias: MapBias = biasFromBars(biasBars);
  const { highs, lows } = swingPoints(bars);
  return {
    quality: "ok" as const,
    reading: bias,
    data: {
      swingHighs: highs.slice(-2).map((p) => roundPrice(p.price)),
      swingLows: lows.slice(-2).map((p) => roundPrice(p.price)),
    },
  };
}

export function bos(bars: TaBar[]) {
  const { highs, lows } = swingPoints(bars);
  const last = lastBar(bars);
  if (!last || highs.length === 0 || lows.length === 0) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const lastH = highs[highs.length - 1]!;
  const lastL = lows[lows.length - 1]!;
  let reading: string | null = "none";
  if (last.close > lastH.price) reading = "bull_bos";
  else if (last.close < lastL.price) reading = "bear_bos";
  return {
    quality: "ok" as const,
    reading,
    data: {
      swingHigh: roundPrice(lastH.price),
      swingLow: roundPrice(lastL.price),
    },
  };
}

export function choch(bars: TaBar[]) {
  const structure = marketStructure(bars);
  const last = lastBar(bars);
  const { highs, lows } = swingPoints(bars);
  if (structure.quality === "missing" || !last || highs.length === 0 || lows.length === 0) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const lastH = highs[highs.length - 1]!;
  const lastL = lows[lows.length - 1]!;
  let reading: string | null = "none";
  if (structure.reading === "bull" && last.close < lastL.price) reading = "bear_choch";
  else if (structure.reading === "bear" && last.close > lastH.price) reading = "bull_choch";
  return {
    quality: "ok" as const,
    reading,
    data: { structure: structure.reading },
  };
}

export function supplyDemand(
  bars: TaBar[],
  opts: { symbol: string; tf: string; intervalMs: number },
) {
  if (bars.length < 16) return { quality: "missing" as const, reading: null, data: null };
  const detectBars = bars.map((bar) => ({
    startTs: bar.startTs,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    confirm: bar.confirm,
  }));
  const cards = detectZoneCards(detectBars, {
    symbol: opts.symbol,
    tf: opts.tf,
    intervalMs: opts.intervalMs,
  });
  const demand = cards.filter((c) => c.side === "demand").length;
  const supply = cards.filter((c) => c.side === "supply").length;
  return {
    quality: "ok" as const,
    reading: cards.length === 0 ? "none" : demand && !supply ? "demand" : supply && !demand ? "supply" : "both",
    data: {
      count: cards.length,
      zoneIds: cards.map((c) => c.zoneId),
      suggestOnly: true,
      autoArm: false,
    },
  };
}

export { candleTags };

