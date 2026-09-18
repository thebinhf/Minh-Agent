import { describe, expect, test } from "bun:test";
import { buildFeedMetrics } from "../../../src/feed/bb/metrics";

describe("GET /metrics", () => {
  test("emits Prometheus gauges without touching JSON contracts", () => {
    const text = buildFeedMetrics({
      ok: true,
      connected: true,
      endpoint: "wss://stream.bybit.com/v5/public/linear",
      subscribedTopics: [],
      lastMessageAgeMs: 500,
      lastPongAgeMs: 1000,
      reconnectCount: 0,
      lastError: null,
      tickers: [{ symbol: "BTCUSDT", lastPrice: "63000", ageMs: 300 }],
      klineLag: { ok: false, staleMs: 180000, intervals: ["15", "60", "240"], rows: [] },
    });
    expect(text).toContain("minh_feed_ok 1");
    expect(text).toContain("minh_kline_lag_ok 0");
    expect(text).toContain('minh_feed_ticker_age_ms{symbol="BTCUSDT"} 300');
  });
});
