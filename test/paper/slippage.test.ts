import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import { paperSlippageOn, walkBook } from "../../src/paper/slippage";
import { mockDepth, mockFeed, OPEN_LONG, paperEngine } from "./helpers";

const LIMIT_LONG = {
  ...OPEN_LONG,
  limitPrice: "62000",
};

const dirs: string[] = [];
const savedSlip = process.env.PAPER_SLIPPAGE;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedSlip === undefined) delete process.env.PAPER_SLIPPAGE;
  else process.env.PAPER_SLIPPAGE = savedSlip;
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

const thickAsk = mockDepth({
  bids: [["62980", "10"]],
  asks: [["63020", "10"]],
});

describe("walkBook", () => {
  test("long VWAP across two ask levels", () => {
    const walked = walkBook({
      take: "buy",
      qty: Dec.from("2"),
      levels: [
        { price: "63000", size: "1" },
        { price: "63020", size: "1" },
      ],
    });
    expect(walked?.vwap.toText()).toBe("63010");
    expect(walked?.levels).toBe(2);
    expect(walked?.bookCapped).toBe(false);
  });

  test("short VWAP across two bid levels", () => {
    const walked = walkBook({
      take: "sell",
      qty: Dec.from("2"),
      levels: [
        { price: "63000", size: "1" },
        { price: "62980", size: "1" },
      ],
    });
    expect(walked?.vwap.toText()).toBe("62990");
    expect(walked?.levels).toBe(2);
  });

  test("pads remaining qty at the last consumed level", () => {
    const walked = walkBook({
      take: "buy",
      qty: Dec.from("2"),
      levels: [{ price: "63020", size: "0.5" }],
    });
    expect(walked?.vwap.toText()).toBe("63020");
    expect(walked?.bookCapped).toBe(true);
    expect(walked?.levels).toBe(1);
  });

  test("buy cap stops before asks worse than the limit and pads at the cap", () => {
    const walked = walkBook({
      take: "buy",
      qty: Dec.from("2"),
      levels: [
        { price: "63010", size: "0.5" },
        { price: "64100", size: "10" },
      ],
      cap: Dec.from("64000"),
    });
    expect(walked?.bookCapped).toBe(true);
    expect(walked?.levels).toBe(1);
    expect(walked?.vwap.toText()).toBe("63752.5");
  });

  test("empty book without a cap returns null", () => {
    expect(walkBook({ take: "buy", qty: Dec.from("1"), levels: [] })).toBeNull();
  });
});

