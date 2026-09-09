import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parsePaperArgs } from "../../src/paper/cli";
import { paperArm, paperDay, paperDesk, paperStatus, utcDayWindow } from "../../src/paper/ops";
import { mockFeed, OPEN_LONG, paperEngine } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("paper operator surface", () => {
  test("utcDayWindow is a UTC midnight pair", () => {
    const window = utcDayWindow("2026-09-08");
    expect(window.day).toBe("2026-09-08");
    expect(window.toTs - window.fromTs).toBe(86_400_000);
    expect(new Date(window.fromTs).toISOString()).toBe("2026-09-08T00:00:00.000Z");
  });

  test("arm places a long limit and a below alert at the zone", async () => {
    const ctx = await paperEngine(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    dirs.push(ctx.dir);
    const armed = await paperArm(ctx.engine, { ...OPEN_LONG, limitPrice: "62000" });
    expect(armed.arm).toBe(true);
    expect(armed.order.status).toBe("pending");
    expect(armed.alert?.op).toBe("below");
    expect(armed.alert?.price).toBe("62000");
    expect(armed.alert?.status).toBe("armed");

    const status = paperStatus(ctx.engine);
    expect(status.pending).toHaveLength(1);
    expect(status.open).toHaveLength(0);
    expect(status.alerts).toHaveLength(1);

    const desk = paperDesk(ctx.engine, "sqlite:/tmp/paper.sqlite");
    expect(desk.source).toBe("sqlite:/tmp/paper.sqlite");
    expect(desk.pendingOrders).toHaveLength(1);
    expect(desk.armedAlerts).toHaveLength(1);
    expect(desk.positions).toEqual([]);
  });

  test("day counts fills and OCO in the UTC window", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    await paperArm(ctx.engine, { ...OPEN_LONG, limitPrice: "62000" });
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "59000",
      markPrice: "59000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    await ctx.engine.mark();
    const day = paperDay(ctx.engine);
    expect(day.invalidated).toBe(1);
    expect(day.filled).toBe(0);
    expect(day.closed).toBe(0);
    expect(day.realizedPnl).toBe("0");
  });

  test("CLI parses status / day / arm", () => {
    expect(parsePaperArgs(["status"])).toEqual({ name: "status" });
    expect(parsePaperArgs(["day", "--day", "2026-09-08"])).toEqual({ name: "day", day: "2026-09-08" });
    expect(parsePaperArgs([
      "arm", "BTCUSDT", "--side", "long", "--price", "62000", "--sl", "60000",
      "--tp", "66000", "--tf", "240,60,15", "--alert-price", "62100",
    ])).toMatchObject({ name: "arm", limitPrice: "62000", alertPrice: "62100", oco: true });
  });
});
