import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Dec } from "../../src/paper/decimal";
import { estimateCrossLiq, maintenanceMargin, marginOn } from "../../src/paper/phase2";
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

describe("cross margin", () => {
  test("IM uses mark; MM is qty*mark*mmRate; isolated liq does not fire", async () => {
    expect(marginOn(Dec.from("0.1"), Dec.from("69300"), Dec.from("10")).toText()).toBe("693");
    expect(maintenanceMargin(Dec.from("0.1"), Dec.from("69300"), Dec.from("0.005")).toText()).toBe("34.65");
    const longLiq = estimateCrossLiq({
      side: "long",
      qty: Dec.from("0.1"),
      entry: Dec.from("63000"),
      leverage: Dec.from("10"),
      mmRate: Dec.from("0.005"),
      feeRate: Dec.zero(),
      cash: Dec.from("10000"),
      othersUnrealized: Dec.zero(),
      othersMm: Dec.zero(),
    });
    expect(longLiq.isPos()).toBe(false);

    const { engine, store, feed } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    store.setMarginMode("cross");
    const opened = await engine.open({ ...OPEN_LONG, leverage: "10", takeProfit: "80000" });
    expect(engine.account().marginMode).toBe("cross");
    expect(opened.position.margin).toBe("630");
    expect(opened.position.liqPrice).toBe("0");

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "69300",
      markPrice: "69300",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.closed).toEqual([]);
    expect(engine.positions("open")[0]?.margin).toBe("693");
    expect(engine.account().totalMm).toBe("34.65");
    expect(engine.account().marginBalance).toBe("10630");
  });

  test("isolated still closes at isolated liq; same print stays open on cross", async () => {
    const iso = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    const isoOpen = await iso.engine.open({
      ...OPEN_LONG,
      stopLoss: "55000",
      takeProfit: "80000",
      leverage: "10",
    });
    iso.feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "56000",
      markPrice: "56000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const isoMark = await iso.engine.mark();
    expect(isoMark.closed[0]?.closeReason).toBe("liq");
    expect(isoMark.closed[0]?.id).toBe(isoOpen.position.id);

    const x = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    x.store.setMarginMode("cross");
    await x.engine.open({
      ...OPEN_LONG,
      stopLoss: "55000",
      takeProfit: "80000",
      leverage: "10",
    });
    x.feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "56000",
      markPrice: "56000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const xMark = await x.engine.mark();
    expect(xMark.closed).toEqual([]);
    expect(x.engine.positions("open")).toHaveLength(1);
    expect(x.engine.account().marginBalance).not.toBe("0");
  });

  test("cross liquidates when margin balance is at or below total MM", async () => {
    const { engine, store, feed } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    store.setMarginMode("cross");
    const opened = await engine.open({
      symbol: "ETHUSDT",
      side: "short",
      stopLoss: "66000",
      takeProfit: "60000",
      timeframes: ["60", "15"],
      riskPct: "0.03",
      leverage: "10",
    });
    expect(opened.position.qty).toBe("0.1");
    store.updateAccount("40", "40");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "64000",
      markPrice: "64000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.closed).toHaveLength(1);
    expect(marked.closed[0]?.closeReason).toBe("liq");
    expect(marked.closed[0]?.closePrice).toBe("64000");
    expect(engine.positions("open")).toEqual([]);
  });
});
