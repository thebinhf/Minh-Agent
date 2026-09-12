import { describe, expect, test } from "bun:test";
import { rsiWilder, swingPoints, type TaBar } from "../../src/ta/bars";
import { TA_METHOD_IDS, TA_METHODS } from "../../src/ta/catalog";
import { packMethods } from "../../src/ta/pack";
import { fvg, moonPhases } from "../../src/ta/discretionary";
import { fibonacci, bos, marketStructure } from "../../src/ta/structure";

const STEP = 4 * 60 * 60 * 1000;
const START = 1_700_000_000_000;
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0);

function bar(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number | null = 100,
): TaBar {
  return { startTs: START + i * STEP, open, high, low, close, volume, confirm: true };
}

/** Rising HH/HL. Swing lows at 1,5,9…; highs at 3,7,11… */
function uptrend(n = 60): TaBar[] {
  const out: TaBar[] = [];
  for (let i = 0; i < n; i++) {
    const cycle = Math.floor(i / 4);
    const phase = i % 4;
    const base = 100 + cycle * 8;
    if (phase === 0) out.push(bar(i, base + 2, base + 3, base + 1, base + 2));
    else if (phase === 1) out.push(bar(i, base + 2, base + 3, base, base + 1));
    else if (phase === 2) out.push(bar(i, base + 1, base + 10, base + 1, base + 9));
    else out.push(bar(i, base + 9, base + 12, base + 8, base + 10, 250));
  }
  return out;
}

const OPTS = { symbol: "BTCUSDT", tf: "240", intervalMs: STEP, asof: START + 80 * STEP };

describe("TA catalog", () => {
  test("22 methods, none are signals", () => {
    expect(TA_METHOD_IDS).toHaveLength(22);
    expect(TA_METHODS).toHaveLength(22);
    const packed = packMethods(uptrend(), OPTS);
    for (const id of TA_METHOD_IDS) {
      expect(packed[id].signal).toBe(false);
      expect(packed[id].id).toBe(id);
    }
    expect(packed.fvg.role).toBe("ict_confirm");
    expect(packed.bos.role).toBe("ict_confirm");
    expect(packed.choch.role).toBe("ict_confirm");
    expect(packed.supply_demand.data).toMatchObject({ suggestOnly: true, autoArm: false });
  });

  test("MAP policy does not import the overlay pack", async () => {
    const files = [
      "src/agent/policy.ts",
      "src/agent/quant.ts",
      "src/paper/map-accept.ts",
      "src/paper/proximity.ts",
      "src/live/plan.ts",
    ];
    for (const file of files) {
      const src = await Bun.file(file).text();
      expect(src).not.toContain("src/ta");
      expect(src).not.toMatch(/from ["']\.\.\/ta/);
    }
  });
});

describe("empty tape", () => {
  test("does not invent numbers; moon is calendar-only", () => {
    const packed = packMethods([], OPTS);
    expect(packed.fibonacci.quality).toBe("missing");
    expect(packed.fibonacci.data).toBeNull();
    expect(packed.volume.quality).toBe("missing");
    expect(packed.market_structure.quality).toBe("missing");
    expect(packed.moon_phases.quality).toBe("ok");
    expect(packed.fvg.quality).toBe("missing");
  });

  test("null volume stays missing, not 0", () => {
    const bars = uptrend(25).map((row) => ({ ...row, volume: null }));
    const packed = packMethods(bars, OPTS);
    expect(packed.volume.quality).toBe("missing");
    expect(packed.volume.data).toBeNull();
  });
});

describe("structure", () => {
  test("uptrend is bull; fib maps the last impulse", () => {
    const bars = uptrend();
    const { highs, lows } = swingPoints(bars);
    expect(highs.length).toBeGreaterThanOrEqual(2);
    expect(lows.length).toBeGreaterThanOrEqual(2);
    expect(marketStructure(bars).reading).toBe("bull");
    const fib = fibonacci(bars);
    expect(fib.quality).toBe("ok");
    expect((fib.data as { levels: unknown[] }).levels).toHaveLength(7);
    expect(bos(bars).quality).toBe("ok");
  });

  test("3-bar FVG is labeled, not a signal", () => {
    const bars = [
      bar(0, 10, 10, 9, 9.5),
      bar(1, 9.5, 11, 9.4, 10.5),
      bar(2, 12.5, 13, 12.2, 12.8),
    ];
    const row = fvg(bars);
    expect(row.quality).toBe("ok");
    expect(row.reading).toBe("bull_open");
    expect(row.data).toMatchObject({ ictAsSignal: false, open: 1 });
  });
});

describe("moon + math", () => {
  test("known new moon; full ~half a synodic later", () => {
    const neu = moonPhases(NEW_MOON);
    expect(neu.reading).toBe("new");
    expect(neu.data).toMatchObject({ notPrice: true });
    const full = moonPhases(NEW_MOON + Math.round(29.530588853 * 0.5 * 86_400_000));
    expect(full.reading).toBe("full");
  });

  test("RSI is 100 on a pure up-close tape, not a fake 0", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsiWilder(closes, 14)).toBe(100);
  });
});
