import { afterEach, describe, expect, test } from "bun:test";
import { decisionLogEnabled, formatDecision } from "../../src/agent/decision-log";

const saved = process.env.MINH_DECISION_LOG;
afterEach(() => {
  if (saved === undefined) delete process.env.MINH_DECISION_LOG;
  else process.env.MINH_DECISION_LOG = saved;
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
});
