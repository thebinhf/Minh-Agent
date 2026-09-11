import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePaperArgs } from "../../src/paper/cli";
import { PaperReject } from "../../src/paper/errors";
import { paperReviewFromFile, paperReviewFromReplayMap } from "../../src/paper/review";
import { tempDir } from "./helpers";

describe("paper review", () => {
  test("CLI parses review FILE.json", () => {
    expect(parsePaperArgs(["review", "out.json"])).toEqual({ name: "review", path: "out.json" });
    expect(() => parsePaperArgs(["review"])).toThrow();
  });

  test("one-book JSON: flags missing flow/cascade; HYPE accepted is a flag", () => {
    const body = paperReviewFromReplayMap({
      replayMap: true,
      oneBook: true,
      days: 180,
      symbols: ["BTCUSDT", "HYPEUSDT"],
      skipped: [],
      slippage: "0",
      quant: "asof",
      quantCoverage: {
        samples: 10,
        oi: { ok: 8, missing: 2 },
        funding: { ok: 10, missing: 0 },
        flow: { ok: 0, missing: 10 },
        cascade: { ok: 0, missing: 10 },
      },
      accepted: ["btc-4h-s-20260908-01", "hype-4h-s-20260908-01"],
      armed: ["btc-4h-s-20260908-01"],
      filled: 1,
      invalidated: 0,
      skipReasons: { map_skip: 3, family_floor: 2, ok: 0, bias_chop: 9 },
      metrics: {
        realizedPnl: "10",
        winRate: "0.5",
        trades: 2,
        wins: 1,
        losses: 1,
        cancelCodes: { rr_fail: 4, never_touched: 0 },
        byFamily: [{ family: "BTCUSDT:240:supply", score: "0.8", trades: 2, winRate: "0.5", avgRealizedRr: "1" }],
        funnel: { accepted: 2, armed: 1, filled: 1 },
      },
      account: { equity: "10010", startingCash: "10000" },
    });
    expect(body.review).toBe(true);
    expect(body.oneBook).toBe(true);
    expect(body.accepted).toBe(2);
    expect(body.hypeAccepted).toBe(1);
    expect(body.skipReasons.map_skip).toBe(3);
    expect(body.skipReasons.ok).toBeUndefined();
    expect(body.cancelCodes).toEqual({ rr_fail: 4 });
    expect(body.flags).toEqual(["hype_accepted", "flow_missing", "cascade_missing"]);
    expect(body.quantCoverage?.funding.ok).toBe(10);
  });

  test("watchlist rows fold skipReasons and coverage; missing file rejects", async () => {
    const folded = paperReviewFromReplayMap({
      replayMap: true,
      watchlist: true,
      days: 30,
      symbols: ["BTCUSDT", "ETHUSDT"],
      skipped: [{ symbol: "SOLUSDT", error: "replay_no_bars" }],
      rows: [
        {
          replayMap: true,
          symbol: "BTCUSDT",
          quant: "asof",
          accepted: ["btc-4h-s-20260908-01"],
          armed: [],
          filled: 0,
          skipReasons: { map_skip: 2, bias_chop: 1 },
          quantCoverage: {
            samples: 4,
            oi: { ok: 4, missing: 0 },
            funding: { ok: 4, missing: 0 },
            flow: { ok: 0, missing: 4 },
            cascade: { ok: 0, missing: 4 },
          },
        },
        {
          replayMap: true,
          symbol: "ETHUSDT",
          quant: "missing",
          accepted: ["eth-4h-d-20260908-01"],
          armed: ["eth-4h-d-20260908-01"],
          filled: 1,
          skipReasons: { map_skip: 1, family_floor: 5 },
          quantCoverage: {
            samples: 2,
            oi: { ok: 0, missing: 2 },
            funding: { ok: 0, missing: 2 },
            flow: { ok: 0, missing: 2 },
            cascade: { ok: 0, missing: 2 },
          },
        },
      ],
    });
    expect(folded.oneBook).toBe(false);
    expect(folded.accepted).toBe(2);
    expect(folded.armed).toBe(1);
    expect(folded.filled).toBe(1);
    expect(folded.skipReasons.map_skip).toBe(3);
    expect(folded.skipReasons.family_floor).toBe(5);
    expect(folded.quant).toBe("asof");
    expect(folded.quantCoverage?.samples).toBe(6);
    expect(folded.flags).toContain("tape_skipped");
    expect(folded.flags).toContain("flow_missing");

    const dir = tempDir();
    const path = join(dir, "replay.json");
    writeFileSync(path, JSON.stringify({ replayMap: true, oneBook: true, accepted: [], armed: [], skipped: [] }));
    const fromFile = await paperReviewFromFile(path);
    expect(fromFile.source).toBe(path);
    expect(fromFile.flags).toContain("coverage_absent");

    await expect(paperReviewFromFile(join(dir, "nope.json"))).rejects.toBeInstanceOf(PaperReject);
    expect(() => paperReviewFromReplayMap({ replayMap: false })).toThrow(PaperReject);
  });

  test("source is paper-only", async () => {
    const src = await Bun.file("src/paper/review.ts").text();
    expect(src).not.toContain("paperArm");
    expect(src).not.toContain("/v5/order");
    expect(src).not.toContain("OAuth");
    const lab = await Bun.file("deploy/replay-map-lab.sh").text();
    expect(lab).toContain("paper review");
    expect(lab).toContain("BYBIT_API_KEY");
    expect(lab).not.toContain("/v5/order");
  });
});
