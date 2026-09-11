import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parsePaperArgs } from "../../src/paper/cli";
import { PaperReject } from "../../src/paper/errors";
import { runReplayMap, runReplayMapWatchlist, DAY_MS, REPLAY_MAP_MAX_DAYS, replayMapWindow } from "../../src/paper/replay-map";
import type { AsOfStore } from "../../src/features/tape";
import { intervalMsForTf, type DetectBar } from "../../src/zones/detect";
import { paperConfig, tempDir, UNIVERSE } from "./helpers";
import type { ReplayBar } from "../../src/paper/replay";

const dirs: string[] = [];
const savedAccept = process.env.MAP_ACCEPT;
const savedAgent = process.env.AGENT_MAP;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedAccept === undefined) delete process.env.MAP_ACCEPT;
  else process.env.MAP_ACCEPT = savedAccept;
  if (savedAgent === undefined) delete process.env.AGENT_MAP;
  else process.env.AGENT_MAP = savedAgent;
});

const HTF = intervalMsForTf("240");

function bar(i: number, partial: Pick<DetectBar, "open" | "high" | "low" | "close">): ReplayBar {
  return {
    startTs: i * HTF,
    open: String(partial.open),
    high: String(partial.high),
    low: String(partial.low),
    close: String(partial.close),
  };
}

/** 16 ranging bars then a 2-bar base and a bearish impulse (same as detect.test). */
function supplyHtf(): ReplayBar[] {
  const bars: ReplayBar[] = [];
  for (let i = 0; i < 16; i++) {
    bars.push(bar(i, { open: 100, high: 101, low: 99, close: 100 }));
  }
  bars.push(bar(16, { open: 100, high: 101, low: 99, close: 100.2 }));
  bars.push(bar(17, { open: 100, high: 101, low: 80, close: 82 }));
  bars.push(bar(18, { open: 82, high: 86, low: 80, close: 84 }));
  return bars;
}

function laterDemandImpulse(): ReplayBar[] {
  const bars = supplyHtf();
  bars.push(bar(40, { open: 84, high: 85, low: 83, close: 83.5 }));
  bars.push(bar(41, { open: 84, high: 120, low: 83, close: 118 }));
  return bars;
}

