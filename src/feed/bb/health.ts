import { DEFAULT_RECOVERY } from "./config";
import type { TrackerDb } from "./db";
import { intervalToMs } from "./recovery";
import { PA_KLINE_INTERVALS, type TrackerConfig } from "./types";

/** Default: forming/confirmed 15/60/240 klines are stale after 3 minutes while ticker is live. */
export const DEFAULT_KLINE_LAG_MS = DEFAULT_RECOVERY.klineLagMs;

/** Same freshness window as GET /health `ok` (ticker WS still updating). */
export const TICKER_LIVE_MS = 15_000;

export const KLINE_LAG_INTERVALS = PA_KLINE_INTERVALS;

export type KlineLagRow = {
  symbol: string;
  interval: string;
  startTs: number | null;
  recvTs: number | null;
  confirm: boolean | null;
  klineLagMs: number | null;
  tickerAgeMs: number | null;
  tickerLive: boolean;
  formingStuck: boolean;
  stale: boolean;
};

export type KlineLagSummary = {
  ok: boolean;
  staleMs: number;
  intervals: string[];
  rows: KlineLagRow[];
};

export type FeedHealthTicker = {
  symbol: string;
  lastPrice: unknown;
  ageMs: number;
};

export type FeedHealth = {
  ok: boolean;
  connected: boolean;
  endpoint: unknown;
  subscribedTopics: unknown;
  lastMessageAgeMs: number | null;
  lastPongAgeMs: number | null;
  reconnectCount: unknown;
  lastError: unknown;
  tickers: FeedHealthTicker[];
  klineLag: KlineLagSummary;
};

export type KlineLagStore = Pick<TrackerDb, "latestKlines" | "listTickers">;

export type FeedHealthStore = Pick<TrackerDb, "getHealth" | "latestKlines" | "listTickers">;

type TickerRow = {
  symbol?: unknown;
  last_price?: unknown;
  recv_ts?: unknown;
};

