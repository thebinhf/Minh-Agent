import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Dec } from "../../src/paper/decimal";
import type { PaperDb } from "../../src/paper/db";
import { beStopFor, favorableR, originalRiskPx, stopImproves } from "../../src/paper/manage";
import { mockFeed, OPEN_LONG, paperEngine } from "./helpers";

const dirs: string[] = [];
const stores: PaperDb[] = [];
const savedBe = process.env.PAPER_BE_R;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the WAL until GC; the temp dir is disposable.
    }
  }
  if (savedBe === undefined) delete process.env.PAPER_BE_R;
  else process.env.PAPER_BE_R = savedBe;
});

describe("EVENT break-even math", () => {
  test("original risk is risk_quote / qty_initial, not the moved stop", () => {
    expect(originalRiskPx("300", "0.1")?.toText()).toBe("3000");
    expect(originalRiskPx("0", "0.1")).toBeNull();
    const long = favorableR("long", Dec.from("63000"), Dec.from("64500"), Dec.from("3000"));
    expect(long.toText()).toBe("0.5");
    const short = favorableR("short", Dec.from("63000"), Dec.from("61500"), Dec.from("3000"));
    expect(short.toText()).toBe("0.5");
    expect(stopImproves("long", Dec.from("60000"), Dec.from("63000"))).toBe(true);
    expect(stopImproves("long", Dec.from("63000"), Dec.from("63000"))).toBe(false);
    expect(stopImproves("short", Dec.from("66000"), Dec.from("63000"))).toBe(true);
  });

  test("beStopFor is off by default and waits for the R floor", () => {
    delete process.env.PAPER_BE_R;
    const row = {
      side: "long",
      entry_price: "63000",
      stop_loss: "60000",
      risk_quote: "300",
      qty_initial: "0.1",
    };
    expect(beStopFor(row, Dec.from("64500"))).toBeNull();
    process.env.PAPER_BE_R = "0.5";
    expect(beStopFor(row, Dec.from("64499"))).toBeNull();
    const hit = beStopFor(row, Dec.from("64500"));
    expect(hit?.action).toBe("be");
    expect(hit?.stop.toText()).toBe("63000");
    expect(beStopFor({ ...row, stop_loss: "63000" }, Dec.from("64500"))).toBeNull();
  });
});

describe("EVENT break-even on the ledger", () => {
  test("PAPER_BE_R moves SL to entry after 0.5R; return to entry is a 0-pnl SL", async () => {
    process.env.PAPER_BE_R = "0.5";
    const feed = mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      tickers: { BTCUSDT: { lastPrice: "63000", markPrice: "63000", recvTs: Date.now() } },
    });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    stores.push(ctx.store);
    const opened = await ctx.engine.open(OPEN_LONG);
    expect(opened.position.stopLoss).toBe("60000");

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "64500",
      markPrice: "64500",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const ran = await ctx.engine.mark();
    expect(ran.closed).toEqual([]);
    expect(ctx.engine.positions("open")[0]?.stopLoss).toBe("63000");
    expect(ran.events.some((event) => event.kind === "position.managed" && event.payload.action === "be")).toBe(true);

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "63000",
      markPrice: "63000",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const stopped = await ctx.engine.mark();
    expect(stopped.closed).toHaveLength(1);
    expect(stopped.closed[0]?.closeReason).toBe("sl");
    expect(stopped.closed[0]?.closePrice).toBe("63000");
    expect(stopped.closed[0]?.realizedPnl).toBe("0");
  });

  test("flag off leaves the original stop", async () => {
    delete process.env.PAPER_BE_R;
    const feed = mockFeed({
      lastPrice: "63000",
      markPrice: "63000",
      tickers: { BTCUSDT: { lastPrice: "63000", markPrice: "63000", recvTs: Date.now() } },
    });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    stores.push(ctx.store);
    await ctx.engine.open(OPEN_LONG);
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "64500",
      markPrice: "64500",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    await ctx.engine.mark();
    expect(ctx.engine.positions("open")[0]?.stopLoss).toBe("60000");
  });

  test("short BE tightens the stop down to entry", async () => {
    process.env.PAPER_BE_R = "0.5";
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    stores.push(ctx.store);
    await ctx.engine.open({
      symbol: "ETHUSDT",
      side: "short",
      stopLoss: "66000",
      takeProfit: "60000",
      timeframes: ["60", "15"],
      riskPct: "0.03",
    });
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "61500",
      markPrice: "61500",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const ran = await ctx.engine.mark();
    expect(ran.closed).toEqual([]);
    expect(ctx.engine.positions("open")[0]?.stopLoss).toBe("63000");
  });
});
