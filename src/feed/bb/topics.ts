import type { TrackerConfig } from "./types";
import { liqEnabled } from "./liq";
import { flowEnabled } from "./flow";

/** CVD + liq prints stay on the liquid majors. L50 follows `orderbook.symbols`. */
export const TAPE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

export function tapeSymbols(config: Pick<TrackerConfig, "symbols">): string[] {
  const tape = new Set<string>(TAPE_SYMBOLS);
  return config.symbols.filter((symbol) => tape.has(symbol));
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
