import type { TrackerDb } from "./db";
import {
  computeGapStart,
  klineEndTs,
  normalizeKlineInterval,
  restCandleConfirm,
  withRetries,
} from "./recovery";
import type { BybitKline, TrackerConfig } from "./types";
import {
  oiEnabled,
  oiIntervalsFromEnv,
  parseRestOiList,
  toBybitOiInterval,
  type OiBar,
  type OiInterval,
} from "./oi";

type RestKlineRow = [string, string, string, string, string, string, string];

export type RestFetch = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

const FAILOVER_STATUS = new Set([401, 403, 404]);

let cachedWorkingBase: string | undefined;

export function resetRestHostCache(): void {
  cachedWorkingBase = undefined;
}

export function restBases(config: Pick<TrackerConfig, "restEndpoint" | "restFallbacks">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [config.restEndpoint, ...(config.restFallbacks ?? [])]) {
    if (!raw) continue;
    const base = raw.replace(/\/+$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

function orderedBases(config: Pick<TrackerConfig, "restEndpoint" | "restFallbacks">): string[] {
  const bases = restBases(config);
  if (!cachedWorkingBase) return bases;
  return [cachedWorkingBase, ...bases.filter((base) => base !== cachedWorkingBase)];
}

function isFailoverError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "failover" in error && error.failover === true);
}

export function parseRestKlineList(
  list: unknown,
  interval: string,
  now: number,
): BybitKline[] {
  if (!Array.isArray(list)) return [];
  const resolved = normalizeKlineInterval(interval);
  const candles: BybitKline[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [startRaw, open, high, low, close, volume, turnover] = row as RestKlineRow;
    const start = Number(startRaw);
    if (!Number.isFinite(start)) continue;
    const end = klineEndTs(start, resolved);
    candles.push({
      start,
      end,
      interval: resolved,
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(close),
      volume: String(volume),
      turnover: String(turnover),
      confirm: restCandleConfirm(start, end - start, now),
      timestamp: start,
    });
  }
  return candles;
}

