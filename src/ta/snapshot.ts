import { normalizeBriefSymbol, readBriefKlines, type BriefStore } from "../feed/bb/brief";
import { parseTimeArg } from "../feed/bb/recovery";
import { barsFromKlines, lastBar } from "./bars";
import {
  TA_KLINE_LIMIT,
  TA_METHODS,
  TA_NOTE,
  parseTaInterval,
  type TaInterval,
  type TaMethodId,
} from "./catalog";
import { emptyMethod, packIntervalMs, packMethods, type TaMethodResult } from "./pack";

export type TaStore = BriefStore;

export type SnapshotTa = {
  symbol: string;
  interval: TaInterval;
  asof: number;
  quality: "ok" | "missing";
  last: {
    startTs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  } | null;
  methods: Record<TaMethodId, TaMethodResult>;
  meta: {
    db: string;
    limit: number;
    note: typeof TA_NOTE;
    signal: false;
    autoArm: false;
    ictAsSignal: false;
  };
};

export function parseTaAsof(
  raw: string | null | undefined,
  now = Date.now(),
): number | { error: "ta_asof" } {
  if (raw == null || raw.trim() === "") return now;
  try {
    const n = parseTimeArg(raw);
    if (!Number.isFinite(n) || n <= 0) return { error: "ta_asof" };
    return n;
  } catch {
    return { error: "ta_asof" };
  }
}

function emptyMethods(): Record<TaMethodId, TaMethodResult> {
  const out = {} as Record<TaMethodId, TaMethodResult>;
  for (const meta of TA_METHODS) out[meta.id] = emptyMethod(meta);
  return out;
}

export function emptyTa(
  symbol: string,
  interval: TaInterval,
  asof: number,
  dbPath: string,
): SnapshotTa {
  return {
    symbol,
    interval,
    asof,
    quality: "missing",
    last: null,
    methods: emptyMethods(),
    meta: {
      db: dbPath,
      limit: TA_KLINE_LIMIT,
      note: TA_NOTE,
      signal: false,
      autoArm: false,
      ictAsSignal: false,
    },
  };
}

/**
 * Read-only overlay pack from local klines. Does not arm. Missing stays null.
 * Moon phase uses `asof` only (not price). ICT labels are confirm, not detectors.
 */
export function buildTa(
  store: TaStore,
  opts: {
    symbol?: string | null;
    interval?: string | null;
    asof: number;
    dbPath: string;
  },
): SnapshotTa | { error: "ta_interval" } {
  const interval = parseTaInterval(opts.interval);
  if (typeof interval === "object") return interval;
  const symbol = normalizeBriefSymbol(opts.symbol);
  const asof = opts.asof;
  const intervalMs = packIntervalMs(interval);
  const rows = readBriefKlines(store, symbol, interval, TA_KLINE_LIMIT, {
    endTs: asof - intervalMs,
    confirm: true,
  });
  const bars = barsFromKlines(rows, asof, intervalMs);
  const last = lastBar(bars);
  const methods = packMethods(bars, { symbol, tf: interval, intervalMs, asof });
  const pricedOk = Object.values(methods).some((row) => row.id !== "moon_phases" && row.quality === "ok");
  return {
    symbol,
    interval,
    asof,
    quality: last && pricedOk ? "ok" : "missing",
    last: last
      ? {
        startTs: last.startTs,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
        volume: last.volume,
      }
      : null,
    methods,
    meta: {
      db: opts.dbPath,
      limit: TA_KLINE_LIMIT,
      note: TA_NOTE,
      signal: false,
      autoArm: false,
      ictAsSignal: false,
    },
  };
}