function numberField(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function confirmField(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return Boolean(value);
}

export function lagRowKey(row: Pick<KlineLagRow, "symbol" | "interval">): string {
  return `${row.symbol}|${row.interval}`;
}

/**
 * Detect klines that stopped advancing while ticker WS is still live.
 * Does not trip when the ticker itself is stale — that is the existing /health `ok` path.
 */
export function evaluateKlineLag(input: {
  symbol: string;
  interval: string;
  now: number;
  startTs: number | null;
  recvTs: number | null;
  confirm: boolean | null;
  tickerRecvTs: number | null;
  staleMs: number;
  tickerLiveMs?: number;
}): KlineLagRow {
  const tickerLiveMs = input.tickerLiveMs ?? TICKER_LIVE_MS;
  const tickerAgeMs = input.tickerRecvTs == null ? null : input.now - input.tickerRecvTs;
  const tickerLive = tickerAgeMs != null && tickerAgeMs >= 0 && tickerAgeMs < tickerLiveMs;
  const klineLagMs = input.recvTs == null ? null : input.now - input.recvTs;
  const enabled = Number.isFinite(input.staleMs) && input.staleMs > 0;
  const recvStale = enabled && klineLagMs != null && klineLagMs >= input.staleMs;
  let behindCurrent = false;
  try {
    const intervalMs = intervalToMs(input.interval);
    const expectedStartTs = Math.floor(input.now / intervalMs) * intervalMs;
    behindCurrent = enabled
      && input.startTs != null
      && input.startTs < expectedStartTs
      && input.now - expectedStartTs >= input.staleMs;
  } catch {
    behindCurrent = false;
  }
  const formingStuck = Boolean(tickerLive && input.confirm === false && recvStale);
  const stale = Boolean(tickerLive && (recvStale || behindCurrent || formingStuck));
  return {
    symbol: input.symbol,
    interval: input.interval,
    startTs: input.startTs,
    recvTs: input.recvTs,
    confirm: input.confirm,
    klineLagMs,
    tickerAgeMs,
    tickerLive,
    formingStuck,
    stale,
  };
}

function healthSymbols(store: KlineLagStore, config: Pick<TrackerConfig, "symbols">, intervals: string[]): string[] {
  if (config.symbols?.length) return [...config.symbols];
  const symbols = new Set<string>();
  try {
    for (const row of store.listTickers() as TickerRow[]) {
      const symbol = String(row.symbol ?? "").trim().toUpperCase();
      if (symbol) symbols.add(symbol);
    }
  } catch {
    // missing ticker table → still try klines
  }
  try {
    for (const row of store.latestKlines(intervals)) {
      const symbol = String(row.symbol ?? "").trim().toUpperCase();
      if (symbol) symbols.add(symbol);
    }
  } catch {
    // missing klines → empty extra
  }
  return [...symbols].sort();
}

export function klineLagMsFromConfig(config: Partial<TrackerConfig> | undefined): number {
  const raw = config?.recovery?.klineLagMs;
  return Number.isFinite(raw) ? Number(raw) : DEFAULT_KLINE_LAG_MS;
}

export function buildKlineLag(
  store: KlineLagStore,
  opts: {
    config?: Partial<TrackerConfig>;
    now?: number;
    symbol?: string | null;
    intervals?: readonly string[];
    staleMs?: number;
    tickerLiveMs?: number;
  } = {},
): KlineLagSummary {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? klineLagMsFromConfig(opts.config);
  const intervals = [...(opts.intervals ?? KLINE_LAG_INTERVALS)];
  const filter = opts.symbol?.trim().toUpperCase() || undefined;
  const symbols = filter
    ? [filter]
    : healthSymbols(store, { symbols: opts.config?.symbols ?? [] }, intervals);
  const tickerBySymbol = new Map<string, TickerRow>();
  try {
    const rows = store.listTickers(filter) as TickerRow[];
    for (const row of rows) {
      const symbol = String(row.symbol ?? "").trim().toUpperCase();
      if (symbol) tickerBySymbol.set(symbol, row);
    }
  } catch {
    // empty tickers
  }
  const latestByKey = new Map<string, { start_ts: number; recv_ts: number; confirm: number }>();
  try {
    for (const row of store.latestKlines(intervals, filter)) {
      latestByKey.set(`${row.symbol}|${row.interval}`, row);
    }
  } catch {
    // empty klines
  }
  const rows: KlineLagRow[] = [];
  for (const symbol of symbols) {
    const ticker = tickerBySymbol.get(symbol);
    const tickerRecvTs = numberField(ticker?.recv_ts);
    for (const interval of intervals) {
      const latest = latestByKey.get(`${symbol}|${interval}`);
      rows.push(evaluateKlineLag({
        symbol,
        interval,
        now,
        startTs: latest ? numberField(latest.start_ts) : null,
        recvTs: latest ? numberField(latest.recv_ts) : null,
        confirm: latest ? confirmField(latest.confirm) : null,
        tickerRecvTs,
        staleMs,
        tickerLiveMs: opts.tickerLiveMs,
      }));
    }
  }
  return {
    ok: rows.every((row) => !row.stale),
    staleMs,
    intervals,
    rows,
  };
}

export function buildFeedHealth(
  store: FeedHealthStore,
  config: Partial<TrackerConfig> = {},
  now = Date.now(),
): FeedHealth {
  const health = tryRead(() => store.getHealth() ?? {}, {});
  const lastMessageTs = Number(health.last_message_ts ?? 0);
  const lastPongTs = Number(health.last_pong_ts ?? 0);
  const connected = Boolean(health.connected);
  const lastMessageAgeMs = lastMessageTs ? now - lastMessageTs : null;
  const tickers = tryRead(() => (
    (store.listTickers() as TickerRow[]).map((row) => ({
      symbol: String(row.symbol ?? ""),
      lastPrice: row.last_price,
      ageMs: now - Number(row.recv_ts),
    }))
  ), [] as FeedHealthTicker[]);
  return {
    ok: connected && lastMessageAgeMs !== null && lastMessageAgeMs < TICKER_LIVE_MS,
    connected,
    endpoint: health.endpoint,
    subscribedTopics: health.subscribed_topics,
    lastMessageAgeMs,
    lastPongAgeMs: lastPongTs ? now - lastPongTs : null,
    reconnectCount: health.reconnect_count,
    lastError: health.last_error,
    tickers,
    klineLag: buildKlineLag(store, { config, now }),
  };
}

export function applyKlineLagWatch(
  prev: Set<string>,
  rows: KlineLagRow[],
  hooks: {
    trip?: (row: KlineLagRow) => void;
    recover?: (symbol: string, interval: string) => void;
  } = {},
): Set<string> {
  const next = new Set<string>();
  const byKey = new Map<string, KlineLagRow>();
  for (const row of rows) {
    const key = lagRowKey(row);
    byKey.set(key, row);
    if (row.stale) next.add(key);
  }
  for (const key of next) {
    if (prev.has(key)) continue;
    const row = byKey.get(key);
    if (row) hooks.trip?.(row);
  }
  for (const key of prev) {
    if (next.has(key)) continue;
    const [symbol, interval] = key.split("|");
    hooks.recover?.(symbol ?? "", interval ?? "");
  }
  return next;
}

export function logKlineLagTrip(row: KlineLagRow): void {
  const why = row.formingStuck ? "formingStuck" : "stale";
  console.warn(
    `[minh:bb] kline lag ${row.symbol} ${row.interval} ${why} klineLagMs=${row.klineLagMs} startTs=${row.startTs}`,
  );
}

export function logKlineLagRecover(symbol: string, interval: string): void {
  console.log(`[minh:bb] kline lag recovered ${symbol} ${interval}`);
}

/** Edge-triggered log only (stuck → recovered). Not a mid-watch price ping. */
export function startKlineLagWatchdog(config: TrackerConfig, store: TrackerDb): { stop: () => void } {
  let prev = new Set<string>();
  const intervalMs = Math.max(1_000, config.recovery?.watchdogIntervalMs ?? DEFAULT_RECOVERY.watchdogIntervalMs);
  const timer = setInterval(() => {
    try {
      const summary = buildKlineLag(store, { config });
      prev = applyKlineLagWatch(prev, summary.rows, {
        trip: logKlineLagTrip,
        recover: logKlineLagRecover,
      });
    } catch (error) {
      console.error("[minh:bb] kline lag watchdog", error instanceof Error ? error.message : error);
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

function tryRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
