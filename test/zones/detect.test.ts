import { describe, expect, test } from "bun:test";
import { parseZoneCard } from "../../src/zones/card";
import {
  ZONE_DETECT,
  atrSma,
  detectZoneCards,
  intervalMsForTf,
  parseZoneInterval,
  type DetectBar,
} from "../../src/zones/detect";

const TF = "240";
const INTERVAL_MS = intervalMsForTf(TF);

function bar(i: number, partial: Partial<DetectBar> & Pick<DetectBar, "open" | "high" | "low" | "close">): DetectBar {
  return {
    startTs: i * INTERVAL_MS,
    confirm: true,
    ...partial,
  };
}

/** 16 ranging bars (~ATR 2) then a 2-bar base and a bearish impulse. */
function supplySeries(opts?: { retestHigh?: number }): DetectBar[] {
  const bars: DetectBar[] = [];
  for (let i = 0; i < 16; i++) {
    bars.push(bar(i, { open: 100, high: 101, low: 99, close: 100 }));
  }
  bars.push(bar(16, { open: 100, high: 101, low: 99, close: 100.2 }));
  bars.push(bar(17, { open: 100, high: 101, low: 80, close: 82 }));
  if (opts?.retestHigh != null) {
    bars.push(bar(18, { open: 84, high: opts.retestHigh, low: 83, close: 85 }));
  } else {
    bars.push(bar(18, { open: 82, high: 86, low: 80, close: 84 }));
  }
  return bars;
}

function demandSeries(): DetectBar[] {
  const bars: DetectBar[] = [];
  for (let i = 0; i < 16; i++) {
    bars.push(bar(i, { open: 100, high: 101, low: 99, close: 100 }));
  }
  bars.push(bar(16, { open: 100, high: 101, low: 99, close: 99.8 }));
  bars.push(bar(17, { open: 100, high: 120, low: 99, close: 118 }));
  bars.push(bar(18, { open: 118, high: 122, low: 116, close: 120 }));
  return bars;
}

describe("zone detect (suggest-only)", () => {
  test("interval parser is HTF-only", () => {
    expect(parseZoneInterval(null)).toBe("240");
    expect(parseZoneInterval("60")).toBe("60");
    expect(parseZoneInterval("15")).toBeNull();
    expect(parseZoneInterval("5")).toBeNull();
  });

  test("ATR SMA needs 14 true ranges", () => {
    const bars = supplySeries();
    expect(atrSma(bars, 13)).toBeNull();
    expect(atrSma(bars, 14)).not.toBeNull();
    expect(atrSma(bars, 15)!).toBeGreaterThan(1);
  });

  test("finds a virgin supply card with RR ≥ 2 and does not invent cancel codes", () => {
    const cards = detectZoneCards(supplySeries(), {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(cards.length).toBeGreaterThan(0);
    const card = parseZoneCard(cards[0]!);
    expect(card.symbol).toBe("BTCUSDT");
    expect(card.tf).toBe("240");
    expect(card.side).toBe("supply");
    expect(card.freshness).toBe("virgin");
    expect(card.penetrationPct).toBe(0);
    expect(card.rr).toBeGreaterThanOrEqual(ZONE_DETECT.minRr);
    expect(card.entry).toBeGreaterThanOrEqual(card.zoneLow);
    expect(card.entry).toBeLessThanOrEqual(card.zoneHigh);
    expect(card.sl).toBeGreaterThanOrEqual(card.distal);
    expect(card.hardInvalid).toBe(card.sl);
    expect(card.softInvalid).toBe(card.distal);
    expect(card.cancelCodes).toEqual([]);
    expect(card.zoneId).toMatch(/^btc-4h-s-\d{8}-01$/);
    expect(card.expiryBars).toBe(48);
  });

  test("finds a demand card after a bullish impulse", () => {
    const cards = detectZoneCards(demandSeries(), {
      symbol: "ETHUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(cards.some((card) => card.side === "demand")).toBe(true);
    const demand = parseZoneCard(cards.find((card) => card.side === "demand")!);
    expect(demand.distal).toBe(demand.zoneLow);
    expect(demand.proximal).toBe(demand.zoneHigh);
    expect(demand.tp).toBeGreaterThan(demand.entry);
    expect(demand.zoneId.startsWith("eth-4h-d-")).toBe(true);
  });

  test("drops deep-mitigated bases", () => {
    const virgin = detectZoneCards(supplySeries(), {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(virgin.length).toBeGreaterThan(0);
    const deep = detectZoneCards(supplySeries({ retestHigh: 101 }), {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(deep.filter((card) => card.freshness === "deep")).toEqual([]);
    expect(deep.length).toBeLessThanOrEqual(virgin.length);
  });

  test("caps at two cards per symbol", () => {
    const long: DetectBar[] = [];
    for (let i = 0; i < 16; i++) {
      long.push(bar(i, { open: 100, high: 101, low: 99, close: 100 }));
    }
    for (let wave = 0; wave < 4; wave++) {
      const i = 16 + wave * 3;
      long.push(bar(i, { open: 100, high: 101, low: 99, close: 100 }));
      long.push(bar(i + 1, { open: 100, high: 101, low: 80, close: 82 }));
      long.push(bar(i + 2, { open: 82, high: 86, low: 80, close: 84 }));
    }
    const cards = detectZoneCards(long, {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
      maxZones: ZONE_DETECT.maxZonesPerSymbol,
    });
    expect(cards.length).toBeLessThanOrEqual(2);
  });
});
