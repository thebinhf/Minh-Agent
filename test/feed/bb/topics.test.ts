import { afterEach, describe, expect, test } from "bun:test";
import { buildTopics, klineTopic, liquidationTopic, orderbookTopic, parseTopic, publicTradeTopic, tapeSymbols, tickerTopic } from "../../../src/feed/bb/topics";
import type { TrackerConfig } from "../../../src/feed/bb/types";
import { loadConfig } from "../../../src/feed/bb/config";

const config = {
  symbols: ["BTCUSDT", "ETHUSDT", "ENAUSDT"],
  klineIntervals: ["5", "15", "60", "240"],
  orderbook: { depth: 50, symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ENAUSDT"] },
} as TrackerConfig;

const savedFlow = process.env.BYBIT_FLOW;
const savedTape = process.env.BYBIT_TAPE_SYMBOLS;

afterEach(() => {
  if (savedFlow === undefined) delete process.env.BYBIT_FLOW;
  else process.env.BYBIT_FLOW = savedFlow;
  if (savedTape === undefined) delete process.env.BYBIT_TAPE_SYMBOLS;
  else process.env.BYBIT_TAPE_SYMBOLS = savedTape;
});

describe("Bybit V5 public linear topic names", () => {
  test("matches official topic templates", () => {
    expect(tickerTopic("BTCUSDT")).toBe("tickers.BTCUSDT");
    expect(klineTopic("15", "ETHUSDT")).toBe("kline.15.ETHUSDT");
    expect(orderbookTopic(50, "SOLUSDT")).toBe("orderbook.50.SOLUSDT");
    expect(liquidationTopic("BTCUSDT")).toBe("allLiquidation.BTCUSDT");
    expect(publicTradeTopic("BTCUSDT")).toBe("publicTrade.BTCUSDT");
  });

  test("subscribes L50 and CVD/liq for every watchlist symbol by default", () => {
    delete process.env.BYBIT_FLOW;
    delete process.env.BYBIT_TAPE_SYMBOLS;
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
    expect(topics).toContain("allLiquidation.ENAUSDT");
    expect(topics).not.toContain("allLiquidation.SOLUSDT");
    expect(topics).toContain("publicTrade.BTCUSDT");
    expect(topics).toContain("publicTrade.ENAUSDT");
    expect(topics.filter((topic) => topic.startsWith("tickers.")).length).toBe(3);
    expect(topics.filter((topic) => topic.startsWith("kline.")).length).toBe(12);
    expect(topics.filter((topic) => topic.startsWith("orderbook.")).length).toBe(4);
    expect(topics.filter((topic) => topic.startsWith("allLiquidation.")).length).toBe(3);
    expect(topics.filter((topic) => topic.startsWith("publicTrade.")).length).toBe(3);
  });

  test("default config L50 and tape both match the 10-symbol watchlist", async () => {
    delete process.env.BYBIT_FLOW;
    delete process.env.BYBIT_TAPE_SYMBOLS;
    const loaded = await loadConfig();
    expect(loaded.orderbook.symbols).toEqual(loaded.symbols);
    const topics = buildTopics(loaded);
    expect(topics.filter((topic) => topic.startsWith("orderbook.")).length).toBe(10);
    expect(topics).toContain("orderbook.50.HYPEUSDT");
    expect(topics).toContain("orderbook.50.ENAUSDT");
    expect(topics.filter((topic) => topic.startsWith("allLiquidation.")).length).toBe(10);
    expect(topics.filter((topic) => topic.startsWith("publicTrade.")).length).toBe(10);
    expect(topics).toContain("allLiquidation.HYPEUSDT");
    expect(topics).toContain("publicTrade.ENAUSDT");
  });

  test("BYBIT_TAPE_SYMBOLS=watchlist expands CVD/liq; 0 = none; comma list intersects", () => {
    delete process.env.BYBIT_FLOW;
    process.env.BYBIT_TAPE_SYMBOLS = "watchlist";
    expect(tapeSymbols(config).sort()).toEqual(["BTCUSDT", "ENAUSDT", "ETHUSDT"]);
    const watch = buildTopics(config);
    expect(watch).toContain("publicTrade.ENAUSDT");
    expect(watch).toContain("allLiquidation.ENAUSDT");
    expect(watch.filter((topic) => topic.startsWith("publicTrade.")).length).toBe(3);

    process.env.BYBIT_TAPE_SYMBOLS = "*";
    const star = tapeSymbols(config);
    process.env.BYBIT_TAPE_SYMBOLS = "watchlist";
    expect(tapeSymbols(config)).toEqual(star);

    process.env.BYBIT_TAPE_SYMBOLS = "0";
    const none = buildTopics(config);
    expect(none.some((topic) => topic.startsWith("publicTrade."))).toBe(false);
    expect(none.some((topic) => topic.startsWith("allLiquidation."))).toBe(false);

    process.env.BYBIT_TAPE_SYMBOLS = "ENAUSDT,SOLUSDT";
    expect(tapeSymbols(config)).toEqual(["ENAUSDT"]);
    const listed = buildTopics(config);
    expect(listed).toContain("publicTrade.ENAUSDT");
    expect(listed).not.toContain("publicTrade.BTCUSDT");
    expect(listed).not.toContain("publicTrade.SOLUSDT");
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
    delete process.env.BYBIT_TAPE_SYMBOLS;
    const topics = buildTopics(config);
    expect(topics.some((topic) => topic.startsWith("publicTrade."))).toBe(false);
    expect(topics).toContain("allLiquidation.BTCUSDT");
  });
});
