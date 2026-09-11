import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import {
  assertMarketQty,
  defaultCatalog,
  floorQty,
  requireInstrument,
  snapLeverage,
  snapPrice,
} from "../../src/paper/venue";
import { createPaperEngine } from "../../src/paper/engine";
import { OPEN_LONG, mockFeed, paperEngine, tempStore } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function reject(error: unknown): PaperReject {
  expect(error).toBeInstanceOf(PaperReject);
  return error as PaperReject;
}

describe("Bybit linear venue filters", () => {
  test("loads public instruments-info snapshot for the feed universe", () => {
    const btc = requireInstrument("BTCUSDT");
    expect(btc.tickSize).toBe("0.10");
    expect(btc.qtyStep).toBe("0.001");
    expect(btc.minOrderQty).toBe("0.001");
    expect(btc.minNotionalValue).toBe("5");
    expect(defaultCatalog().ETHUSDT?.qtyStep).toBe("0.01");
    expect(defaultCatalog().SOLUSDT?.qtyStep).toBe("0.1");
    expect(defaultCatalog().HYPEUSDT?.maxLeverage).toBe("75.00");
    expect(defaultCatalog().HYPEUSDT?.qtyStep).toBe("0.01");
    expect(defaultCatalog().HYPEUSDT?.tickSize).toBe("0.010");
    try {
      requireInstrument("NOTAUSDT");
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("unknown_instrument");
    }
  });

  test("snaps price to tick and floors qty to lot", () => {
    const btc = requireInstrument("BTCUSDT");
    expect(snapPrice(Dec.from("60000.04"), btc).toText()).toBe("60000");
    expect(floorQty(Dec.from("0.1007"), btc).toText()).toBe("0.1");
    expect(snapLeverage(Dec.from("10.009"), btc).toText()).toBe("10");
    assertMarketQty(btc, Dec.from("0.1"), Dec.from("63000"));
    try {
      assertMarketQty(btc, Dec.from("0.0004"), Dec.from("63000"));
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("min_order_qty");
    }
  });

  test("engine snaps off-tick SL and floors risk qty to BTC lot", async () => {
    const ctx = await paperEngine(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    dirs.push(ctx.dir);
    const opened = await ctx.engine.open({
      ...OPEN_LONG,
      stopLoss: "59999.96",
    });
    expect(opened.position.stopLoss).toBe("60000");
    expect(opened.position.qty).toBe("0.1");
    expect(opened.position.entryPrice).toBe("63000");

    const coarse = await paperEngine(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    dirs.push(coarse.dir);
    const floored = await coarse.engine.open({
      ...OPEN_LONG,
      stopLoss: "59900",
    });
    expect(floored.position.qty).toBe("0.096");
    expect(floored.position.stopLoss).toBe("59900");
  });

  test("HYPEUSDT is a known linear spec and can paper-open", async () => {
    const ctx = await tempStore();
    dirs.push(ctx.dir);
    const engine = createPaperEngine({
      store: ctx.store,
      feed: mockFeed({ lastPrice: "40", markPrice: "40" }),
      config: ctx.config,
      universe: { symbols: ["HYPEUSDT"], intervals: ["15", "60", "240"] },
    });
    const opened = await engine.open({
      symbol: "HYPEUSDT",
      side: "long",
      stopLoss: "30",
      takeProfit: "60",
      timeframes: ["240", "60", "15"],
      riskPct: "0.03",
    });
    expect(opened.position.symbol).toBe("HYPEUSDT");
    expect(opened.position.entryPrice).toBe("40");
    expect(Dec.from(opened.position.qty).isPos()).toBe(true);
  });
});