describe("paper replay-map", () => {
  test("CLI parses replay-map times", () => {
    const cmd = parsePaperArgs(["replay-map", "BTCUSDT", "--from", "2026-08-01", "--to", "2026-08-15"]);
    expect(cmd).toEqual({
      name: "replay-map",
      symbols: ["BTCUSDT"],
      fromTs: Date.parse("2026-08-01T00:00:00.000Z"),
      toTs: Date.parse("2026-08-15T00:00:00.000Z"),
    });
  });

  test("CLI parses watchlist --days 180 and does not treat 180 as a symbol", () => {
    const cmd = parsePaperArgs(["replay-map", "--days", "180"]);
    expect(cmd).toEqual({ name: "replay-map", symbols: "watchlist", days: 180 });
    const one = parsePaperArgs(["replay-map", "ETHUSDT", "--days", "30"]);
    expect(one).toEqual({ name: "replay-map", symbols: ["ETHUSDT"], days: 30 });
    expect(REPLAY_MAP_MAX_DAYS).toBe(180);
    expect(() => parsePaperArgs(["replay-map", "--days", "181"])).toThrow();
    expect(() => parsePaperArgs(["replay-map", "--days", "180", "--from", "2026-01-01"])).toThrow();
  });

  test("replayMapWindow --days 180 is now minus 180d", () => {
    const now = 2_000_000_000_000;
    const w = replayMapWindow({ days: 180, now });
    expect(w.days).toBe(180);
    expect(w.toTs).toBe(now);
    expect(w.fromTs).toBe(now - 180 * DAY_MS);
  });

  test("refuses a reversed window", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const config = await paperConfig(dir);
    await expect(runReplayMap({
      config,
      universe: UNIVERSE,
      series: { "240": supplyHtf() },
      request: { symbol: "BTCUSDT", fromTs: 10, toTs: 1 },
      dbPath: join(dir, "replay-map.sqlite"),
    })).rejects.toMatchObject({ error: "replay_window" });
  });

  test("empty 4H series is replay_no_bars", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const config = await paperConfig(dir);
    try {
      await runReplayMap({
        config,
        universe: UNIVERSE,
        series: { "240": [] },
        request: { symbol: "BTCUSDT", fromTs: 1, toTs: 2 },
        dbPath: join(dir, "replay-map.sqlite"),
      });
      throw new Error("expected reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PaperReject);
      expect((error as PaperReject).error).toBe("replay_no_bars");
    }
  });

  test("does not read bars after toTs; live paper db untouched; quant not invented", async () => {
    delete process.env.MAP_ACCEPT;
    process.env.AGENT_MAP = "0";
    const dir = tempDir();
    dirs.push(dir);
    const base = await paperConfig(dir);
    const config = {
      ...base,
      account: {
        ...base.account,
        minRr: null,
        defaultLeverage: "10",
        feeRate: "0",
        makerFeeRate: "0",
      },
    };
    const liveDb = join(dir, "paper.sqlite");
    const replayDb = join(dir, "replay-map.sqlite");
    const htf = laterDemandImpulse();
    const impulseClose = 17 * HTF + HTF;
    const result = await runReplayMap({
      config: { ...config, dbPath: liveDb },
      universe: UNIVERSE,
      series: { "240": htf },
      request: { symbol: "BTCUSDT", fromTs: 0, toTs: impulseClose },
      dbPath: replayDb,
    });
    expect(result.replayMap).toBe(true);
    expect(result.quant).toBe("missing");
    expect(result.slippage).toBe("0");
    expect(result.accepted.every((id) => id.includes("-s-"))).toBe(true);
    expect(result.accepted.some((id) => id.includes("-d-"))).toBe(false);
    expect(existsSync(liveDb)).toBe(false);
    expect(existsSync(replayDb)).toBe(true);
  });

  test("as-of funding tape marks quant asof without inventing future prints", async () => {
    delete process.env.MAP_ACCEPT;
    delete process.env.AGENT_MAP;
    const dir = tempDir();
    dirs.push(dir);
    const config = await paperConfig(dir);
    const impulseClose = 17 * HTF + HTF;
    const features: AsOfStore = {
      listOi: () => [],
      listFunding: ({ endTs }) => {
        const rows = [
          { funding_ts: impulseClose, funding_rate: "0.001" },
          { funding_ts: impulseClose + 1, funding_rate: "0.05" },
        ];
        return rows
          .filter((row) => endTs === undefined || row.funding_ts <= endTs)
          .map((row) => ({
            symbol: "BTCUSDT",
            funding_ts: row.funding_ts,
            funding_rate: row.funding_rate,
            recv_ts: row.funding_ts,
          }));
      },
      sumFlowWindow: () => ({ buyNotional: "0", sellNotional: "0" }),
      listLiquidations: () => [],
    };
    const result = await runReplayMap({
      config,
      universe: UNIVERSE,
      series: { "240": supplyHtf() },
      request: { symbol: "BTCUSDT", fromTs: 0, toTs: impulseClose },
      dbPath: join(dir, "replay-map.sqlite"),
      features,
    });
    expect(result.quant).toBe("asof");
  });

  test("contiguous 4H bars still walk 15m until the next 4H close", async () => {
    delete process.env.MAP_ACCEPT;
    process.env.AGENT_MAP = "0";
    const dir = tempDir();
    dirs.push(dir);
    const config = await paperConfig(dir);
    const htf = supplyHtf();
    const lastClose = htf[htf.length - 1]!.startTs + HTF;
    const m15Ms = 15 * 60 * 1000;
    const m15: ReplayBar[] = [];
    for (let t = 0; t < lastClose; t += m15Ms) {
      m15.push({ startTs: t, open: "100", high: "101", low: "99", close: "100" });
    }
    const result = await runReplayMap({
      config,
      universe: UNIVERSE,
      series: { "240": htf, "60": [], "15": m15 },
      request: { symbol: "BTCUSDT", fromTs: 0, toTs: lastClose },
      dbPath: join(dir, "replay-map.sqlite"),
    });
    expect(result.htfBars).toBe(htf.length);
    expect(result.ltfBars).toBeGreaterThan(0);
    expect(result.ticks).toBeGreaterThan(0);
  });

  test("watchlist walks each symbol; empty tape is skipped; live paper db untouched", async () => {
    delete process.env.MAP_ACCEPT;
    process.env.AGENT_MAP = "0";
    const dir = tempDir();
    dirs.push(dir);
    const config = await paperConfig(dir);
    const impulseClose = 17 * HTF + HTF;
    const body = await runReplayMapWatchlist({
      config,
      universe: { symbols: ["BTCUSDT", "ETHUSDT"], intervals: ["15", "60", "240"] },
      seriesBySymbol: {
        BTCUSDT: { "240": supplyHtf() },
        ETHUSDT: { "240": [] },
      },
      fromTs: 0,
      toTs: impulseClose,
    });
    expect(body.watchlist).toBe(true);
    expect(body.days).toBeGreaterThanOrEqual(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.symbol).toBe("BTCUSDT");
    expect(body.skipped).toEqual([{ symbol: "ETHUSDT", error: "replay_no_bars" }]);
    expect(existsSync(config.dbPath)).toBe(false);
  });
});


