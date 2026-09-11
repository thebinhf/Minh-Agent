import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import {
  feeOn,
  fitLeverage,
  fundingAmount,
  leverageBand,
  liqPrice,
  marginOn,
  minLeverageForMargin,
  parseTakeProfits,
  requireLeverage,
} from "../../src/paper/phase2";
import { requireInstrument, snapPrice } from "../../src/paper/venue";
import { createPaperEngine } from "../../src/paper/engine";
import { OPEN_LONG, mockFeed, paperEngine, tempStore } from "./helpers";

function btcLiq(side: "long" | "short", entry: string, leverage: string, mm = "0.005"): string {
  return snapPrice(liqPrice(side, Dec.from(entry), Dec.from(leverage), Dec.from(mm)), requireInstrument("BTCUSDT")).toText();
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function harness(feed = mockFeed()) {
  const ctx = await paperEngine(feed);
  dirs.push(ctx.dir);
  return ctx;
}

function reject(error: unknown): PaperReject {
  expect(error).toBeInstanceOf(PaperReject);
  return error as PaperReject;
}

const ACCOUNT = {
  id: 1,
  name: "minh-paper",
  quote: "USDT",
  cash: "10000",
  equity: "10000",
  starting_cash: "10000",
  risk_pct_min: "0.01",
  risk_pct_max: "0.10",
  default_risk_pct: "0.02",
  min_rr: null,
  fee_rate: "0.00055",
  maker_fee_rate: "0.0002",
  leverage_min: "1",
  leverage_max: "25",
  default_leverage: "1",
  mm_rate: "0.005",
  margin_mode: "isolated" as const,
  created_ts: 0,
  updated_ts: 0,
};

describe("phase2 helpers", () => {
  test("fee, liq, funding, and leverage band come from account values", () => {
    const btc = requireInstrument("BTCUSDT");
    expect(feeOn(Dec.from("0.1"), Dec.from("63000"), Dec.from("0.00055")).toText()).toBe("3.465");
    expect(liqPrice("long", Dec.from("63000"), Dec.from("10"), Dec.from("0.005")).toText()).toBe(
      Dec.from("63000").mul(Dec.from("0.9")).div(Dec.from("0.995")).toText(),
    );
    expect(liqPrice("short", Dec.from("63000"), Dec.from("10"), Dec.from("0.005")).toText()).toBe(
      Dec.from("63000").mul(Dec.from("1.1")).div(Dec.from("1.005")).toText(),
    );
    expect(fundingAmount("long", Dec.from("0.1"), Dec.from("63000"), Dec.from("0.0001")).toText()).toBe("-0.63");
    expect(fundingAmount("short", Dec.from("0.1"), Dec.from("63000"), Dec.from("0.0001")).toText()).toBe("0.63");
    expect(requireLeverage(ACCOUNT, "10", btc).toText()).toBe("10");
    try {
      requireLeverage(ACCOUNT, "50", btc);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("leverage_out_of_band");
    }
  });

  test("instrument spec binds the leverage cap; account max is an extra ceiling", () => {
    const btc = requireInstrument("BTCUSDT");
    const ena = requireInstrument("ENAUSDT");
    const wide = { ...ACCOUNT, leverage_max: "150" };
    expect(leverageBand(wide, btc).max.toText()).toBe("150");
    expect(leverageBand(wide, ena).max.toText()).toBe("50");
    expect(requireLeverage(wide, "50", btc).toText()).toBe("50");
    try {
      requireLeverage(wide, "100", ena);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("leverage_out_of_band");
    }
    expect(requireLeverage(wide, "50", ena).toText()).toBe("50");
  });

  test("fitLeverage keeps the request when IM fits and raises to the min that fits remaining cash", () => {
    const btc = requireInstrument("BTCUSDT");
    const qty = Dec.from("0.1");
    const entry = Dec.from("63000");
    const requested = Dec.from("1");
    const keep = fitLeverage({
      requested,
      qty,
      entry,
      side: "long",
      feeRate: Dec.zero(),
      available: Dec.from("10000"),
      spec: btc,
      max: Dec.from("25"),
    });
    expect(keep.toText()).toBe("1");
    const raised = fitLeverage({
      requested,
      qty,
      entry,
      side: "long",
      feeRate: Dec.zero(),
      available: Dec.from("3700"),
      spec: btc,
      max: Dec.from("25"),
    });
    expect(raised.toText()).toBe("1.71");
    expect(marginOn(qty, entry, raised).lte(Dec.from("3700"))).toBe(true);
    const needed = minLeverageForMargin({
      qty,
      entry,
      side: "long",
      feeRate: Dec.zero(),
      available: Dec.from("3700"),
    });
    expect(needed).not.toBeNull();
    expect(needed!.ceilToStep(Dec.from("0.01")).toText()).toBe("1.71");
  });

  test("multi-TP percents must sum to 1 and sort nearest first", () => {
    const plans = parseTakeProfits("long", Dec.from("63000"), undefined, [
      { price: "66000", qtyPct: "0.5" },
      { price: "64500", qtyPct: "0.5" },
    ]);
    expect(plans.map((plan) => plan.price)).toEqual(["64500", "66000"]);
    try {
      parseTakeProfits("long", Dec.from("63000"), undefined, [
        { price: "66000", qtyPct: "0.4" },
      ]);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("tp_qty_pct_sum");
    }
  });
});

describe("phase2 engine", () => {
  test("charges feeRate on open and close without inventing a source constant", async () => {
    const { engine, store } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    store.setPhase2({
      feeRate: "0.00055",
      leverageMin: "1",
      leverageMax: "25",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    const opened = await engine.open(OPEN_LONG);
    expect(opened.position.openFee).toBe("3.465");
    expect(engine.account().cash).toBe("9996.535");
    const closed = await engine.close(opened.position.id);
    expect(closed.account.cash).toBe("9993.07");
  });

  test("10x sets margin and liq; leverage outside the account band is rejected", async () => {
    const { engine } = await harness();
    try {
      await engine.open({ ...OPEN_LONG, leverage: "50" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("leverage_out_of_band");
    }
    const opened = await engine.open({ ...OPEN_LONG, leverage: "10" });
    expect(opened.position.leverage).toBe("10");
    expect(opened.position.qty).toBe("0.1");
    expect(opened.position.margin).toBe("630");
    expect(opened.position.liqPrice).toBe(btcLiq("long", "63000", "10"));
    expect(engine.account().cash).toBe("10000");
    expect(engine.account().marginUsed).toBe("630");
    expect(engine.account().availableCash).toBe("9370");
  });

  test("BTC 50x is allowed when account max is 150; ENA 100x is not (spec 50)", async () => {
    const { engine, store } = await harness();
    store.setPhase2({
      feeRate: "0",
      leverageMin: "1",
      leverageMax: "150",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    const btc = await engine.open({ ...OPEN_LONG, leverage: "50" });
    expect(btc.position.leverage).toBe("50");
    await engine.close(btc.position.id);

    const enaCtx = await tempStore();
    dirs.push(enaCtx.dir);
    enaCtx.store.setPhase2({
      feeRate: "0",
      leverageMin: "1",
      leverageMax: "150",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    const enaEngine = createPaperEngine({
      store: enaCtx.store,
      feed: mockFeed({ lastPrice: "1", markPrice: "1" }),
      config: enaCtx.config,
      universe: { symbols: ["ENAUSDT"], intervals: ["15", "60", "240"] },
    });
    try {
      await enaEngine.open({
        symbol: "ENAUSDT",
        side: "long",
        stopLoss: "0.5",
        takeProfit: "2",
        timeframes: ["240", "60", "15"],
        riskPct: "0.03",
        leverage: "100",
      });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("leverage_out_of_band");
    }
    const ena = await enaEngine.open({
      symbol: "ENAUSDT",
      side: "long",
      stopLoss: "0.5",
      takeProfit: "2",
      timeframes: ["240", "60", "15"],
      riskPct: "0.03",
      leverage: "50",
    });
    expect(ena.position.leverage).toBe("50");
  });

  test("raises leverage to the minimum that fits remaining cash", async () => {
    const { engine } = await harness();
    await engine.open(OPEN_LONG);
    const second = await engine.open({ ...OPEN_LONG, symbol: "ETHUSDT" });
    expect(Dec.from(second.position.leverage).gt(Dec.from("1"))).toBe(true);
    expect(second.position.leverage).toBe("1.71");
    expect(engine.account().openPositions).toBe(2);
  });

  test("rejects a second open when remaining cash cannot cover IM at the band max", async () => {
    const { engine, store } = await harness();
    store.setPhase2({
      feeRate: "0",
      leverageMin: "1",
      leverageMax: "1",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    await engine.open(OPEN_LONG);
    try {
      await engine.open({ ...OPEN_LONG, symbol: "ETHUSDT" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("insufficient_margin");
    }
  });

  test("liq closes when last crosses liq and SL is wider; 1x never liquidates", async () => {
    const oneX = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    const lev1 = await oneX.engine.open({
      ...OPEN_LONG,
      stopLoss: "55000",
      takeProfit: "80000",
    });
    oneX.feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "56000",
      markPrice: "56000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked1 = await oneX.engine.mark();
    expect(marked1.closed).toEqual([]);
    expect(oneX.engine.positions("open")[0]?.id).toBe(lev1.position.id);

    const tenX = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    const lev10 = await tenX.engine.open({
      ...OPEN_LONG,
      stopLoss: "55000",
      takeProfit: "80000",
      leverage: "10",
    });
    expect(lev10.position.liqPrice).toBe(btcLiq("long", "63000", "10"));
    tenX.feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "56000",
      markPrice: "56000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked10 = await tenX.engine.mark();
    expect(marked10.closed).toHaveLength(1);
    expect(marked10.closed[0]?.closeReason).toBe("liq");
    expect(marked10.closed[0]?.closePrice).toBe(btcLiq("long", "63000", "10"));
    expect(tenX.engine.positions("open")).toEqual([]);
  });

  test("multi-TP scales out then closes the remainder", async () => {
    const { engine, feed } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    const opened = await engine.open({
      ...OPEN_LONG,
      takeProfit: undefined,
      takeProfits: [
        { price: "64500", qtyPct: "0.5" },
        { price: "66000", qtyPct: "0.5" },
      ],
    });
    expect(opened.position.takeProfits.map((plan) => plan.price)).toEqual(["64500", "66000"]);
    expect(opened.position.qty).toBe("0.1");

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "64500",
      markPrice: "64500",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const first = await engine.mark();
    expect(first.closed).toHaveLength(1);
    expect(first.closed[0]?.partial).toBe(true);
    expect(first.closed[0]?.status).toBe("open");
    expect(first.closed[0]?.qty).toBe("0.05");
    expect(first.closed[0]?.remainingQty).toBe("0.05");
    expect(first.closed[0]?.realizedPnl).toBe("75");
    expect(engine.positions("open")[0]?.qty).toBe("0.05");
    expect(engine.account().cash).toBe("10075");

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "66000",
      markPrice: "66000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const second = await engine.mark();
    expect(second.closed[0]?.partial).toBe(false);
    expect(second.closed[0]?.status).toBe("closed");
    expect(second.closed[0]?.qty).toBe("0.05");
    expect(second.closed[0]?.realizedPnl).toBe("150");
    expect(engine.positions("open")).toEqual([]);
    expect(engine.account().cash).toBe("10225");
  });

  test("funding credits cash once per settlement on a long", async () => {
    const nextFundingTime = Date.now() - 1_000;
    const { engine, feed } = await harness(mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      fundingRate: "0.0001",
      nextFundingTime,
    }));
    const opened = await engine.open(OPEN_LONG);
    const first = await engine.mark();
    expect(first.funding).toHaveLength(1);
    expect(first.funding[0]?.positionId).toBe(opened.position.id);
    expect(first.funding[0]?.amount).toBe("-0.63");
    expect(engine.account().cash).toBe("9999.37");

    const second = await engine.mark();
    expect(second.funding).toEqual([]);
    expect(engine.account().cash).toBe("9999.37");

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "63000",
      markPrice: "63000",
      recvTs: Date.now(),
      fundingRate: "0.0001",
      nextFundingTime: nextFundingTime + 1,
    });
    const later = await engine.mark();
    expect(later.funding).toHaveLength(1);
    expect(later.funding[0]?.amount).toBe("-0.63");
    expect(engine.account().cash).toBe("9998.74");
  });
});
