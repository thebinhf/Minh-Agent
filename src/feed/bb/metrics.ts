import type { FeedHealth } from "./health";

/**
 * Minimal Prometheus exposition for the public feed. Additive: does not change
 * any JSON contract. Scrape with `GET /metrics` (text/plain).
 */
export function buildFeedMetrics(health: FeedHealth): string {
  const lines: string[] = [];
  const ok = health.ok ? 1 : 0;
  const lagOk = health.klineLag.ok ? 1 : 0;
  lines.push("# HELP minh_feed_ok WS/ticker freshness (1=ok).");
  lines.push("# TYPE minh_feed_ok gauge");
  lines.push(`minh_feed_ok ${ok}`);
  lines.push("# HELP minh_kline_lag_ok Kline lag watchdog (1=ok).");
  lines.push("# TYPE minh_kline_lag_ok gauge");
  lines.push(`minh_kline_lag_ok ${lagOk}`);
  lines.push("# HELP minh_feed_connected WS connected (1=yes).");
  lines.push("# TYPE minh_feed_connected gauge");
  lines.push(`minh_feed_connected ${health.connected ? 1 : 0}`);
  lines.push("# HELP minh_feed_last_message_age_ms Age of last WS message.");
  lines.push("# TYPE minh_feed_last_message_age_ms gauge");
  lines.push(`minh_feed_last_message_age_ms ${health.lastMessageAgeMs ?? -1}`);
  lines.push("# HELP minh_feed_last_pong_age_ms Age of last WS pong.");
  lines.push("# TYPE minh_feed_last_pong_age_ms gauge");
  lines.push(`minh_feed_last_pong_age_ms ${health.lastPongAgeMs ?? -1}`);
  const stale = health.klineLag.rows.filter((row) => row.stale).length;
  lines.push("# HELP minh_kline_lag_stale_rows Stale kline-lag rows.");
  lines.push("# TYPE minh_kline_lag_stale_rows gauge");
  lines.push(`minh_kline_lag_stale_rows ${stale}`);
  lines.push("# HELP minh_feed_ticker_age_ms Ticker age per symbol.");
  lines.push("# TYPE minh_feed_ticker_age_ms gauge");
  for (const ticker of health.tickers) {
    const symbol = String(ticker.symbol ?? "").replace(/[^A-Z0-9_]/gi, "_");
    const age = Number.isFinite(ticker.ageMs) ? ticker.ageMs : -1;
    lines.push(`minh_feed_ticker_age_ms{symbol="${symbol}"} ${age}`);
  }
  return `${lines.join("\n")}\n`;
}
