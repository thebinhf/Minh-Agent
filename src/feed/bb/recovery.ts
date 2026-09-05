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

export function intervalToMs(interval: string): number {
  const minutes = Number(interval);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Unsupported kline interval: ${interval}`);
  }
  return minutes * 60_000;
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
