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
import {
  fundingEnabled,
  parseRestFundingList,
  type FundingBar,
} from "./funding";

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

export const REST_FUNDING_LIMIT = 200;

async function fetchLinearFundingFromBase(
  base: string,
  config: TrackerConfig,
  opts: {
    symbol: string;
    start?: number;
    end: number;
    fetchImpl: RestFetch;
    signal?: AbortSignal;
  },
): Promise<FundingBar[]> {
  const recovery = config.recovery;
  const url = new URL("/v5/market/funding/history", base);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", opts.symbol);
  url.searchParams.set("endTime", String(opts.end));
  if (opts.start != null && Number.isFinite(opts.start)) {
    url.searchParams.set("startTime", String(opts.start));
  }
  url.searchParams.set("limit", String(REST_FUNDING_LIMIT));

  return withRetries(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), recovery.restTimeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await opts.fetchImpl(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        const error = new Error(`Bybit REST funding HTTP ${res.status} (${base})`);
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
        throw new Error(`Bybit REST funding ${body.retCode}: ${body.retMsg ?? "error"}`);
      }
      return parseRestFundingList(body.result?.list);
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

export async function fetchLinearFundingHistory(
  config: TrackerConfig,
  opts: {
    symbol: string;
    start?: number;
    end: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<FundingBar[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as RestFetch);
  const bases = orderedBases(config);
  let lastError: unknown;

  for (const base of bases) {
    try {
      const bars = await fetchLinearFundingFromBase(base, config, {
        symbol: opts.symbol,
        start: opts.start,
        end: opts.end,
        fetchImpl,
        signal: opts.signal,
      });
      if (cachedWorkingBase !== base) {
        if (cachedWorkingBase || base !== restBases(config)[0]) {
          console.log(`[minh:bb] REST funding host ${base}`);
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
    : new Error("Bybit REST funding failed on every host");
}

async function fillFundingWindow(
  config: TrackerConfig,
  store: Pick<TrackerDb, "saveFunding">,
  opts: {
    symbol: string;
    start?: number;
    end: number;
    now: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  },
): Promise<number> {
  let start = opts.start;
  let end = opts.end;
  let written = 0;
  const floor = opts.start;

  while (end > (start ?? 0) || start == null) {
    if (opts.signal?.aborted) break;
    const batch = await fetchLinearFundingHistory(config, {
      symbol: opts.symbol,
      start,
      end,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
    });
    if (batch.length === 0) break;
    for (const bar of batch) {
      if (floor != null && bar.fundingTs < floor) continue;
      store.saveFunding(opts.symbol, bar, opts.now);
      written += 1;
    }
    if (batch.length < REST_FUNDING_LIMIT) break;
    const oldest = Math.min(...batch.map((bar) => bar.fundingTs));
    if (oldest <= (start ?? 0)) break;
    end = oldest - 1;
    if (start == null && floor != null) start = floor;
  }

  return written;
}

export async function fillFundingGaps(
  config: TrackerConfig,
  store: Pick<TrackerDb, "getLastFundingTs" | "saveFunding">,
  opts: {
    now?: number;
    fetchImpl?: RestFetch;
    signal?: AbortSignal;
  } = {},
): Promise<{ series: number; bars: number; errors: number }> {
  if (!config.recovery.gapFill || !fundingEnabled()) {
    return { series: 0, bars: 0, errors: 0 };
  }

  const now = opts.now ?? Date.now();
  const lookbackMs = config.retention.klinesDays * 86_400_000;
  let bars = 0;
  let errors = 0;
  let series = 0;

  for (const symbol of config.symbols) {
    if (opts.signal?.aborted) return { series, bars, errors };
    series += 1;
    try {
      const last = store.getLastFundingTs(symbol);
      const start = last != null ? last + 1 : computeGapStart(null, now, lookbackMs);
      const written = await fillFundingWindow(config, store, {
        symbol,
        start: last != null ? start : undefined,
        end: now,
        now,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
      });
      bars += written;
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[minh:bb] funding gap-fill ${symbol}: ${message}`);
    }
  }

  return { series, bars, errors };
}

export async function fillFundingHistory(
  config: TrackerConfig,
  store: Pick<TrackerDb, "saveFunding">,
  opts: {
    symbols: string[];
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
    if (opts.signal?.aborted) {
      return { series, bars, errors, host: cachedWorkingBase };
    }
    series += 1;
    try {
      const written = await fillFundingWindow(config, store, {
        symbol,
        start: opts.start,
        end: opts.end,
        now,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
      });
      bars += written;
      console.log(`[minh:bb] funding backfill ${symbol} wrote ${written}`);
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[minh:bb] funding backfill ${symbol}: ${message}`);
    }
  }

  return { series, bars, errors, host: cachedWorkingBase };
}

export type RiskLimitRow = {
  mmRate: string;
  maxLeverage: string;
  ts: number;
};

const riskCache = new Map<string, RiskLimitRow>();
const RISK_TTL_MS = 3_600_000;

export function resetRiskLimitCache(): void {
  riskCache.clear();
}

export function peekRiskLimit(symbol: string): RiskLimitRow | null {
  const row = riskCache.get(symbol.toUpperCase());
  if (!row) return null;
  if (Date.now() - row.ts > RISK_TTL_MS) return null;
  return row;
}

export function parseRestRiskLimit(list: unknown): { mmRate: string; maxLeverage: string } | null {
  if (!Array.isArray(list)) return null;
  const rows: Array<{ mm: number; maxLev: string; lowest: boolean }> = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { maintenanceMargin?: unknown; maxLeverage?: unknown; isLowestRisk?: unknown };
    const mm = Number(rec.maintenanceMargin);
    const maxLev = rec.maxLeverage == null ? "" : String(rec.maxLeverage).trim();
    if (!Number.isFinite(mm) || mm < 0 || maxLev === "") continue;
    rows.push({
      mm,
      maxLev,
      lowest: rec.isLowestRisk === 1 || rec.isLowestRisk === "1",
    });
  }
  if (rows.length === 0) return null;
  const picked = rows.find((row) => row.lowest) ?? rows.reduce((a, b) => (a.mm <= b.mm ? a : b));
  return { mmRate: String(picked.mm), maxLeverage: picked.maxLev };
}

async function fetchLinearRiskLimitFromBase(
  base: string,
  config: TrackerConfig,
  opts: { symbol: string; fetchImpl: RestFetch; signal?: AbortSignal },
): Promise<{ mmRate: string; maxLeverage: string } | null> {
  const recovery = config.recovery;
  const url = new URL("/v5/market/risk-limit", base);
  url.searchParams.set("category", "linear");
  url.searchParams.set("symbol", opts.symbol);
  return withRetries(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), recovery.restTimeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await opts.fetchImpl(url.toString(), { signal: controller.signal });
      if (!res.ok) {
        const error = new Error(`Bybit REST risk-limit HTTP ${res.status} (${base})`);
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
        throw new Error(`Bybit REST risk-limit ${body.retCode}: ${body.retMsg ?? "error"}`);
      }
      return parseRestRiskLimit(body.result?.list);
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

export async function fetchLinearRiskLimit(
  config: TrackerConfig,
  opts: { symbol: string; fetchImpl?: RestFetch; signal?: AbortSignal },
): Promise<{ mmRate: string; maxLeverage: string } | null> {
  const fetchImpl = opts.fetchImpl ?? (fetch as RestFetch);
  const bases = orderedBases(config);
  let lastError: unknown;
  for (const base of bases) {
    try {
      const row = await fetchLinearRiskLimitFromBase(base, config, {
        symbol: opts.symbol,
        fetchImpl,
        signal: opts.signal,
      });
      if (cachedWorkingBase !== base) {
        if (cachedWorkingBase || base !== restBases(config)[0]) {
          console.log(`[minh:bb] REST risk-limit host ${base}`);
        }
        cachedWorkingBase = base;
      }
      return row;
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
    : new Error("Bybit REST risk-limit failed on every host");
}

export async function fillRiskLimits(
  config: TrackerConfig,
  opts: { now?: number; fetchImpl?: RestFetch; signal?: AbortSignal } = {},
): Promise<{ symbols: number; errors: number }> {
  if (!config.recovery.gapFill || process.env.BYBIT_LIQ_MODEL === "0") {
    return { symbols: 0, errors: 0 };
  }
  const now = opts.now ?? Date.now();
  let symbols = 0;
  let errors = 0;
  for (const symbol of config.symbols) {
    if (opts.signal?.aborted) return { symbols, errors };
    if (peekRiskLimit(symbol)) continue;
    symbols += 1;
    try {
      const row = await fetchLinearRiskLimit(config, {
        symbol,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
      });
      if (row) {
        riskCache.set(symbol.toUpperCase(), { ...row, ts: now });
      }
    } catch {
      errors += 1;
    }
  }
  return { symbols, errors };
}
