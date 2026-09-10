import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parsePaperArgs } from "../../src/paper/cli";
import { PaperReject } from "../../src/paper/errors";
import { metricsKeys, paperMetrics } from "../../src/paper/metrics";
import { paperArm } from "../../src/paper/ops";
import { mockFeed, OPEN_LONG, paperEngine } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("paper metrics", () => {
  test("empty ledger has a stable schema with null rates and zero counts", async () => {
    const ctx = await paperEngine();
    dirs.push(ctx.dir);
    const body = paperMetrics(ctx.engine, 7, 1_000_000);
    expect(Object.keys(body)).toEqual(metricsKeys());
    expect(body.mode).toBe("paper");
    expect(body.days).toBe(7);
    expect(body.toTs - body.fromTs).toBe(7 * 86_400_000);
    expect(body.trades).toBe(0);
    expect(body.wins).toBe(0);
    expect(body.losses).toBe(0);
    expect(body.breakeven).toBe(0);
    expect(body.winRate).toBeNull();
    expect(body.avgRr).toBeNull();
    expect(body.avgRealizedRr).toBeNull();
    expect(body.noFillPct).toBeNull();
    expect(body.filled).toBe(0);
    expect(body.invalidated).toBe(0);
    expect(body.cancelled).toBe(0);
    expect(body.rejected).toBe(0);
    expect(body.closed).toBe(0);
    expect(body.closeReasons).toEqual({ sl: 0, tp: 0, liq: 0, manual: 0 });
    expect(body.realizedPnl).toBe("0");
    expect(body.openPositions).toBe(0);
    expect(body.pendingOrders).toBe(0);
    expect(body.events).toBe(0);
    expect(body.byZone).toEqual([]);
    expect(body.funnel).toEqual({
      detected: 0,
      accepted: 0,
      armed: 0,
      touched: 0,
      filled: 0,
      cancelled: 0,
      exited: 0,
    });
    expect(body.cancelCodes).toEqual({
      never_touched: 0,
      ops_cancel: 0,
      deep_mitigate: 0,
      htf_break: 0,
      expired: 0,
      rr_fail: 0,
      gates_block: 0,
    });
  });

  test("aggregates win rate, avg RR, SL/TP, and optional zoneId", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    const now = Date.now();
    const win = await ctx.engine.open({ ...OPEN_LONG, zoneId: "htf-demand-1" }, now);
    expect(win.position.zoneId).toBe("htf-demand-1");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "67000",
      markPrice: "67000",
      recvTs: now + 1,
      fundingRate: null,
      nextFundingTime: null,
    });
    const stopped = await ctx.engine.mark(now + 1);
    expect(stopped.closed[0]?.closeReason).toBe("tp");

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "63000",
      markPrice: "63000",
      recvTs: now + 2,
      fundingRate: null,
      nextFundingTime: null,
    });
    const loss = await ctx.engine.open({
      ...OPEN_LONG,
      symbol: "ETHUSDT",
      zoneId: "htf-demand-1",
    }, now + 2);
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: now + 3,
      fundingRate: null,
      nextFundingTime: null,
    });
    const sl = await ctx.engine.mark(now + 3);
    expect(sl.closed[0]?.closeReason).toBe("sl");
    expect(loss.position.zoneId).toBe("htf-demand-1");

    const body = paperMetrics(ctx.engine, 7, now + 4);
    expect(Object.keys(body)).toEqual(metricsKeys());
    expect(body.trades).toBe(2);
    expect(body.wins).toBe(1);
    expect(body.losses).toBe(1);
    expect(body.winRate).toBe("0.5");
    expect(body.avgRr).toBe("1");
    expect(body.avgRealizedRr).toBe("0");
    expect(body.filled).toBe(2);
    expect(body.closed).toBe(2);
    expect(body.closeReasons).toEqual({ sl: 1, tp: 1, liq: 0, manual: 0 });
    expect(body.realizedPnl).toBe("0");
    expect(body.byZone).toEqual([
      expect.objectContaining({
        zoneId: "htf-demand-1",
        trades: 2,
        wins: 1,
        losses: 1,
        winRate: "0.5",
        avgRr: "1",
        filled: 2,
      }),
    ]);
  });

  test("noFillPct is pending → invalidated/cancelled without a fill", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    await ctx.engine.limit({ ...OPEN_LONG, limitPrice: "62000" });
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    await ctx.engine.mark();
    const body = paperMetrics(ctx.engine, 7);
    expect(body.filled).toBe(0);
    expect(body.invalidated).toBe(1);
    expect(body.cancelled).toBe(0);
    expect(body.noFillPct).toBe("1");
    expect(body.trades).toBe(0);
    expect(body.winRate).toBeNull();
  });

  test("CLI parses metrics --days and --zone-id", () => {
    expect(parsePaperArgs(["metrics"])).toEqual({ name: "metrics", days: 7 });
    expect(parsePaperArgs(["metrics", "--days", "30"])).toEqual({ name: "metrics", days: 30 });
    expect(parsePaperArgs([
      "open", "BTCUSDT", "--side", "long", "--sl", "60000", "--tp", "66000",
      "--tf", "240,60,15", "--zone-id", "z-1",
    ])).toMatchObject({ name: "open", zoneId: "z-1" });
    expect(() => parsePaperArgs(["metrics", "--days", "0"])).toThrow();
  });

  test("invalid days rejects", async () => {
    const ctx = await paperEngine();
    dirs.push(ctx.dir);
    expect(() => paperMetrics(ctx.engine, 0)).toThrow(PaperReject);
  });

  test("funnel splits noFill into never_touched vs ops_cancel", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    const now = Date.now();
    await ctx.engine.limit({
      ...OPEN_LONG,
      limitPrice: "62000",
      zoneId: "btc-4h-d-20260908-01",
    }, now);
    const cancelled = ctx.engine.cancelOrder(ctx.engine.orders("pending")[0]!.id, now + 1);
    expect(cancelled.event.payload.cancelCode).toBe("ops_cancel");

    await ctx.engine.limit({
      ...OPEN_LONG,
      symbol: "ETHUSDT",
      limitPrice: "62000",
      zoneId: "eth-4h-d-20260908-01",
    }, now + 2);
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: now + 3,
      fundingRate: null,
      nextFundingTime: null,
    });
    await ctx.engine.mark(now + 3);
    const body = paperMetrics(ctx.engine, 7, now + 4);
    expect(Object.keys(body)).toEqual(metricsKeys());
    expect(body.funnel.detected).toBe(2);
    expect(body.funnel.armed).toBe(2);
    expect(body.funnel.cancelled).toBe(2);
    expect(body.funnel.filled).toBe(0);
    expect(body.cancelCodes.ops_cancel).toBe(1);
    expect(body.cancelCodes.never_touched).toBe(1);
    expect(body.noFillPct).toBe("1");
  });

  test("funnel.touched counts alert.fired with zoneId after arm", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    const now = Date.now();
    await paperArm(ctx.engine, {
      ...OPEN_LONG,
      limitPrice: "62000",
      zoneId: "btc-4h-d-20260908-01",
    }, now);
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "62000",
      markPrice: "62000",
      recvTs: now + 1,
      fundingRate: null,
      nextFundingTime: null,
    });
    await ctx.engine.mark(now + 1);
    const body = paperMetrics(ctx.engine, 7, now + 2);
    expect(body.funnel.detected).toBe(1);
    expect(body.funnel.armed).toBe(1);
    expect(body.funnel.touched).toBe(1);
    expect(body.funnel.filled).toBe(1);
  });

  test("arm after a standalone alert still counts funnel.touched", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    const now = Date.now();
    await ctx.engine.setAlert({
      symbol: "BTCUSDT",
      op: "below",
      price: "62000",
    }, now);
    const armed = await paperArm(ctx.engine, {
      ...OPEN_LONG,
      limitPrice: "62000",
      zoneId: "btc-4h-d-20260908-01",
    }, now + 1);
    expect(armed.alertSkipped).toBe("duplicate_alert");
    expect(armed.alert?.zoneId).toBe("btc-4h-d-20260908-01");
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "62000",
      markPrice: "62000",
      recvTs: now + 2,
      fundingRate: null,
      nextFundingTime: null,
    });
    await ctx.engine.mark(now + 2);
    const body = paperMetrics(ctx.engine, 7, now + 3);
    expect(body.funnel.detected).toBe(1);
    expect(body.funnel.armed).toBe(1);
    expect(body.funnel.touched).toBe(1);
    expect(body.funnel.filled).toBe(1);
  });

  test("submit-time kline_lag increments cancelCodes.gates_block", async () => {
    const ctx = await paperEngine(mockFeed({ klineLagOk: false }));
    dirs.push(ctx.dir);
    const now = Date.now();
    try {
      await ctx.engine.open({ ...OPEN_LONG, zoneId: "btc-4h-d-20260908-01" }, now);
      throw new Error("expected reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PaperReject);
      expect((error as PaperReject).error).toBe("kline_lag");
    }
    const body = paperMetrics(ctx.engine, 7, now + 1);
    expect(body.cancelCodes.gates_block).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.funnel.cancelled).toBe(0);
    expect(body.funnel.detected).toBe(1);
    expect(ctx.engine.orders("all")).toEqual([]);
  });

  test("submit-time rr_below_min increments cancelCodes.rr_fail", async () => {
    const ctx = await paperEngine();
    dirs.push(ctx.dir);
    ctx.store.setMinRr("2");
    const now = Date.now();
    try {
      await ctx.engine.open({ ...OPEN_LONG, zoneId: "btc-4h-d-20260908-01" }, now);
      throw new Error("expected reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PaperReject);
      expect((error as PaperReject).error).toBe("rr_below_min");
    }
    const body = paperMetrics(ctx.engine, 7, now + 1);
    expect(body.cancelCodes.rr_fail).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.funnel.cancelled).toBe(0);
    expect(ctx.engine.positions("open")).toEqual([]);
  });
});