async function fetchLinearKlinesFromBase(
  base: string,
  config: TrackerConfig,
  opts: {
    symbol: string;
    interval: string;
    start: number;
    end: number;
    now: number;
    fetchImpl: RestFetch;
    signal?: AbortSignal;
  },
): Promise<BybitKline[]> {
  const recovery = config.recovery;
  const interval = normalizeKlineInterval(opts.interval);
  const url = new URL("/v5/market/kline", base);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", opts.symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("start", String(opts.start));
  url.searchParams.set("end", String(opts.end));
  url.searchParams.set("limit", "1000");

  return withRetries(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), recovery.restTimeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await opts.fetchImpl(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        const error = new Error(`Bybit REST kline HTTP ${res.status} (${base})`);
        if (FAILOVER_STATUS.has(res.status)) {
          throw Object.assign(error, { retryable: false, failover: true, status: res.status });
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
      return parseRestKlineList(body.result?.list, interval, opts.now);
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
  const fetchImpl = opts.fetchImpl ?? (fetch as RestFetch);
  const now = opts.now ?? Date.now();
  const bases = orderedBases(config);
  let lastError: unknown;

  for (const base of bases) {
    try {
      const candles = await fetchLinearKlinesFromBase(base, config, {
        symbol: opts.symbol,
        interval: opts.interval,
        start: opts.start,
        end: opts.end,
        now,
        fetchImpl,
        signal: opts.signal,
      });
      if (cachedWorkingBase !== base) {
        if (cachedWorkingBase || base !== restBases(config)[0]) {
          console.log(`[minh:bb] REST kline host ${base}`);
        }
        cachedWorkingBase = base;
      }
      return candles;
    } catch (error) {
      lastError = error;
      if (opts.signal?.aborted) throw error;
      if (!isFailoverError(error)) throw error;
      if (base === bases[bases.length - 1]) break;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[minh:bb] ${message}; trying next REST host`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Bybit REST kline failed on every host");
}

export async function probeRestHosts(
  config: Pick<TrackerConfig, "restEndpoint" | "restFallbacks" | "recovery">,
  opts: { fetchImpl?: RestFetch; signal?: AbortSignal } = {},
): Promise<Array<{ base: string; ok: boolean; status?: number; error?: string }>> {
  const fetchImpl = opts.fetchImpl ?? (fetch as RestFetch);
  const results: Array<{ base: string; ok: boolean; status?: number; error?: string }> = [];
  for (const base of restBases(config)) {
    const url = new URL("/v5/market/time", base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.recovery?.restTimeoutMs ?? 10_000);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchImpl(url.toString(), { signal: controller.signal });
      let ok = res.ok;
      if (res.ok) {
        try {
          const body = (await res.json()) as { retCode?: number };
          ok = body.retCode === 0 || body.retCode === undefined;
        } catch {
          ok = false;
        }
      }
      results.push({ base, ok, status: res.status });
    } catch (error) {
      results.push({
        base,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  return results;
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
        const lastStart = store.getLastKlineStart(symbol, interval);
        const written = await fillWindow(config, store, {
          symbol,
          interval,
          start: computeGapStart(lastStart, now, lookbackMs),
          end: now,
          now,
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

export async function fillKlineHistory(
  config: TrackerConfig,
  store: Pick<TrackerDb, "saveKline">,
  opts: {
    symbols: string[];
    intervals: string[];
    start: number;
    end: number;
    now?: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<{ series: number; candles: number; errors: number; host?: string }> {
  const now = opts.now ?? Date.now();
  let candles = 0;
  let errors = 0;
  let series = 0;

  for (const symbol of opts.symbols) {
    for (const interval of opts.intervals) {
      if (opts.signal?.aborted) {
        return { series, candles, errors, host: cachedWorkingBase };
      }
      series += 1;
      try {
        const written = await fillWindow(config, store, {
          symbol,
          interval,
          start: opts.start,
          end: opts.end,
          now,
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
        });
        candles += written;
        console.log(`[minh:bb] backfill ${symbol} ${interval} wrote ${written}`);
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[minh:bb] backfill ${symbol} ${interval}: ${message}`);
      }
    }
  }

  return { series, candles, errors, host: cachedWorkingBase };
}

