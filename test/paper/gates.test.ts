import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PaperReject } from "../../src/paper/errors";
import { GATE_FEED_UNHEALTHY, GATE_KLINE_LAG, cancelCodeForReject, tradingGates } from "../../src/paper/gates";
import { mockFeed, OPEN_LONG, paperEngine } from "./helpers";

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

describe("tradingGates helper", () => {
  test("allows when both inputs are healthy or missing", () => {
    expect(tradingGates({})).toEqual({ tradingAllowed: true, reasons: [] });
    expect(tradingGates({ feedOk: true, klineLagOk: true })).toEqual({
      tradingAllowed: true,
      reasons: [],
    });
  });

  test("stable reason order for WS down and kline lag", () => {
    expect(tradingGates({ feedOk: false, klineLagOk: false })).toEqual({
      tradingAllowed: false,
      reasons: [GATE_FEED_UNHEALTHY, GATE_KLINE_LAG],
    });
    expect(tradingGates({ klineLagOk: false })).toEqual({
      tradingAllowed: false,
      reasons: [GATE_KLINE_LAG],
    });
  });

  test("cancelCodeForReject maps gate and min-RR errors", () => {
    expect(cancelCodeForReject(GATE_KLINE_LAG)).toBe("gates_block");
    expect(cancelCodeForReject(GATE_FEED_UNHEALTHY)).toBe("gates_block");
    expect(cancelCodeForReject("rr_below_min")).toBe("rr_fail");
    expect(cancelCodeForReject("stale_ticker")).toBeNull();
  });
});

describe("paper entry kill-switch", () => {
  test("rejects open and limit when klineLag.ok is false", async () => {
    const ctx = await paperEngine(mockFeed({ klineLagOk: false }));
    dirs.push(ctx.dir);
    try {
      await ctx.engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      const body = reject(error);
      expect(body.error).toBe("kline_lag");
      expect(body.gate).toBe("gates");
      expect(body.extra.tradingAllowed).toBe(false);
      expect(body.extra.reasons).toEqual(["kline_lag"]);
    }
    try {
      await ctx.engine.limit({ ...OPEN_LONG, limitPrice: "62000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("kline_lag");
    }
    expect(ctx.engine.positions("open")).toEqual([]);
    expect(ctx.engine.orders("pending")).toEqual([]);
  });

  test("rejects open when WS feed is unhealthy with reasons", async () => {
    const ctx = await paperEngine(mockFeed({ ok: false }));
    dirs.push(ctx.dir);
    try {
      await ctx.engine.open(OPEN_LONG);
      throw new Error("expected reject");
    } catch (error) {
      const body = reject(error);
      expect(body.error).toBe("feed_unhealthy");
      expect(body.gate).toBe("gates");
      expect(body.extra.reasons).toEqual(["feed_unhealthy"]);
    }
  });

  test("does not auto-close an existing position when kline lag trips", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    const opened = await ctx.engine.open(OPEN_LONG);
    expect(opened.position.status).toBe("open");
    expect(opened.position.zoneId).toBeNull();

    feed.health = async () => ({
      ok: true,
      url: "http://127.0.0.1:43180/health",
      klineLagOk: false,
    });
    const marked = await ctx.engine.mark();
    expect(marked.closed).toEqual([]);
    expect(ctx.engine.positions("open")).toHaveLength(1);
    expect(ctx.engine.positions("open")[0]?.id).toBe(opened.position.id);

    try {
      await ctx.engine.limit({ ...OPEN_LONG, symbol: "ETHUSDT", limitPrice: "62000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("kline_lag");
    }

    const closed = await ctx.engine.close(opened.position.id);
    expect(closed.position.closeReason).toBe("manual");
    expect(ctx.engine.positions("open")).toEqual([]);
  });
});
