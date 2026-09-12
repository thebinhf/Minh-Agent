import type { TrackerConfig } from "./types";
import { liqEnabled } from "./liq";
import { flowEnabled } from "./flow";

export const TAPE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

/**
 * CVD + liq subscribe set. L50 follows `orderbook.symbols`.
 * Default: every config symbol (the watchlist). Comma list intersects.
 * `watchlist` / `*` = same as default. `0` = none.
 * Replay cannot invent historical publicTrade/liq — missing stays null.
 */
export function tapeSymbols(config: Pick<TrackerConfig, "symbols">): string[] {
  const watch = new Set(config.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
  const raw = process.env.BYBIT_TAPE_SYMBOLS?.trim();
  let wanted: string[];
  if (raw == null || raw === "" || raw === "*" || raw.toLowerCase() === "watchlist") {
    wanted = [...watch];
  } else if (raw === "0") {
    wanted = [];
  } else {
    wanted = raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  }
  return wanted.filter((symbol) => watch.has(symbol));
}

/** Bybit V5 public linear topics (verified 2026-09). */
export function tickerTopic(symbol: string): string {
  return `tickers.${symbol}`;
}

export function klineTopic(interval: string, symbol: string): string {
  return `kline.${interval}.${symbol}`;
}

export function orderbookTopic(depth: number, symbol: string): string {
  return `orderbook.${depth}.${symbol}`;
}

export function liquidationTopic(symbol: string): string {
  return `allLiquidation.${symbol}`;
}

export function publicTradeTopic(symbol: string): string {
  return `publicTrade.${symbol}`;
}

export function buildTopics(config: TrackerConfig): string[] {
  const topics: string[] = [];
  for (const symbol of config.symbols) {
    topics.push(tickerTopic(symbol));
    for (const interval of config.klineIntervals) {
      topics.push(klineTopic(interval, symbol));
    }
  }
  for (const symbol of config.orderbook.symbols) {
    topics.push(orderbookTopic(config.orderbook.depth, symbol));
  }
  for (const symbol of tapeSymbols(config)) {
    if (liqEnabled()) topics.push(liquidationTopic(symbol));
    if (flowEnabled()) topics.push(publicTradeTopic(symbol));
  }
  return topics;
}

export function parseTopic(topic: string):
  | { kind: "ticker"; symbol: string }
  | { kind: "kline"; interval: string; symbol: string }
  | { kind: "orderbook"; depth: number; symbol: string }
  | { kind: "liquidation"; symbol: string }
  | { kind: "publicTrade"; symbol: string }
  | { kind: "unknown"; topic: string } {
  const ticker = /^tickers\.(.+)$/.exec(topic);
  if (ticker) return { kind: "ticker", symbol: ticker[1] };

  const kline = /^kline\.([^.]+)\.(.+)$/.exec(topic);
  if (kline) return { kind: "kline", interval: kline[1], symbol: kline[2] };

  const book = /^orderbook\.(\d+)\.(.+)$/.exec(topic);
  if (book) return { kind: "orderbook", depth: Number(book[1]), symbol: book[2] };

  const liq = /^allLiquidation\.(.+)$/.exec(topic);
  if (liq) return { kind: "liquidation", symbol: liq[1] };

  const trade = /^publicTrade\.(.+)$/.exec(topic);
  if (trade) return { kind: "publicTrade", symbol: trade[1] };

  return { kind: "unknown", topic };
}
