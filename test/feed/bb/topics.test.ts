import { afterEach, describe, expect, test } from "bun:test";
import { buildTopics, klineTopic, liquidationTopic, orderbookTopic, parseTopic, publicTradeTopic, tickerTopic } from "../../../src/feed/bb/topics";
import type { TrackerConfig } from "../../../src/feed/bb/types";
import { loadConfig } from "../../../src/feed/bb/config";

const config = {
  symbols: ["BTCUSDT", "ETHUSDT", "ENAUSDT"],
  klineIntervals: ["5", "15", "60", "240"],
  orderbook: { depth: 50, symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ENAUSDT"] },
} as TrackerConfig;

const savedFlow = process.env.BYBIT_FLOW;

afterEach(() => {
  if (savedFlow === undefined) delete process.env.BYBIT_FLOW;
  else process.env.BYBIT_FLOW = savedFlow;
});

describe("Bybit V5 public linear topic names", () => {
  test("matches official topic templates", () => {
    expect(tickerTopic("BTCUSDT")).toBe("tickers.BTCUSDT");
    expect(klineTopic("15", "ETHUSDT")).toBe("kline.15.ETHUSDT");
    expect(orderbookTopic(50, "SOLUSDT")).toBe("orderbook.50.SOLUSDT");
    expect(liquidationTopic("BTCUSDT")).toBe("allLiquidation.BTCUSDT");
    expect(publicTradeTopic("BTCUSDT")).toBe("publicTrade.BTCUSDT");
  });

  test("subscribes L50 for orderbook symbols; liq/flow stay BTC/ETH/SOL on the watchlist", () => {
    delete process.env.BYBIT_FLOW;
    const topics = buildTopics(config);
    expect(topics).toContain("tickers.BTCUSDT");
    expect(topics).toContain("tickers.ENAUSDT");
    expect(topics).toContain("kline.5.BTCUSDT");
    expect(topics).toContain("kline.240.ENAUSDT");
    expect(topics).toContain("orderbook.50.BTCUSDT");
    expect(topics).toContain("orderbook.50.SOLUSDT");
    expect(topics).toContain("orderbook.50.ENAUSDT");
    expect(topics).toContain("allLiquidation.BTCUSDT");
    expect(topics).toContain("allLiquidation.ETHUSDT");
    expect(topics).not.toContain("allLiquidation.SOLUSDT");
    expect(topics).not.toContain("allLiquidation.ENAUSDT");
    expect(topics).toContain("publicTrade.BTCUSDT");
    expect(topics).not.toContain("publicTrade.ENAUSDT");
    expect(topics.filter((topic) => topic.startsWith("tickers.")).length).toBe(3);
    expect(topics.filter((topic) => topic.startsWith("kline.")).length).toBe(12);
    expect(topics.filter((topic) => topic.startsWith("orderbook.")).length).toBe(4);
    expect(topics.filter((topic) => topic.startsWith("allLiquidation.")).length).toBe(2);
    expect(topics.filter((topic) => topic.startsWith("publicTrade.")).length).toBe(2);
  });

  test("default config L50 matches the 10-symbol watchlist; tape stays 3", async () => {
    delete process.env.BYBIT_FLOW;
    const loaded = await loadConfig();
    expect(loaded.orderbook.symbols).toEqual(loaded.symbols);
    const topics = buildTopics(loaded);
    expect(topics.filter((topic) => topic.startsWith("orderbook.")).length).toBe(10);
    expect(topics).toContain("orderbook.50.HYPEUSDT");
    expect(topics).toContain("orderbook.50.ENAUSDT");
    expect(topics.filter((topic) => topic.startsWith("allLiquidation.")).length).toBe(3);
    expect(topics.filter((topic) => topic.startsWith("publicTrade.")).length).toBe(3);
    expect(topics).not.toContain("allLiquidation.HYPEUSDT");
    expect(topics).not.toContain("publicTrade.ENAUSDT");
  });

  test("parseTopic round-trips", () => {
    expect(parseTopic("tickers.XRPUSDT")).toEqual({ kind: "ticker", symbol: "XRPUSDT" });
    expect(parseTopic("kline.60.DOGEUSDT")).toEqual({
      kind: "kline",
      interval: "60",
      symbol: "DOGEUSDT",
    });
    expect(parseTopic("orderbook.50.ETHUSDT")).toEqual({
      kind: "orderbook",
      depth: 50,
      symbol: "ETHUSDT",
    });
    expect(parseTopic("allLiquidation.BTCUSDT")).toEqual({
      kind: "liquidation",
      symbol: "BTCUSDT",
    });
    expect(parseTopic("publicTrade.ETHUSDT")).toEqual({
      kind: "publicTrade",
      symbol: "ETHUSDT",
    });
  });

  test("BYBIT_FLOW=0 skips publicTrade subscribe", () => {
    process.env.BYBIT_FLOW = "0";
    const topics = buildTopics(config);
    expect(topics.some((topic) => topic.startsWith("publicTrade."))).toBe(false);
    expect(topics).toContain("allLiquidation.BTCUSDT");
  });
});
