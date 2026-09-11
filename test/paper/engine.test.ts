import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import { OPEN_LONG, mockFeed, paperEngine } from "./helpers";

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

describe("paper engine", () => {
  test("opens a 3% long, ignores client qty, stores derived rr < 2", async () => {
    const { engine } = await harness();
    const opened = await engine.open({ ...OPEN_LONG, qty: "999" } as typeof OPEN_LONG & { qty: string });
    expect(opened.mode).toBe("paper");
    expect(opened.position.qty).toBe("0.1");
    expect(opened.position.riskPct).toBe("0.03");
    expect(opened.position.riskQuote).toBe("300");
    expect(opened.position.rr).toBe("1");
    expect(opened.position.timeframes).toEqual(["240", "60", "15"]);
    expect(opened.position.status).toBe("open");
    expect(opened.position.entryPrice).toBe("63000");
    expect(opened.position.fillSource).toBe("last");
    expect(engine.account().openPositions).toBe(1);
    expect(engine.account().cash).toBe("10000");
  });

  test("allows 1% and 10% risk; 10% at 1x raises leverage to fit IM", async () => {
    const low = await harness();
    const onePct = await low.engine.open({ ...OPEN_LONG, riskPct: "0.01" });
    expect(onePct.position.riskPct).toBe("0.01");
    expect(onePct.position.status).toBe("open");

    const highLev = await harness();
    const tenPct = await highLev.engine.open({ ...OPEN_LONG, riskPct: "0.10", leverage: "10" });
    expect(tenPct.position.riskPct).toBe("0.1");
    expect(tenPct.position.leverage).toBe("10");
    expect(tenPct.position.status).toBe("open");

    const highFlat = await harness();
    const bumped = await highFlat.engine.open({ ...OPEN_LONG, riskPct: "0.10" });
    expect(bumped.position.riskPct).toBe("0.1");
    expect(Dec.from(bumped.position.leverage).gt(Dec.from("1"))).toBe(true);
    expect(bumped.position.status).toBe("open");

    const capped = await harness();
    capped.store.setPhase2({
      feeRate: "0",
      leverageMin: "1",
      leverageMax: "1",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    try {
      await capped.engine.open({ ...OPEN_LONG, riskPct: "0.10" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("insufficient_margin");
    }
  });

  test("rejects duplicate symbol, unknown symbol, missing SL/TP, wrong-side levels", async () => {
    const { engine } = await harness();
    await engine.open(OPEN_LONG);

    try {
      await engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("duplicate_symbol");
    }

    try {
      await engine.open({ ...OPEN_LONG, symbol: "DOGEUSDT" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("unknown_symbol");
    }

    try {
      await engine.open({ ...OPEN_LONG, symbol: "ETHUSDT", stopLoss: "" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("missing_stop_loss");
    }

    try {
      await engine.open({ ...OPEN_LONG, symbol: "ETHUSDT", takeProfit: "" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("missing_take_profit");
    }

    try {
      await engine.open({ ...OPEN_LONG, symbol: "ETHUSDT", stopLoss: "70000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("sl_side");
    }
  });

  test("rejects stale ticker, unhealthy feed, and incomplete MTF", async () => {
    const stale = await harness(mockFeed({ recvTs: Date.now() - 16_000 }));
    try {
      await stale.engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("stale_ticker");
      expect(reject(error).gate).toBe("stale");
    }

    const down = await harness(mockFeed({ ok: false }));
    try {
      await down.engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("feed_unhealthy");
    }

    const incomplete = await harness(mockFeed({ klines: { "240": null } }));
    try {
      await incomplete.engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("mtf_incomplete");
    }

    const oneTf = await harness();
    try {
      await oneTf.engine.open({ ...OPEN_LONG, timeframes: ["15"] });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("mtf_required");
    }
  });

  test("manual close realizes pnl into cash and equity", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    const opened = await engine.open(OPEN_LONG);
    const closed = await engine.close(opened.position.id, Date.now());
    expect(closed.mode).toBe("paper");
    expect(closed.position.status).toBe("closed");
    expect(closed.position.closeReason).toBe("manual");
    expect(closed.position.closePrice).toBe("63000");
    expect(closed.position.realizedPnl).toBe("0");
    expect(closed.account.cash).toBe("10000");
    expect(closed.account.equity).toBe("10000");
    try {
      await engine.close(opened.position.id);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("already_closed");
    }
  });

  test("mark uses markPrice for unrealized and closes SL/TP at the level", async () => {
    const prices = { last: "63000", mark: "63300" };
    const feed = mockFeed({
      lastPrice: prices.last,
      markPrice: prices.mark,
      tickers: {
        BTCUSDT: { lastPrice: "63000", markPrice: "63300", recvTs: Date.now() },
      },
    });
    const { engine } = await harness(feed);
    const opened = await engine.open(OPEN_LONG);
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "63300",
      markPrice: "63300",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.mode).toBe("paper");
    expect(marked.positions[0]?.unrealizedPnl).toBe("30");
    expect(marked.account.unrealizedPnl).toBe("30");
    expect(marked.account.equity).toBe("10030");
    expect(marked.closed).toEqual([]);

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const stopped = await engine.mark();
    expect(stopped.closed).toHaveLength(1);
    expect(stopped.closed[0]?.id).toBe(opened.position.id);
    expect(stopped.closed[0]?.closeReason).toBe("sl");
    expect(stopped.closed[0]?.closePrice).toBe("60000");
    expect(stopped.account.cash).toBe("9700");
    expect(engine.positions("open")).toEqual([]);
  });

  test("short TP fills at the take-profit level", async () => {
    const { engine, feed } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    await engine.open({
      symbol: "ETHUSDT",
      side: "short",
      stopLoss: "66000",
      takeProfit: "60000",
      timeframes: ["60", "15"],
      riskPct: "0.03",
    });
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.closed[0]?.closeReason).toBe("tp");
    expect(marked.closed[0]?.closePrice).toBe("60000");
    expect(marked.account.cash).toBe("10300");
  });

  test("rr_below_min only when account min_rr is set", async () => {
    const { engine, store } = await harness();
    const allowed = await engine.open(OPEN_LONG);
    expect(allowed.position.rr).toBe("1");
    await engine.close(allowed.position.id);

    store.setMinRr("2");
    try {
      await engine.open({ ...OPEN_LONG, symbol: "ETHUSDT" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("rr_below_min");
    }
  });
});
