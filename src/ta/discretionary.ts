import {
  alternatingSwings,
  atrSma,
  lastBar,
  roundPrice,
  roundRatio,
  type TaBar,
} from "./bars";

/** Known new moon 2000-01-06 18:14 UTC. Synodic month, not a price input. */
const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0);
const SYNODIC_DAYS = 29.530588853;

const MOON_NAMES = [
  "new",
  "waxing_crescent",
  "first_quarter",
  "waxing_gibbous",
  "full",
  "waning_gibbous",
  "last_quarter",
  "waning_crescent",
] as const;

export function moonPhases(asof: number) {
  if (!Number.isFinite(asof) || asof <= 0) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const days = (asof - KNOWN_NEW_MOON_MS) / 86_400_000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const frac = age / SYNODIC_DAYS;
  const illum = (1 - Math.cos(2 * Math.PI * frac)) / 2;
  const bucket = Math.round(frac * 8) % 8;
  const reading = MOON_NAMES[bucket]!;
  return {
    quality: "ok" as const,
    reading,
    data: {
      ageDays: Number(age.toFixed(4)),
      illumination: Number(illum.toFixed(4)),
      notPrice: true,
    },
  };
}

export function fvg(bars: TaBar[]) {
  if (bars.length < 3) return { quality: "missing" as const, reading: null, data: null };
  const gaps: Array<{
    side: "bull" | "bear";
    low: number;
    high: number;
    startTs: number;
    filled: boolean;
  }> = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2]!;
    const c = bars[i]!;
    if (a.high < c.low) {
      const low = a.high;
      const high = c.low;
      const filled = bars.slice(i + 1).some((bar) => bar.low <= high && bar.high >= low);
      gaps.push({ side: "bull", low, high, startTs: c.startTs, filled });
    } else if (a.low > c.high) {
      const low = c.high;
      const high = a.low;
      const filled = bars.slice(i + 1).some((bar) => bar.high >= low && bar.low <= high);
      gaps.push({ side: "bear", low, high, startTs: c.startTs, filled });
    }
  }
  const open = gaps.filter((g) => !g.filled);
  const latest = open[open.length - 1] ?? gaps[gaps.length - 1] ?? null;
  return {
    quality: "ok" as const,
    reading: latest == null ? "none" : `${latest.side}_${latest.filled ? "filled" : "open"}`,
    data: {
      count: gaps.length,
      open: open.length,
      latest: latest == null
        ? null
        : { side: latest.side, low: roundPrice(latest.low), high: roundPrice(latest.high), filled: latest.filled },
      ictAsSignal: false,
    },
  };
}

export function elliott(bars: TaBar[]) {
  const swings = alternatingSwings(bars, 6);
  if (swings.length < 5) return { quality: "missing" as const, reading: null, data: null };
  const five = swings.slice(-5);
  const waves = [];
  for (let i = 1; i < five.length; i++) {
    waves.push(five[i]!.price - five[i - 1]!.price);
  }
  if (waves.length !== 4) return { quality: "missing" as const, reading: null, data: null };
  const up = five[0]!.kind === "low";
  const impulse = up
    ? waves[0]! > 0 && waves[1]! < 0 && waves[2]! > 0 && waves[3]! < 0
    : waves[0]! < 0 && waves[1]! > 0 && waves[2]! < 0 && waves[3]! > 0;
  const w1 = Math.abs(waves[0]!);
  const w3 = Math.abs(waves[2]!);
  const reading = impulse && w3 >= w1 ? (up ? "impulse_up" : "impulse_down") : "corrective";
  return {
    quality: "ok" as const,
    reading,
    data: {
      discretionary: true,
      points: five.map((p) => ({ kind: p.kind, price: roundPrice(p.price) })),
    },
  };
}

const HARMONIC_TOL = 0.12;

function near(value: number, target: number, tol = HARMONIC_TOL): boolean {
  if (target === 0) return false;
  return Math.abs(value - target) / target <= tol;
}

function inBand(value: number, lo: number, hi: number): boolean {
  return value >= lo * (1 - HARMONIC_TOL) && value <= hi * (1 + HARMONIC_TOL);
}

export function harmonic(bars: TaBar[]) {
  const pts = alternatingSwings(bars, 5);
  if (pts.length < 5) return { quality: "missing" as const, reading: null, data: null };
  const [x, a, b, c, d] = pts;
  const xa = Math.abs(a!.price - x!.price);
  const ab = Math.abs(b!.price - a!.price);
  const bc = Math.abs(c!.price - b!.price);
  const xd = Math.abs(d!.price - x!.price);
  if (xa === 0 || ab === 0) return { quality: "missing" as const, reading: null, data: null };
  const abXa = ab / xa;
  const bcAb = bc / ab;
  const xdXa = xd / xa;
  let pattern: string | null = null;
  if (near(abXa, 0.618) && inBand(bcAb, 0.382, 0.886) && near(xdXa, 0.786)) pattern = "gartley";
  else if (inBand(abXa, 0.382, 0.5) && near(xdXa, 0.886)) pattern = "bat";
  else if (near(abXa, 0.786) && inBand(xdXa, 1.27, 1.618)) pattern = "butterfly";
  else if (inBand(abXa, 0.382, 0.618) && near(xdXa, 1.618)) pattern = "crab";
  return {
    quality: "ok" as const,
    reading: pattern,
    data: {
      discretionary: true,
      abXa: roundRatio(abXa),
      bcAb: roundRatio(bcAb),
      xdXa: roundRatio(xdXa),
    },
  };
}

export function gann(bars: TaBar[]) {
  const atr = atrSma(bars);
  const last = lastBar(bars);
  const swings = alternatingSwings(bars, 1);
  if (atr == null || !last || swings.length === 0) {
    return { quality: "missing" as const, reading: null, data: null };
  }
  const origin = swings[0]!;
  const steps = (bars.length - 1) - origin.index;
  const oneByOne = origin.kind === "low"
    ? origin.price + steps * atr
    : origin.price - steps * atr;
  const reading = last.close >= oneByOne ? "above_1x1" : "below_1x1";
  return {
    quality: "ok" as const,
    reading,
    data: {
      discretionary: true,
      origin: roundPrice(origin.price),
      oneByOne: roundPrice(oneByOne),
      atr: roundPrice(atr),
    },
  };
}
