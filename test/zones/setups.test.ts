import { afterEach, describe, expect, test } from "bun:test";
import { parseZoneCard } from "../../src/zones/card";
import { ZONE_DETECT, intervalMsForTf, type DetectBar } from "../../src/zones/detect";
import {
  detectAllSetups,
  detectBreakoutCards,
  detectReversalCards,
  paperSetups,
} from "../../src/zones/setups";

const TF = "240";
const INTERVAL_MS = intervalMsForTf(TF);
const savedSetups = process.env.PAPER_SETUPS;

afterEach(() => {
  if (savedSetups === undefined) delete process.env.PAPER_SETUPS;
  else process.env.PAPER_SETUPS = savedSetups;
});

function bar(i: number, partial: Partial<DetectBar> & Pick<DetectBar, "open" | "high" | "low" | "close">): DetectBar {
  return {
    startTs: i * INTERVAL_MS,
    confirm: true,
    ...partial,
  };
}

function rangePrefix(n = 16): DetectBar[] {
  const bars: DetectBar[] = [];
  for (let i = 0; i < n; i++) {
    bars.push(bar(i, { open: 100, high: 101, low: 99, close: 100 }));
  }
  return bars;
}

function bullBreakSeries(): DetectBar[] {
  const bars = rangePrefix();
  bars.push(bar(16, { open: 100, high: 110, low: 99, close: 108 }));
  bars.push(bar(17, { open: 108, high: 109, low: 106, close: 107 }));
  bars.push(bar(18, { open: 107, high: 114, low: 106, close: 113 }));
  return bars;
}

function hammerDemandSeries(): DetectBar[] {
  const bars = rangePrefix();
  bars.push(bar(16, { open: 92, high: 93, low: 82, close: 84 }));
  bars.push(bar(17, { open: 84, high: 86, low: 83, close: 85 }));
  bars.push(bar(18, { open: 84, high: 86, low: 80, close: 85.5 }));
  return bars;
}

describe("paperSetups", () => {
  test("default is sd + breakout + reversal; 0 rolls back to sd", () => {
    delete process.env.PAPER_SETUPS;
    expect(paperSetups()).toEqual(["sd", "breakout", "reversal"]);
    process.env.PAPER_SETUPS = "0";
    expect(paperSetups()).toEqual(["sd"]);
    process.env.PAPER_SETUPS = "breakout,reversal";
    expect(paperSetups()).toEqual(["breakout", "reversal"]);
  });
});

describe("breakout / reversal setups", () => {
  test("emits a demand retest card after a bull break of swing high", () => {
    const cards = detectBreakoutCards(bullBreakSeries(), {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(cards.length).toBeGreaterThan(0);
    const card = parseZoneCard(cards[0]!);
    expect(card.setup).toBe("breakout");
    expect(card.side).toBe("demand");
    expect(card.zoneId).toMatch(/^btc-4h-d-bo-\d{8}-01$/);
    expect(card.rr).toBeGreaterThanOrEqual(ZONE_DETECT.minRr);
    expect(card.entry).toBeGreaterThanOrEqual(card.zoneLow);
    expect(card.entry).toBeLessThanOrEqual(card.zoneHigh);
  });

  test("emits a demand reversal at a hammer swing low", () => {
    const cards = detectReversalCards(hammerDemandSeries(), {
      symbol: "ETHUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(cards.some((row) => row.setup === "reversal" && row.side === "demand")).toBe(true);
    const card = parseZoneCard(cards.find((row) => row.setup === "reversal")!);
    expect(card.zoneId.startsWith("eth-4h-d-rv-")).toBe(true);
    expect(card.distal).toBe(card.zoneLow);
  });

  test("PAPER_SETUPS=sd keeps detectAllSetups on the old detector", () => {
    process.env.PAPER_SETUPS = "sd";
    const mixed = detectAllSetups(bullBreakSeries(), {
      symbol: "BTCUSDT",
      tf: TF,
      intervalMs: INTERVAL_MS,
    });
    expect(mixed.every((card) => card.setup === "sd")).toBe(true);
  });
});
