import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decisionLogFile,
  decisionLogEnabled,
  emitDecision,
  formatDecision,
  parseDecisionLine,
} from "../../src/agent/decision-log";

const saved = process.env.MINH_DECISION_LOG;
const savedFile = process.env.MINH_DECISION_FILE;
afterEach(() => {
  if (saved === undefined) delete process.env.MINH_DECISION_LOG;
  else process.env.MINH_DECISION_LOG = saved;
  if (savedFile === undefined) delete process.env.MINH_DECISION_FILE;
  else process.env.MINH_DECISION_FILE = savedFile;
});

describe("MAP decision log", () => {
  test("off by default; record carries card + bias + tape + family + reason", () => {
    delete process.env.MINH_DECISION_LOG;
    expect(decisionLogEnabled()).toBe(false);
    const record = formatDecision({
      card: {
        zoneId: "btc-4h-d-20260908-01",
        symbol: "BTCUSDT",
        tf: "240",
        side: "demand",
        setup: "sd",
        baseStartTs: 1,
        baseEndTs: 2,
        zoneLow: 60000,
        zoneHigh: 61000,
        distal: 60000,
        proximal: 61000,
        impulseBody: 1500,
        atr14: 1000,
        impulseAtr: 1.5,
        departureAtr: 0.5,
        freshness: "virgin",
        penetrationPct: 0,
        entry: 60700,
        sl: 59750,
        tp: 65700,
        rr: 2,
        hardInvalid: 59750,
        softInvalid: 60000,
        expiryBars: 48,
        cancelCodes: [],
      },
      bias: { symbol: "BTCUSDT", "240": "bull", "60": "bull", htf: "bull", klineLagOk: true, nearestSwing: null },
      last: 61200,
      tape: { crowded: null, oiReading: null, cascade: null, flowReading: null },
      family: null,
      decision: { allow: true, reason: "ok" },
      asof: 123,
    });
    expect(record.v).toBe(1);
    expect(record.zoneId).toBe("btc-4h-d-20260908-01");
    expect(record.biasHtf).toBe("bull");
    expect(record.allow).toBe(true);
    expect(record.reason).toBe("ok");
  });

  test("MINH_DECISION_FILE appends a parseable line; 0 and blank are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-decision-"));
    const path = join(dir, "decisions.jsonl");
    process.env.MINH_DECISION_FILE = path;
    expect(decisionLogFile()).toBe(path);
    process.env.MINH_DECISION_FILE = "0";
    expect(decisionLogFile()).toBeNull();
    process.env.MINH_DECISION_FILE = "  ";
    expect(decisionLogFile()).toBeNull();
    process.env.MINH_DECISION_FILE = path;

    emitDecision(formatDecision({
      card: {
        zoneId: "btc-4h-s-20260908-01",
        symbol: "BTCUSDT",
        tf: "240",
        side: "supply",
        setup: "sd",
        baseStartTs: 1,
        baseEndTs: 2,
        zoneLow: 61000,
        zoneHigh: 62000,
        distal: 62000,
        proximal: 61000,
        impulseBody: 1500,
        atr14: 1000,
        impulseAtr: 1.5,
        departureAtr: 0.5,
        freshness: "virgin",
        penetrationPct: 0,
        entry: 61300,
        sl: 62300,
        tp: 59000,
        rr: 2,
        hardInvalid: 62300,
        softInvalid: 62000,
        expiryBars: 48,
        cancelCodes: [],
      } as never,
      bias: null,
      last: 60000,
      tape: null,
      family: null,
      decision: { allow: false, reason: "bias_chop" },
      asof: 1_789_000_000_000,
    }));
    const text = await Bun.file(path).text();
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    const back = parseDecisionLine(text);
    expect(back?.zoneId).toBe("btc-4h-s-20260908-01");
    expect(back?.allow).toBe(false);
    expect(back?.reason).toBe("bias_chop");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the parser takes both sink shapes and refuses junk", () => {
    const json = JSON.stringify({ v: 1, asof: 5, zoneId: "z", symbol: "S" });
    expect(parseDecisionLine(json)?.zoneId).toBe("z");
    expect(parseDecisionLine(`[minh:decision] ${json}`)?.asof).toBe(5);
    expect(parseDecisionLine("")).toBeNull();
    expect(parseDecisionLine("not json")).toBeNull();
    expect(parseDecisionLine('{"v":2,"asof":5,"zoneId":"z"}')).toBeNull();
    expect(parseDecisionLine('{"asof":5,"zoneId":"z"}')).toBeNull();
    expect(parseDecisionLine("[]")).toBeNull();
  });
});
