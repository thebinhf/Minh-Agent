import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parsePaperArgs } from "../../src/paper/cli";
import { PaperReject } from "../../src/paper/errors";
import { metricsKeys, paperMetrics } from "../../src/paper/metrics";
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
});