async function fillWindow(
  config: TrackerConfig,
  store: Pick<TrackerDb, "saveKline">,
  opts: {
    symbol: string;
    interval: string;
    start: number;
    end: number;
    now: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<number> {
  let start = opts.start;
  let end = opts.end;
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

export const REST_OI_LIMIT = 200;

async function fetchLinearOiFromBase(
  base: string,
  config: TrackerConfig,
  opts: {
    symbol: string;
    interval: OiInterval;
    start: number;
    end: number;
    fetchImpl: RestFetch;
    signal?: AbortSignal;
  },
): Promise<OiBar[]> {
  const recovery = config.recovery;
  const intervalTime = toBybitOiInterval(opts.interval);
  if (!intervalTime) return [];
  const url = new URL("/v5/market/open-interest", base);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", opts.symbol);
  url.searchParams.set("intervalTime", intervalTime);
  url.searchParams.set("startTime", String(opts.start));
  url.searchParams.set("endTime", String(opts.end));
  url.searchParams.set("limit", String(REST_OI_LIMIT));

  return withRetries(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), recovery.restTimeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await opts.fetchImpl(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        const error = new Error(`Bybit REST OI HTTP ${res.status} (${base})`);
        if (FAILOVER_STATUS.has(res.status)) {
          throw Object.assign(error, { retryable: false, failover: true, status: res.status });
        }
        throw error;
      }
      const body = (await res.json()) as {
        retCode?: number;
        retMsg?: string;
        result?: { list?: unknown };
      };
      if (body.retCode !== 0) {
        throw new Error(`Bybit REST OI ${body.retCode}: ${body.retMsg ?? "error"}`);
      }
      return parseRestOiList(body.result?.list);
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

export async function fetchLinearOpenInterest(
  config: TrackerConfig,
  opts: {
    symbol: string;
    interval: OiInterval;
    start: number;
    end: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<OiBar[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as RestFetch);
  const bases = orderedBases(config);
  let lastError: unknown;

  for (const base of bases) {
    try {
      const bars = await fetchLinearOiFromBase(base, config, {
        symbol: opts.symbol,
        interval: opts.interval,
        start: opts.start,
        end: opts.end,
        fetchImpl,
        signal: opts.signal,
      });
      if (cachedWorkingBase !== base) {
        if (cachedWorkingBase || base !== restBases(config)[0]) {
          console.log(`[minh:bb] REST OI host ${base}`);
        }
        cachedWorkingBase = base;
      }
      return bars;
    } catch (error) {
      lastError = error;
      if (opts.signal?.aborted) throw error;
      if (!isFailoverError(error)) throw error;
      if (base === bases[bases.length - 1]) break;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[minh:bb] ${message}; trying next REST host`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Bybit REST OI failed on every host");
}

async function fillOiWindow(
  config: TrackerConfig,
  store: Pick<TrackerDb, "saveOi">,
  opts: {
    symbol: string;
    interval: OiInterval;
    start: number;
    end: number;
    now: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<number> {
  let start = opts.start;
  let end = opts.end;
  let written = 0;

  while (end > start) {
    if (opts.signal?.aborted) break;
    const batch = await fetchLinearOpenInterest(config, {
      symbol: opts.symbol,
      interval: opts.interval,
      start,
      end,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
    });
    if (batch.length === 0) break;
    for (const bar of batch) {
      store.saveOi(opts.symbol, opts.interval, bar, opts.now);
      written += 1;
    }
    if (batch.length < REST_OI_LIMIT) break;
    const oldest = Math.min(...batch.map((bar) => bar.startTs));
    if (oldest <= start) break;
    end = oldest - 1;
  }

  return written;
}

export async function fillOiGaps(
  config: TrackerConfig,
  store: Pick<TrackerDb, "getLastOiStart" | "saveOi">,
  opts: {
    now?: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  } = {},
): Promise<{ series: number; bars: number; errors: number }> {
  if (!config.recovery.gapFill || !oiEnabled()) {
    return { series: 0, bars: 0, errors: 0 };
  }

  const now = opts.now ?? Date.now();
  const lookbackMs = config.retention.klinesDays * 86_400_000;
  const intervals = oiIntervalsFromEnv();
  let bars = 0;
  let errors = 0;
  let series = 0;

  for (const symbol of config.symbols) {
    for (const interval of intervals) {
      if (opts.signal?.aborted) return { series, bars, errors };
      series += 1;
      try {
        const lastStart = store.getLastOiStart(symbol, interval);
        const written = await fillOiWindow(config, store, {
          symbol,
          interval,
          start: computeGapStart(lastStart, now, lookbackMs),
          end: now,
          now,
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
        });
        bars += written;
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[minh:bb] OI gap-fill ${symbol} ${interval}: ${message}`);
      }
    }
  }

  return { series, bars, errors };
}

export async function fillOiHistory(
  config: TrackerConfig,
  store: Pick<TrackerDb, "saveOi">,
  opts: {
    symbols: string[];
    intervals: OiInterval[];
    start: number;
    end: number;
    now?: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<{ series: number; bars: number; errors: number; host?: string }> {
  const now = opts.now ?? Date.now();
  let bars = 0;
  let errors = 0;
  let series = 0;

  for (const symbol of opts.symbols) {
    for (const interval of opts.intervals) {
      if (opts.signal?.aborted) {
        return { series, bars, errors, host: cachedWorkingBase };
      }
      series += 1;
      try {
        const written = await fillOiWindow(config, store, {
          symbol,
          interval,
          start: opts.start,
          end: opts.end,
          now,
          fetchImpl: opts.fetchImpl,
          signal: opts.signal,
        });
        bars += written;
        console.log(`[minh:bb] OI backfill ${symbol} ${interval} wrote ${written}`);
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[minh:bb] OI backfill ${symbol} ${interval}: ${message}`);
      }
    }
  }

  return { series, bars, errors, host: cachedWorkingBase };
}
