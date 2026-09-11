import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePaperArgs } from "../../src/paper/cli";
import { PaperReject } from "../../src/paper/errors";
import {
  paperAbFromFiles,
  paperAbFromReviews,
  paperReviewFromFile,
  paperReviewFromReplayMap,
} from "../../src/paper/review";
import { tempDir } from "./helpers";

function oneBook(partial: Record<string, unknown>) {
  return {
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
    accepted: ["btc-4h-s-20260908-01"],
    armed: ["btc-4h-s-20260908-01"],
    filled: 1,
    invalidated: 0,
    skipReasons: { bias_chop: 9, family_floor: 2 },
    metrics: {
      realizedPnl: "10",
      winRate: "0.5",
      trades: 2,
      wins: 1,
      losses: 1,
      cancelCodes: { rr_fail: 4 },
      byFamily: [{ family: "BTCUSDT:240:supply", score: "0.8", trades: 2, winRate: "0.5", avgRealizedRr: "1" }],
      funnel: { accepted: 1, armed: 1, filled: 1 },
    },
    account: { equity: "10010", startingCash: "10000" },
    ...partial,
  };
}

describe("paper review", () => {
  test("CLI parses review FILE.json and ab BASE VARIANT", () => {
    expect(parsePaperArgs(["review", "out.json"])).toEqual({ name: "review", path: "out.json" });
    expect(() => parsePaperArgs(["review"])).toThrow();
    expect(parsePaperArgs(["ab", "base.json", "var.json"])).toEqual({
      name: "ab",
      base: "base.json",
      variant: "var.json",
    });
    expect(() => parsePaperArgs(["ab", "only.json"])).toThrow();
  });

  test("one-book JSON: flags missing flow/cascade; HYPE accepted is a flag", () => {
    const body = paperReviewFromReplayMap(oneBook({
      accepted: ["btc-4h-s-20260908-01", "hype-4h-s-20260908-01"],
      skipReasons: { map_skip: 3, family_floor: 2, ok: 0, bias_chop: 9 },
    }));
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

  test("compact review JSON reloads; ab is variant minus base", async () => {
    const base = paperReviewFromReplayMap(oneBook({}));
    const variant = paperReviewFromReplayMap(oneBook({
      accepted: ["btc-4h-s-20260908-01", "hype-4h-s-20260908-01", "eth-4h-s-20260908-01"],
      armed: ["btc-4h-s-20260908-01", "eth-4h-s-20260908-01"],
      filled: 2,
      skipReasons: { bias_chop: 0, family_floor: 2, map_skip: 0 },
      metrics: {
        realizedPnl: "40",
        winRate: "0.5",
        trades: 4,
        wins: 2,
        losses: 2,
        cancelCodes: { rr_fail: 1 },
        byFamily: [{ family: "BTCUSDT:240:supply", score: "0.8", trades: 2, winRate: "0.5", avgRealizedRr: "1" }],
        funnel: { accepted: 3, armed: 2, filled: 2 },
      },
      account: { equity: "10040", startingCash: "10000" },
    }));
    const same = paperAbFromReviews(base, base);
    expect(same.ab).toBe(true);
    expect(same.delta.accepted).toBe(0);
    expect(same.delta.equity).toBe("0");
    expect(same.delta.skipReasons).toEqual({});
    expect(same.delta.flagsAdded).toEqual([]);
    expect(same.delta.flagsRemoved).toEqual([]);

    const chop = paperAbFromReviews(base, variant);
    expect(chop.delta.accepted).toBe(2);
    expect(chop.delta.hypeAccepted).toBe(1);
    expect(chop.delta.armed).toBe(1);
    expect(chop.delta.filled).toBe(1);
    expect(chop.delta.trades).toBe(2);
    expect(chop.delta.skipReasons.bias_chop).toBe(-9);
    expect(chop.delta.cancelCodes.rr_fail).toBe(-3);
    expect(chop.delta.equity).toBe("30");
    expect(chop.delta.flagsAdded).toEqual(["hype_accepted"]);

    const dir = tempDir();
    const basePath = join(dir, "base.json");
    const varPath = join(dir, "var.json");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(varPath, JSON.stringify(variant));
    const fromCompact = await paperReviewFromFile(basePath);
    expect(fromCompact.accepted).toBe(1);
    expect(fromCompact.hypeAccepted).toBe(0);
    expect(fromCompact.equity).toBe("10010");
    const ab = await paperAbFromFiles(basePath, varPath);
    expect(ab.delta.accepted).toBe(2);
    expect(ab.delta.skipReasons.bias_chop).toBe(-9);
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
    const ab = await Bun.file("deploy/replay-map-ab.sh").text();
    expect(ab).toContain("paper ab");
    expect(ab).toContain("BYBIT_API_KEY");
    expect(ab).not.toContain("/v5/order");
    expect(ab).toContain("AGENT_BIAS_CHOP=0");
  });
});
