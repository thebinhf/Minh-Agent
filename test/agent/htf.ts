import type { BiasBar } from "../../src/agent/bias";

function bar(startTs: number, high: number, low: number, close?: number): BiasBar {
  const mid = (high + low) / 2;
  const c = close ?? mid;
  return { startTs, open: mid, high, low, close: c };
}

/** HH + HL. Nearest swing H=80400 L=78100. */
export function bullBars(): BiasBar[] {
  return [
    bar(1, 78_500, 78_000, 78_400),
    bar(2, 79_200, 78_300, 79_000),
    bar(3, 78_600, 77_800, 78_000),
    bar(4, 79_800, 78_200, 79_600),
    bar(5, 79_000, 78_100, 78_600),
    bar(6, 80_400, 78_600, 80_000),
    bar(7, 79_500, 78_800, 79_200),
  ];
}

/** LH + LL. Nearest swing H=80200 L=78200. */
export function bearBars(): BiasBar[] {
  return [
    bar(1, 80_000, 79_000, 79_600),
    bar(2, 81_000, 79_200, 80_600),
    bar(3, 79_500, 78_800, 79_200),
    bar(4, 80_200, 78_900, 79_800),
    bar(5, 79_600, 78_200, 78_600),
    bar(6, 79_000, 78_400, 78_800),
  ];
}

/** HH + LL = mixed chop. */
export function chopBars(): BiasBar[] {
  return [
    bar(1, 79_200, 78_800, 79_000),
    bar(2, 79_800, 78_900, 79_500),
    bar(3, 79_400, 78_500, 78_800),
    bar(4, 80_200, 78_600, 79_800),
    bar(5, 79_600, 77_900, 78_400),
    bar(6, 79_200, 78_200, 78_600),
  ];
}

export function klineOf(row: BiasBar, confirm = true) {
  return {
    start_ts: row.startTs,
    open: String(row.open),
    high: String(row.high),
    low: String(row.low),
    close: String(row.close),
    volume: "1",
    turnover: "1",
    confirm,
  };
}

export function mapPayload(opts: {
  direction: "bull" | "bear" | "chop";
  lastPrice: string;
  hour?: "bull" | "bear" | "chop";
  lagOk?: boolean;
}) {
  const series = opts.direction === "bull" ? bullBars() : opts.direction === "bear" ? bearBars() : chopBars();
  const hour = (opts.hour ?? opts.direction) === "bull"
    ? bullBars()
    : (opts.hour ?? opts.direction) === "bear"
      ? bearBars()
      : chopBars();
  return {
    maps: [{
      symbol: "BTCUSDT",
      ticker: { lastPrice: opts.lastPrice },
      klines: {
        "240": series.map((row) => klineOf(row)),
        "60": hour.map((row) => klineOf(row)),
        D: [],
      },
      klineLag: {
        ok: opts.lagOk !== false,
        rows: opts.lagOk === false
          ? [{ symbol: "BTCUSDT", interval: "240", stale: true }]
          : [],
      },
    }],
  };
}

export const HEALTH_OK = { ok: true, url: "http://127.0.0.1:43180/health", klineLagOk: true };
