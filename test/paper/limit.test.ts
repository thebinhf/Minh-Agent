import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PaperReject } from "../../src/paper/errors";
import { mockFeed, OPEN_LONG, paperEngine } from "./helpers";

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

const LIMIT_LONG = {
  ...OPEN_LONG,
  limitPrice: "62000",
};

describe("paper limit orders", () => {
  test("rests a post-only long below last and fills at the limit when last prints through", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    const placed = await engine.limit(LIMIT_LONG);
    expect(placed.mode).toBe("paper");
    expect(placed.order.status).toBe("pending");
    expect(placed.order.limitPrice).toBe("62000");
    expect(placed.order.qty).toBe("0.15");
    expect(placed.order.oco).toBe(true);
    expect(placed.order.invalidatePrice).toBe("60000");
    expect(engine.positions("open")).toHaveLength(0);
    expect(engine.account().cash).toBe("10000");
    expect(engine.account().pendingOrders).toBe(1);

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "61900",
      markPrice: "61900",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.filled).toHaveLength(1);
    expect(marked.filled[0]?.status).toBe("filled");
    expect(marked.events.some((event) => event.kind === "order.filled")).toBe(true);
    const opens = engine.positions("open");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.fillSource).toBe("limit");
    expect(opens[0]?.entryPrice).toBe("62000");
    expect(opens[0]?.qty).toBe("0.15");
  });

  test("post-only rejects a long limit at or above last", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000" }));
    try {
      await engine.limit({ ...LIMIT_LONG, limitPrice: "63000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("limit_crossed");
    }
    try {
      await engine.limit({ ...LIMIT_LONG, limitPrice: "64000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("limit_crossed");
    }
  });

  test("postOnly false fills immediately when last is already through", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    const placed = await engine.limit({ ...LIMIT_LONG, limitPrice: "64000", postOnly: false });
    expect(placed.order.status).toBe("filled");
    expect(placed.position?.fillSource).toBe("limit");
    expect(placed.position?.entryPrice).toBe("64000");
    expect(engine.positions("open")).toHaveLength(1);
  });

  test("duplicate_symbol covers pending + open on the same symbol", async () => {
    const { engine } = await harness();
    await engine.limit(LIMIT_LONG);
    try {
      await engine.limit(LIMIT_LONG);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("duplicate_symbol");
    }
    try {
      await engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("duplicate_symbol");
    }
  });

  test("validates SL/TP against the limit price, not last", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000" }));
    try {
      await engine.limit({ ...LIMIT_LONG, limitPrice: "62000", stopLoss: "62500" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("sl_side");
    }
  });

  test("cancel drops a pending order without opening a position", async () => {
    const { engine } = await harness();
    const placed = await engine.limit(LIMIT_LONG);
    const cancelled = engine.cancelOrder(placed.order.id);
    expect(cancelled.order.status).toBe("cancelled");
    expect(cancelled.event.kind).toBe("order.cancelled");
    expect(engine.orders("pending")).toHaveLength(0);
    expect(engine.positions("open")).toHaveLength(0);
  });

  test("charges maker fee on limit fill, not taker", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine, store } = await harness(feed);
    store.setPhase2({
      feeRate: "0.00055",
      makerFeeRate: "0.0002",
      leverageMin: "1",
      leverageMax: "25",
      defaultLeverage: "1",
      mmRate: "0.005",
    });
    await engine.limit(LIMIT_LONG);
    expect(engine.account().cash).toBe("10000");
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
    expect(open?.fillSource).toBe("limit");
    expect(open?.openFee).toBe("1.86");
    expect(engine.account().cash).toBe("9998.14");
  });

  test("OCO cancels a pending long when last prints through SL before the limit", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    const placed = await engine.limit(LIMIT_LONG);
    expect(placed.order.status).toBe("pending");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.invalidated[0]?.id).toBe(placed.order.id);
    expect(marked.invalidated[0]?.status).toBe("invalidated");
    expect(marked.filled).toHaveLength(0);
    expect(marked.events.some((event) => event.kind === "order.invalidated")).toBe(true);
    expect(engine.positions("open")).toHaveLength(0);
    expect(engine.orders("pending")).toHaveLength(0);
    expect(engine.account().cash).toBe("10000");
  });

  test("OCO wins a gap that would also fill the limit", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    await engine.limit(LIMIT_LONG);
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.filled).toHaveLength(0);
    expect(marked.closed).toHaveLength(0);
  });

  test("--no-oco still fills when last has gapped through SL", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    await engine.limit({ ...LIMIT_LONG, oco: false });
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.invalidated).toHaveLength(0);
    expect(marked.filled).toHaveLength(1);
    expect(marked.closed).toHaveLength(1);
    expect(marked.closed[0]?.closeReason).toBe("sl");
    expect(engine.positions("open")).toHaveLength(0);
  });

  test("already_invalidated rejects --cross when last is through SL", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "59000", markPrice: "59000" }));
    try {
      await engine.limit({ ...LIMIT_LONG, limitPrice: "62000", postOnly: false });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("already_invalidated");
    }
    expect(engine.orders("pending")).toHaveLength(0);
  });

  test("custom --invalidate can be tighter than SL", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    const placed = await engine.limit({ ...LIMIT_LONG, invalidatePrice: "61500" });
    expect(placed.order.invalidatePrice).toBe("61500");
    expect(placed.order.stopLoss).toBe("60000");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "61400",
      markPrice: "61400",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.filled).toHaveLength(0);
  });

  test("invalidate on the wrong side of the limit is rejected", async () => {
    const { engine } = await harness();
    try {
      await engine.limit({ ...LIMIT_LONG, invalidatePrice: "64000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("invalidate_side");
    }
  });
});
