import { describe, expect, test } from "bun:test";
import {
  barsFromMapKlines,
  biasFromBars,
  biasFromMapItem,
  combineHtfBias,
  isMapBias,
  isMidRange,
  nearestSwing,
  readMapBias,
  swingPoints,
} from "../../src/agent/bias";
import { bullBars, bearBars, chopBars, klineOf, mapPayload } from "./htf";

describe("MAP bias (HH/HL)", () => {
  test("4H HH/HL = bull, LH/LL = bear, mixed = chop; not enough swings = chop", () => {
    const bull = swingPoints(bullBars());
    expect(bull.highs.map((row) => row.price)).toEqual([79_200, 79_800, 80_400]);
    expect(bull.lows.map((row) => row.price)).toEqual([77_800, 78_100]);
    expect(biasFromBars(bullBars())).toBe("bull");
    expect(nearestSwing(bullBars())).toEqual({ high: 80_400, low: 78_100 });

    const bear = swingPoints(bearBars());
    expect(bear.highs.map((row) => row.price)).toEqual([81_000, 80_200]);
    expect(bear.lows.map((row) => row.price)).toEqual([78_800, 78_200]);
    expect(biasFromBars(bearBars())).toBe("bear");

    expect(biasFromBars(chopBars())).toBe("chop");
    expect(biasFromBars([])).toBe("chop");
    expect(biasFromBars([{ startTs: 1, open: 1, high: 2, low: 0, close: 1 }])).toBe("chop");
    expect(biasFromBars(bullBars())).toBe(biasFromBars(bullBars()));
  });

  test("1H chop → stand aside; 1H must not oppose 4H", () => {
    expect(combineHtfBias("bull", "bull")).toBe("bull");
    expect(combineHtfBias("bear", "bear")).toBe("bear");
    expect(combineHtfBias("bull", "bear")).toBe("chop");
    expect(combineHtfBias("bear", "bull")).toBe("chop");
    expect(combineHtfBias("bull", "chop")).toBe("chop");
    expect(combineHtfBias("chop", "bull")).toBe("chop");
    expect(combineHtfBias("chop", "chop")).toBe("chop");
  });

  test("mid-range is last strictly between nearest swing H/L (policy input, not bias)", () => {
    const swing = nearestSwing(bullBars());
    expect(isMidRange(79_200, swing)).toBe(true);
    expect(isMidRange(80_400, swing)).toBe(false);
    expect(isMidRange(78_100, swing)).toBe(false);
    expect(isMidRange(81_000, swing)).toBe(false);
    expect(isMidRange(undefined, swing)).toBe(false);
  });

  test("readMapBias walks /map batch; 1H oppose → chop; skips unconfirmed; lag rows", () => {
    const biases = readMapBias(mapPayload({ direction: "bull", lastPrice: "79450" }));
    expect(biases.get("BTCUSDT")?.htf).toBe("bull");
    expect(biases.get("BTCUSDT")?.["240"]).toBe("bull");
    expect(biases.get("BTCUSDT")?.klineLagOk).toBe(true);

    const opposed = biasFromMapItem(mapPayload({
      direction: "bull",
      hour: "bear",
      lastPrice: "79450",
    }).maps[0]);
    expect(opposed?.["240"]).toBe("bull");
    expect(opposed?.["60"]).toBe("bear");
    expect(opposed?.htf).toBe("chop");

    const chop1h = biasFromMapItem(mapPayload({
      direction: "bull",
      hour: "chop",
      lastPrice: "79450",
      lagOk: false,
    }).maps[0]);
    expect(chop1h?.htf).toBe("chop");
    expect(chop1h?.klineLagOk).toBe(false);

    expect(barsFromMapKlines([
      klineOf({ startTs: 1, open: 1, high: 2, low: 0, close: 1.5 }, false),
      klineOf({ startTs: 2, open: 1, high: 2, low: 0, close: 1.6 }, true),
    ])).toHaveLength(1);
    expect(isMapBias("bull")).toBe(true);
    expect(isMapBias("aside")).toBe(false);
    expect(readMapBias(null).size).toBe(0);
  });
});
