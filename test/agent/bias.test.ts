import { describe, expect, test } from "bun:test";
import {
  BIAS_MID_RANGE,
  barsFromMapKlines,
  biasFromBars,
  biasFromMapItem,
  combineHtfBias,
  isMapBias,
  readMapBias,
  type BiasBar,
} from "../../src/agent/bias";

function bar(startTs: number, open: number, high: number, low: number, close: number): BiasBar {
  return { startTs, open, high, low, close };
}

/** Closes climb into the top of a 100–120 swing. */
function rising(count = 8): BiasBar[] {
  const out: BiasBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = 110 + i;
    out.push(bar(1_000 + i, close - 1, 120, 100, close));
  }
  return out;
}

/** Closes fall into the bottom of a 100–120 swing. */
function falling(count = 8): BiasBar[] {
  const out: BiasBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = 110 - i;
    out.push(bar(1_000 + i, close + 1, 120, 100, close));
  }
  return out;
}

function midRange(count = 8): BiasBar[] {
  const out: BiasBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = 109 + (i % 2);
    out.push(bar(1_000 + i, close, 120, 100, close));
  }
  return out;
}

function kline(startTs: number, open: number, high: number, low: number, close: number, confirm = true) {
  return {
    start_ts: startTs,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "1",
    turnover: "1",
    confirm,
  };
}

describe("MAP bias", () => {
  test("empty or single bar is aside; mid-range is aside", () => {
    expect(biasFromBars([])).toBe("aside");
    expect(biasFromBars([bar(1, 1, 2, 0, 1)])).toBe("aside");
    expect(biasFromBars(midRange())).toBe("aside");
    expect(BIAS_MID_RANGE).toEqual({ low: 0.35, high: 0.65 });
  });

  test("rising closes at the top of the swing are bull; falling at the bottom are bear", () => {
    expect(biasFromBars(rising())).toBe("bull");
    expect(biasFromBars(falling())).toBe("bear");
    expect(biasFromBars(rising())).toBe(biasFromBars(rising()));
  });

  test("combineHtfBias requires 4H and 1H to agree", () => {
    expect(combineHtfBias("bull", "bull")).toBe("bull");
    expect(combineHtfBias("bear", "bear")).toBe("bear");
    expect(combineHtfBias("bull", "bear")).toBe("aside");
    expect(combineHtfBias("bear", "bull")).toBe("aside");
    expect(combineHtfBias("bull", "aside")).toBe("aside");
    expect(combineHtfBias("aside", "bull")).toBe("aside");
  });

  test("readMapBias walks /map batch or a single snapshot; skips unconfirmed bars", () => {
    const map = {
      maps: [{
        symbol: "btcusdt",
        klines: {
          "240": rising().map((row) => kline(row.startTs, row.open, row.high, row.low, row.close)),
          "60": rising().map((row) => kline(row.startTs, row.open, row.high, row.low, row.close)),
        },
        klineLag: { ok: true, rows: [] },
      }],
    };
    const biases = readMapBias(map);
    expect(biases.get("BTCUSDT")?.htf).toBe("bull");
    expect(biases.get("BTCUSDT")?.["240"]).toBe("bull");
    expect(biases.get("BTCUSDT")?.klineLagOk).toBe(true);

    const single = biasFromMapItem({
      symbol: "ETHUSDT",
      klines: {
        "240": falling().map((row) => kline(row.startTs, row.open, row.high, row.low, row.close)),
        "60": falling().map((row) => kline(row.startTs, row.open, row.high, row.low, row.close)),
      },
      klineLag: {
        ok: false,
        rows: [{ symbol: "ETHUSDT", interval: "240", stale: true }],
      },
    });
    expect(single?.htf).toBe("bear");
    expect(single?.klineLagOk).toBe(false);

    const mixed = biasFromMapItem({
      symbol: "SOLUSDT",
      klines: {
        "240": rising().map((row) => kline(row.startTs, row.open, row.high, row.low, row.close)),
        "60": falling().map((row) => kline(row.startTs, row.open, row.high, row.low, row.close)),
      },
    });
    expect(mixed?.htf).toBe("aside");

    expect(barsFromMapKlines([
      kline(1, 1, 2, 0, 1.5, false),
      kline(2, 1, 2, 0, 1.6, true),
    ])).toHaveLength(1);
    expect(isMapBias("bull")).toBe(true);
    expect(isMapBias("up")).toBe(false);
    expect(readMapBias(null).size).toBe(0);
  });
});
