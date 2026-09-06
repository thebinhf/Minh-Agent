import { describe, expect, test } from "bun:test";
import {
  chunkTopics,
  computeGapStart,
  intervalToMs,
  isPongStale,
  parseTimeArg,
  restCandleConfirm,
  withRetries,
} from "../../../src/feed/bb/recovery";

describe("isPongStale", () => {
  test("stays quiet during the grace window even with no pong", () => {
    expect(
      isPongStale({
        now: 20_000,
        connectTs: 1,
        lastPongTs: 0,
        graceMs: 30_000,
        staleMs: 60_000,
      }),
    ).toBe(false);
  });

  test("trips after grace if no pong arrived", () => {
    expect(
      isPongStale({
        now: 40_000,
        connectTs: 1,
        lastPongTs: 0,
        graceMs: 30_000,
        staleMs: 60_000,
      }),
    ).toBe(true);
  });

  test("trips when the last pong is older than staleMs", () => {
    expect(
      isPongStale({
        now: 100_000,
        connectTs: 1,
        lastPongTs: 30_000,
        graceMs: 30_000,
        staleMs: 60_000,
      }),
    ).toBe(true);
  });

  test("does not trip when pongs are fresh", () => {
    expect(
      isPongStale({
        now: 100_000,
        connectTs: 1,
        lastPongTs: 90_000,
        graceMs: 30_000,
        staleMs: 60_000,
      }),
    ).toBe(false);
  });
});

describe("chunkTopics / retry", () => {
  test("chunks subscribe args into batches of 10", () => {
    const topics = Array.from({ length: 48 }, (_, i) => `t.${i}`);
    const chunks = chunkTopics(topics, 10);
    expect(chunks).toHaveLength(5);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[4]).toHaveLength(8);
  });

  test("withRetries returns after a later success", async () => {
    let calls = 0;
    const value = await withRetries(async () => {
      calls += 1;
      if (calls < 3) throw new Error("fail");
      return "ok";
    }, { retries: 3, delayMs: 1 });
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  test("withRetries exhausts and throws the last error", async () => {
    await expect(
      withRetries(async () => {
        throw new Error("still down");
      }, { retries: 2, delayMs: 1 }),
    ).rejects.toThrow("still down");
  });
});

describe("kline gap math", () => {
  test("intervalToMs maps Bybit minute ids", () => {
    expect(intervalToMs("5")).toBe(300_000);
    expect(intervalToMs("240")).toBe(14_400_000);
  });

  test("computeGapStart uses lookback when the series is empty", () => {
    expect(computeGapStart(null, 1_000_000, 100_000)).toBe(900_000);
  });

  test("computeGapStart does not walk past the lookback floor", () => {
    expect(computeGapStart(10, 1_000_000, 100_000)).toBe(900_000);
    expect(computeGapStart(950_000, 1_000_000, 100_000)).toBe(950_000);
  });

  test("REST candle is confirmed only after the interval closes", () => {
    expect(restCandleConfirm(0, 60_000, 59_999)).toBe(false);
    expect(restCandleConfirm(0, 60_000, 60_000)).toBe(true);
  });

  test("parseTimeArg accepts epoch ms and ISO dates", () => {
    expect(parseTimeArg("1700000000000")).toBe(1_700_000_000_000);
    expect(parseTimeArg("2025-01-01T00:00:00.000Z")).toBe(Date.parse("2025-01-01T00:00:00.000Z"));
  });
});
