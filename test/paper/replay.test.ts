import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePaperArgs } from "../../src/paper/cli";
import {
  nextFundingTimeUtc,
  replayDbPath,
  replayPrints,
  runReplay,
  type ReplayBar,
} from "../../src/paper/replay";
import { paperConfig, tempDir, UNIVERSE } from "./helpers";

const FROM = 1_700_000_000_000;
const MIN15 = 15 * 60_000;

function bar(i: number, o: string, h: string, l: string, c: string): ReplayBar {
  return { startTs: FROM + i * MIN15, open: o, high: h, low: l, close: c };
}

function series(walk: ReplayBar[]): Record<string, ReplayBar[]> {
  const first = walk[0]!;
  const htf = { startTs: first.startTs, open: first.open, high: first.high, low: first.low, close: first.close };
  return { "15": walk, "60": [htf], "240": [htf] };
}

const LIMIT = {
  symbol: "BTCUSDT",
  side: "long",
  limitPrice: "62000",
  stopLoss: "60000",
  takeProfit: "66000",
  timeframes: ["240", "60", "15"],
  riskPct: "0.02",
  postOnly: true,
  oco: true,
  fromTs: FROM,
  toTs: FROM + 20 * MIN15,
  interval: "15",
};

describe("paper replay", () => {
  test("print order is adverse-first so OCO/SL beat TP on the same bar", () => {
    expect(replayPrints("long", { startTs: 1, open: "10", high: "12", low: "8", close: "11" }))
      .toEqual(["10", "8", "12", "11"]);
    expect(replayPrints("short", { startTs: 1, open: "10", high: "12", low: "8", close: "9" }))
      .toEqual(["10", "12", "8", "9"]);
  });

  test("fills a post-only long at the limit when a bar trades through; maker fee; live db untouched", async () => {
    const dir = tempDir("minh-replay-");
    const liveDb = join(dir, "paper.sqlite");
    const config = await paperConfig(dir, {
      dbPath: liveDb,
      account: {
        ...(await paperConfig(dir)).account,
        minRr: "2",
        feeRate: "0.00055",
        makerFeeRate: "0.0002",
      },
    });
    const result = await runReplay({
      config,
      universe: UNIVERSE,
      dbPath: replayDbPath(liveDb),
      series: series([
        bar(0, "64000", "64100", "63500", "63800"),
        bar(1, "63800", "63900", "61900", "62500"),
      ]),
      request: LIMIT,
    });
    expect(result.replay).toBe(true);
    expect(result.slippage).toBe("0");
    expect(result.order?.status).toBe("filled");
    expect(result.position?.status).toBe("open");
    expect(result.position?.entryPrice).toBe("62000");
    expect(result.events.some((event) => event.kind === "order.filled")).toBe(true);
    expect(existsSync(liveDb)).toBe(false);
    expect(existsSync(replayDbPath(liveDb))).toBe(true);
  });

  test("OCO invalidates when the same bar also trades through the limit", async () => {
    const dir = tempDir("minh-replay-");
    const config = await paperConfig(dir);
    const result = await runReplay({
      config,
      universe: UNIVERSE,
      dbPath: join(dir, "replay.sqlite"),
      series: series([
        bar(0, "64000", "64100", "63500", "63800"),
        bar(1, "63800", "63000", "59000", "61000"),
      ]),
      request: LIMIT,
    });
    expect(result.order?.status).toBe("invalidated");
    expect(result.position).toBeNull();
    expect(result.events.map((event) => event.kind)).toContain("order.invalidated");
    expect(result.events.map((event) => event.kind)).not.toContain("order.filled");
  });

  test("after fill, SL closes at the stop (zero slippage)", async () => {
    const dir = tempDir("minh-replay-");
    const config = await paperConfig(dir);
    const result = await runReplay({
      config,
      universe: UNIVERSE,
      dbPath: join(dir, "replay.sqlite"),
      series: series([
        bar(0, "64000", "64100", "63500", "63800"),
        bar(1, "63800", "63900", "61900", "62500"),
        bar(2, "62500", "62600", "59900", "60500"),
      ]),
      request: LIMIT,
    });
    expect(result.order?.status).toBe("filled");
    expect(result.position?.status).toBe("closed");
    expect(result.position?.closeReason).toBe("sl");
    expect(result.position?.closePrice).toBe("60000");
  });

  test("optional funding settles on the 8h boundary from bar time", async () => {
    const dir = tempDir("minh-replay-");
    const config = await paperConfig(dir);
    const filled = FROM + MIN15;
    const next = nextFundingTimeUtc(filled);
    const after = Math.ceil((next - FROM) / MIN15) + 1;
    const walk: ReplayBar[] = [
      bar(0, "64000", "64100", "63500", "63800"),
      bar(1, "63800", "63900", "61900", "62500"),
    ];
    for (let i = 2; i <= after; i++) {
      walk.push(bar(i, "62500", "62600", "62400", "62500"));
    }
    const result = await runReplay({
      config,
      universe: UNIVERSE,
      dbPath: join(dir, "replay.sqlite"),
      series: series(walk),
      request: { ...LIMIT, fundingRate: "0.01", toTs: FROM + after * MIN15 },
    });
    expect(result.position?.status).toBe("open");
    expect(result.account.cash).not.toBe(config.account.startingCash);
  });

  test("CLI parses replay times and refuses a reversed window via engine", async () => {
    expect(parsePaperArgs([
      "replay", "BTCUSDT", "--from", "2026-08-01", "--to", "2026-08-15",
      "--side", "long", "--price", "62000", "--sl", "60000", "--tp", "66000",
      "--tf", "240,60,15", "--interval", "15",
    ])).toMatchObject({
      name: "replay",
      limitPrice: "62000",
      interval: "15",
      oco: true,
      postOnly: true,
    });
    const dir = tempDir("minh-replay-");
    const config = await paperConfig(dir);
    await expect(runReplay({
      config,
      universe: UNIVERSE,
      dbPath: join(dir, "replay.sqlite"),
      series: series([bar(0, "64000", "64100", "63500", "63800")]),
      request: { ...LIMIT, fromTs: FROM + 1000, toTs: FROM },
    })).rejects.toMatchObject({ error: "replay_window" });
  });
});
