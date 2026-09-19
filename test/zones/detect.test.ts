import { describe, expect, test } from "bun:test";
import { parseZoneCard } from "../../src/zones/card";
import {
  ZONE_DETECT,
  atrSma,
  buildGeometryCard,
  deadMinRrWarning,
  detectZoneCards,
  intervalMsForTf,
  parseZoneInterval,
  zoneMinRr,
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

describe("zoneMinRr", () => {
  const saved = process.env.ZONE_MIN_RR;

  function withFloor(raw: string | undefined, run: () => void) {
    if (raw === undefined) delete process.env.ZONE_MIN_RR;
    else process.env.ZONE_MIN_RR = raw;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.ZONE_MIN_RR;
      else process.env.ZONE_MIN_RR = saved;
    }
  }

  test("unset is the drawn floor, garbage falls back rather than becoming 0", () => {
    withFloor(undefined, () => expect(zoneMinRr()).toBe(ZONE_DETECT.minRr));
    withFloor("", () => expect(zoneMinRr()).toBe(ZONE_DETECT.minRr));
    withFloor("abc", () => expect(zoneMinRr()).toBe(ZONE_DETECT.minRr));
    withFloor("0", () => expect(zoneMinRr()).toBe(ZONE_DETECT.minRr));
    withFloor("-1", () => expect(zoneMinRr()).toBe(ZONE_DETECT.minRr));
    withFloor("1.5", () => expect(zoneMinRr()).toBe(1.5));
  });

  test("the target a card is drawn to follows the floor, entry and stop do not", () => {
    const geometry = {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
      side: "supply" as const,
      setup: "sd" as const,
      zoneLow: 100,
      zoneHigh: 102,
      baseStartTs: 16 * INTERVAL_MS,
      baseEndTs: 18 * INTERVAL_MS,
      atr: 1.2,
      later: [],
      impulseBody: 0.2,
      departureAtr: 0.4,
      seq: 1,
    };
    const rows: string[] = [];
    for (const raw of [undefined, "1.5", "3"]) {
      withFloor(raw, () => {
        const card = buildGeometryCard(geometry);
        expect(card?.rr).toBe(zoneMinRr());
        rows.push(card ? `${card.rr}|${card.entry}|${card.sl}|${card.tp}` : "null");
      });
    }
    // This is the whole dead-config mechanism: the card sits exactly on the floor,
    // so an account min_rr between 1.5 and 2 can never reject anything.
    expect(rows).toEqual(["2|100.6|102.3|97.2", "1.5|100.6|102.3|98.05", "3|100.6|102.3|95.5"]);
  });

  test("a min_rr below the drawn floor is named as dead config", () => {
    withFloor(undefined, () => {
      expect(deadMinRrWarning("1.5")).toContain("account.min_rr=1.5 can never bind");
      expect(deadMinRrWarning("2")).toBeNull();
      expect(deadMinRrWarning("3")).toBeNull();
      expect(deadMinRrWarning(null)).toBeNull();
      expect(deadMinRrWarning("")).toBeNull();
      expect(deadMinRrWarning("abc")).toBeNull();
    });
    withFloor("1.5", () => {
      expect(deadMinRrWarning("1.5")).toBeNull();
      expect(deadMinRrWarning("1.2")).toContain("below 1.5R");
    });
  });
});
