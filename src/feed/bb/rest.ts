import type { TrackerDb } from "./db";
import {
  computeGapStart,
  intervalToMs,
  restCandleConfirm,
  withRetries,
} from "./recovery";
import type { BybitKline, TrackerConfig } from "./types";

type RestKlineRow = [string, string, string, string, string, string, string];

export type RestFetch = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export function parseRestKlineList(
  list: unknown,
  interval: string,
  now: number,
): BybitKline[] {
  if (!Array.isArray(list)) return [];
  const intervalMs = intervalToMs(interval);
  const candles: BybitKline[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [startRaw, open, high, low, close, volume, turnover] = row as RestKlineRow;
    const start = Number(startRaw);
    if (!Number.isFinite(start)) continue;
    candles.push({
      start,
      end: start + intervalMs,
      interval,
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(close),
      volume: String(volume),
      turnover: String(turnover),
      confirm: restCandleConfirm(start, intervalMs, now),
      timestamp: start,
    });
  }
  return candles;
}

export async function fetchLinearKlines(
  config: TrackerConfig,
  opts: {
    symbol: string;
    interval: string;
    start: number;
    end: number;
    now?: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<BybitKline[]> {
  const recovery = config.recovery;
  const url = new URL("/v5/market/kline", config.restEndpoint);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", opts.symbol);
  url.searchParams.set("interval", opts.interval);
  url.searchParams.set("start", String(opts.start));
  url.searchParams.set("end", String(opts.end));
  url.searchParams.set("limit", "1000");

  const fetchImpl = opts.fetchImpl ?? (fetch as RestFetch);
  const now = opts.now ?? Date.now();

  return withRetries(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), recovery.restTimeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        const error = new Error(`Bybit REST kline HTTP ${res.status}`);
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          throw Object.assign(error, { retryable: false });
        }
        throw error;
      }
      const body = (await res.json()) as {
        retCode?: number;
        retMsg?: string;
        result?: { list?: unknown };
      };
      if (body.retCode !== 0) {
        throw new Error(`Bybit REST kline ${body.retCode}: ${body.retMsg ?? "error"}`);
      }
      return parseRestKlineList(body.result?.list, opts.interval, now);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }, {
    retries: recovery.restRetries,
    delayMs: recovery.restRetryDelayMs,
    signal: opts.signal,
  });
}

export async function fillKlineGaps(
  config: TrackerConfig,
  store: Pick<TrackerDb, "getLastKlineStart" | "saveKline">,
  opts: {
    now?: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  } = {},
): Promise<{ series: number; candles: number; errors: number }> {
  if (!config.recovery.gapFill) {
    return { series: 0, candles: 0, errors: 0 };
  }

  const now = opts.now ?? Date.now();
  const lookbackMs = config.retention.klinesDays * 86_400_000;
  let candles = 0;
  let errors = 0;
  let series = 0;

  for (const symbol of config.symbols) {
    for (const interval of config.klineIntervals) {
      if (opts.signal?.aborted) {
        return { series, candles, errors };
      }
      series += 1;
      try {
        const written = await fillOneSeries(config, store, {
          symbol,
          interval,
          now,
          lookbackMs,
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
        });
        candles += written;
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[minh:bb] gap-fill ${symbol} ${interval}: ${message}`);
      }
    }
  }

  return { series, candles, errors };
}

async function fillOneSeries(
  config: TrackerConfig,
  store: Pick<TrackerDb, "getLastKlineStart" | "saveKline">,
  opts: {
    symbol: string;
    interval: string;
    now: number;
    lookbackMs: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<number> {
  const lastStart = store.getLastKlineStart(opts.symbol, opts.interval);
  let start = computeGapStart(lastStart, opts.now, opts.lookbackMs);
  let end = opts.now;
  let written = 0;

  while (end > start) {
    if (opts.signal?.aborted) break;
    const batch = await fetchLinearKlines(config, {
      symbol: opts.symbol,
      interval: opts.interval,
      start,
      end,
      now: opts.now,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
    });
    if (batch.length === 0) break;

    for (const candle of batch) {
      store.saveKline(opts.symbol, candle, opts.now);
      written += 1;
    }

    if (batch.length < 1000) break;
    const oldest = Math.min(...batch.map((candle) => candle.start));
    if (oldest <= start) break;
    end = oldest - 1;
  }

  return written;
}
