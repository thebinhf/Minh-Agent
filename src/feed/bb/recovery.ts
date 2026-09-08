export type RetryOptions = {
  retries: number;
  delayMs: number;
  signal?: AbortSignal;
};

export function isPongStale(opts: {
  now: number;
  connectTs: number;
  lastPongTs: number;
  graceMs: number;
  staleMs: number;
}): boolean {
  if (opts.connectTs <= 0) return false;
  if (opts.now - opts.connectTs < opts.graceMs) return false;
  if (opts.lastPongTs <= 0) return true;
  return opts.now - opts.lastPongTs >= opts.staleMs;
}

export function chunkTopics(topics: string[], size: number): string[][] {
  const chunkSize = Math.max(1, size);
  const chunks: string[][] = [];
  for (let i = 0; i < topics.length; i += chunkSize) {
    chunks.push(topics.slice(i, i + chunkSize));
  }
  return chunks;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.retries);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (error && typeof error === "object" && "retryable" in error && error.retryable === false) {
        break;
      }
      await sleep(options.delayMs * attempt, options.signal);
    }
  }
  throw lastError;
}

const DAY_MS = 86_400_000;

/** Bybit v5 named kline intervals (UTC calendar units, not minute counts). */
const NAMED_INTERVAL_MS: Record<string, number> = {
  D: DAY_MS,
  W: 7 * DAY_MS,
  /** Representative 30d step for gap math; candle close uses `klineEndTs`. */
  M: 30 * DAY_MS,
};

/**
 * Canonical Bybit v5 kline interval id: minute strings stay as-is (`15`),
 * named tokens are uppercased (`d` → `D`).
 */
export function normalizeKlineInterval(interval: string): string {
  const token = interval.trim();
  if (!token) {
    throw new Error(`Unsupported kline interval: ${interval}`);
  }
  const upper = token.toUpperCase();
  if (upper in NAMED_INTERVAL_MS) return upper;
  return token;
}

/**
 * Duration in ms for a Bybit v5 kline interval.
 * Numeric ids are minutes (`1`,`3`,`5`,`15`,`30`,`60`,`120`,`240`,`360`,`720`).
 * Named ids: `D` = 1 UTC day, `W` = 7 UTC days, `M` ≈ 30 UTC days.
 */
export function intervalToMs(interval: string): number {
  const token = normalizeKlineInterval(interval);
  const named = NAMED_INTERVAL_MS[token];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`Unsupported kline interval: ${interval}`);
  }
  const minutes = Number(token);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`Unsupported kline interval: ${interval}`);
  }
  return minutes * 60_000;
}

/** Exclusive candle end. Monthly bars close at the next UTC calendar month. */
export function klineEndTs(start: number, interval: string): number {
  const token = normalizeKlineInterval(interval);
  if (token === "M") {
    const d = new Date(start);
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    );
  }
  return start + intervalToMs(token);
}

export function computeGapStart(
  lastStartTs: number | null,
  now: number,
  lookbackMs: number,
): number {
  const floor = now - lookbackMs;
  if (lastStartTs === null) return floor;
  return Math.max(lastStartTs, floor);
}

export function restCandleConfirm(start: number, intervalMs: number, now: number): boolean {
  return start + intervalMs <= now;
}

/** Parse CLI/HTTP time as Unix epoch milliseconds (13-digit), ISO-8601, or `YYYY-MM-DD`. */
export function parseTimeArg(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid time: ${raw}`);
  }
  return ms;
}
