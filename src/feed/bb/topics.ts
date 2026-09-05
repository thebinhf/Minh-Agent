import type { TrackerConfig } from "./types";

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
  return topics;
}

export function parseTopic(topic: string):
  | { kind: "ticker"; symbol: string }
  | { kind: "kline"; interval: string; symbol: string }
  | { kind: "orderbook"; depth: number; symbol: string }
  | { kind: "unknown"; topic: string } {
  const ticker = /^tickers\.(.+)$/.exec(topic);
  if (ticker) return { kind: "ticker", symbol: ticker[1] };

  const kline = /^kline\.([^.]+)\.(.+)$/.exec(topic);
  if (kline) return { kind: "kline", interval: kline[1], symbol: kline[2] };

  const book = /^orderbook\.(\d+)\.(.+)$/.exec(topic);
  if (book) return { kind: "orderbook", depth: Number(book[1]), symbol: book[2] };

  return { kind: "unknown", topic };
}