describe("paper L50 slippage", () => {
  test("market long fills ask VWAP worse than last", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000", depth: thickAsk }));
    const opened = await engine.open(OPEN_LONG);
    expect(opened.position.entryPrice).toBe("63020");
    expect(opened.position.fillSource).toBe("last");
    expect(opened.position.qty).toBe("0.1");
    expect(opened.position.riskQuote).toBe("302");
    expect(opened.fallback).toBe("none");
    expect(opened.slippage).toBe("20");
    expect(opened.bookCapped).toBe(false);
    expect(opened.levels).toBe(1);
  });

  test("market short fills bid VWAP", async () => {
    const { engine } = await harness(mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["62980", "10"]],
        asks: [["63020", "10"]],
      }),
    }));
    const opened = await engine.open({
      ...OPEN_LONG,
      side: "short",
      stopLoss: "66000",
      takeProfit: "60000",
    });
    expect(opened.position.entryPrice).toBe("62980");
    expect(opened.fallback).toBe("none");
    expect(opened.slippage).toBe("20");
  });

  test("thin L50 keeps full qty and caps at the last level", async () => {
    const { engine } = await harness(mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["62980", "10"]],
        asks: [["63020", "0.01"]],
      }),
    }));
    const opened = await engine.open(OPEN_LONG);
    expect(opened.position.qty).toBe("0.1");
    expect(opened.position.entryPrice).toBe("63020");
    expect(opened.bookCapped).toBe(true);
  });

  test("crossed / empty / stale book falls back to last", async () => {
    const crossed = await (await harness(mockFeed({
      lastPrice: "63000",
      depth: mockDepth({
        bids: [["63100", "10"]],
        asks: [["63000", "10"]],
      }),
    }))).engine.open(OPEN_LONG);
    expect(crossed.position.entryPrice).toBe("63000");
    expect(crossed.fallback).toBe("last");

    const empty = await (await harness(mockFeed({
      lastPrice: "63000",
      depth: mockDepth({ bids: [["62980", "10"]], asks: [] }),
    }))).engine.open(OPEN_LONG);
    expect(empty.position.entryPrice).toBe("63000");
    expect(empty.fallback).toBe("last");

    const stale = await (await harness(mockFeed({
      lastPrice: "63000",
      depth: mockDepth({
        recvTs: Date.now() - 20_000,
        bids: [["62980", "10"]],
        asks: [["63020", "10"]],
      }),
    }))).engine.open(OPEN_LONG);
    expect(stale.position.entryPrice).toBe("63000");
    expect(stale.fallback).toBe("last");
  });

  test("missing depth() keeps the last fill (existing mocks)", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000" }));
    const opened = await engine.open(OPEN_LONG);
    expect(opened.position.entryPrice).toBe("63000");
    expect(opened.fallback).toBe("last");
  });

  test("PAPER_SLIPPAGE=0 stays at last", async () => {
    process.env.PAPER_SLIPPAGE = "0";
    expect(paperSlippageOn()).toBe(false);
    const { engine } = await harness(mockFeed({ lastPrice: "63000", depth: thickAsk }));
    const opened = await engine.open(OPEN_LONG);
    expect(opened.position.entryPrice).toBe("63000");
    expect(opened.fallback).toBe("off");
  });

  test("BTC walks; ETH without a book stays at last", async () => {
    const feed = mockFeed({
      lastPrice: "63000",
      tickers: {
        BTCUSDT: { lastPrice: "63000", markPrice: "63000" },
        ETHUSDT: { lastPrice: "2500", markPrice: "2500" },
      },
      depth: (symbol) => symbol === "BTCUSDT"
        ? thickAsk
        : mockDepth({ symbol: "ETHUSDT", bids: [], asks: [] }),
    });
    feed.ticker = async (symbol) => {
      if (symbol === "ETHUSDT") {
        return {
          symbol,
          lastPrice: "2500",
          markPrice: "2500",
          recvTs: Date.now(),
          fundingRate: null,
          nextFundingTime: null,
        };
      }
      return {
        symbol,
        lastPrice: "63000",
        markPrice: "63000",
        recvTs: Date.now(),
        fundingRate: null,
        nextFundingTime: null,
      };
    };
    const btc = await harness(feed);
    const btcOpen = await btc.engine.open(OPEN_LONG);
    expect(btcOpen.position.entryPrice).toBe("63020");

    const eth = await harness(feed);
    const ethOpen = await eth.engine.open({
      ...OPEN_LONG,
      symbol: "ETHUSDT",
      stopLoss: "2400",
      takeProfit: "2800",
    });
    expect(ethOpen.position.entryPrice).toBe("2500");
    expect(ethOpen.fallback).toBe("last");
  });

  test("post-only tick fill stays at the limit even when the book is through", async () => {
    const feed = mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["61900", "10"]],
        asks: [["61910", "10"]],
      }),
    });
    const { engine } = await harness(feed);
    const placed = await engine.limit(LIMIT_LONG);
    expect(placed.order.status).toBe("pending");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "61900",
      markPrice: "61900",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    await engine.mark();
    expect(engine.positions("open")[0]?.entryPrice).toBe("62000");
    expect(engine.positions("open")[0]?.fillSource).toBe("limit");
  });

  test("--cross immediate walks with a cap at the limit and charges taker", async () => {
    const feed = mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["62980", "10"]],
        asks: [["63010", "10"]],
      }),
    });
    const { engine, store } = await harness(feed);
    store.setPhase2({
      feeRate: "0.00055",
      makerFeeRate: "0.0002",
      leverageMin: "1",
      leverageMax: "25",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    const placed = await engine.limit({ ...LIMIT_LONG, limitPrice: "64000", postOnly: false });
    expect(placed.order.status).toBe("filled");
    expect(placed.position?.fillSource).toBe("limit");
    expect(placed.position?.entryPrice).toBe("63010");
    expect(placed.event?.payload.fallback).toBe("none");
    expect(placed.position?.qty).toBe("0.075");
    expect(placed.position?.openFee).toBe("2.5991625");
  });

  test("--cross that rests then fills on the tick stays maker at the limit", async () => {
    const feed = mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["61900", "10"]],
        asks: [["61910", "10"]],
      }),
    });
    const { engine, store } = await harness(feed);
    store.setPhase2({
      feeRate: "0.00055",
      makerFeeRate: "0.0002",
      leverageMin: "1",
      leverageMax: "25",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    const placed = await engine.limit({ ...LIMIT_LONG, limitPrice: "62000", postOnly: false });
    expect(placed.order.status).toBe("pending");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "61900",
      markPrice: "61900",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    await engine.mark();
    const open = engine.positions("open")[0];
    expect(open?.entryPrice).toBe("62000");
    expect(open?.openFee).toBe("1.86");
  });

  test("VWAP through the stop rejects and does not open", async () => {
    const { engine } = await harness(mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["62700", "10"]],
        asks: [["62800", "10"]],
      }),
    }));
    try {
      await engine.open({ ...OPEN_LONG, stopLoss: "62900", takeProfit: "80000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("sl_side");
    }
    expect(engine.positions("open")).toHaveLength(0);
  });

  test("VWAP that pushes risk above the 10% band rejects", async () => {
    const { engine } = await harness(mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      depth: mockDepth({
        bids: [["62980", "10"]],
        asks: [["71000", "10"]],
      }),
    }));
    try {
      await engine.open({ ...OPEN_LONG, takeProfit: "80000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("risk_quote");
    }
    expect(engine.positions("open")).toHaveLength(0);
  });

  test("manual close sells the bid VWAP", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    const opened = await engine.open(OPEN_LONG);
    feed.depth = async () => mockDepth({
      bids: [["62900", "10"]],
      asks: [["63100", "10"]],
    });
    const closed = await engine.close(opened.position.id);
    expect(closed.position.closePrice).toBe("62900");
    expect(closed.fallback).toBe("none");
    expect(closed.slippage).toBe("100");
  });
});
