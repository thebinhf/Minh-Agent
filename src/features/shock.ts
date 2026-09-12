import type { BriefKline } from "../feed/bb/brief";
import type { TrackerDb } from "../feed/bb/db";
import { intervalToMs } from "../feed/bb/recovery";
import { atrSma, barsFromKlines, ZONE_DETECT } from "../zones/detect";

export const SHOCK_NOTE = "kline shock overlay — not a signal";
export const SHOCK_INTERVAL = "240";
export const SHOCK_KLINE_LIMIT = 40;
export const SHOCK_VOL_WINDOW = 20;
export const SHOCK_VOL_Z = 2;
export const SHOCK_RANGE_ATR = 1.5;

export type ShockStore = Pick<TrackerDb, "listKlines">;

export type ShockReading = "impulse" | "range_expand" | "vol_spike" | "quiet" | null;

export type ShockFlags = {
  impulse: boolean;
  rangeExpand: boolean;
  volSpike: boolean;
};

export type AsOfShock = {
  quality: "ok" | "missing";
  reading: ShockReading;
  flags: ShockFlags;
  interval: typeof SHOCK_INTERVAL;
  startTs: number | null;
  atr14: string | null;
  bodyAtr: string | null;
  rangeAtr: string | null;
  volumeZ: string | null;
  note: typeof SHOCK_NOTE;
};

export type ShockKline = BriefKline & { volume: string | null };

function emptyFlags(): ShockFlags {
  return { impulse: false, rangeExpand: false, volSpike: false };
}

function emptyShock(): AsOfShock {
  return {
    quality: "missing",
    reading: null,
    flags: emptyFlags(),
    interval: SHOCK_INTERVAL,
    startTs: null,
    atr14: null,
    bodyAtr: null,
    rangeAtr: null,
    volumeZ: null,
    note: SHOCK_NOTE,
  };
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratioText(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return String(Number(n.toFixed(4)));
}

function mapKline(row: Record<string, unknown>): ShockKline {
  return {
    start_ts: num(row.start_ts),
    open: row.open == null || row.open === "" ? null : String(row.open),
    high: row.high == null || row.high === "" ? null : String(row.high),
    low: row.low == null || row.low === "" ? null : String(row.low),
    close: row.close == null || row.close === "" ? null : String(row.close),
    volume: row.volume == null || row.volume === "" ? null : String(row.volume),
    turnover: row.turnover == null || row.turnover === "" ? null : String(row.turnover),
    confirm: row.confirm === true || row.confirm === 1 || row.confirm === "1"
      ? true
      : row.confirm === false || row.confirm === 0 || row.confirm === "0"
        ? false
        : null,
  };
}

/** Volume 0 is missing — do not invent a dry tape. */
function volumeOf(row: ShockKline): number | null {
  const n = num(row.volume);
  if (n == null || n <= 0) return null;
  return n;
}

function volumeByStart(rows: ShockKline[]): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const row of rows) {
    if (row.start_ts == null) continue;
    out.set(row.start_ts, volumeOf(row));
  }
  return out;
}

function volumeZScore(
  bars: Array<{ startTs: number }>,
  volumes: Map<number, number | null>,
  lastIndex: number,
): number | null {
  if (lastIndex < SHOCK_VOL_WINDOW) return null;
  const last = volumes.get(bars[lastIndex]!.startTs);
  if (last == null) return null;
  const prior: number[] = [];
  for (let i = lastIndex - SHOCK_VOL_WINDOW; i < lastIndex; i++) {
    const v = volumes.get(bars[i]!.startTs);
    if (v == null) return null;
    prior.push(v);
  }
  const mean = prior.reduce((sum, v) => sum + v, 0) / prior.length;
  const variance = prior.reduce((sum, v) => sum + (v - mean) ** 2, 0) / prior.length;
  const stdev = Math.sqrt(variance);
  if (!(stdev > 0)) return null;
  return (last - mean) / stdev;
}

function pickReading(flags: ShockFlags, atrOk: boolean): ShockReading {
  if (flags.impulse) return "impulse";
  if (flags.volSpike) return "vol_spike";
  if (flags.rangeExpand) return "range_expand";
  if (atrOk) return "quiet";
  return null;
}

/**
 * Closed 4H kline shock at `asof`. Missing ATR/volume stays null.
 * Does not read tape. Does not arm.
 */
export function asOfShock(
  store: ShockStore,
  opts: { symbol: string; asof: number },
): AsOfShock {
  const symbol = opts.symbol.trim().toUpperCase();
  const intervalMs = intervalToMs(SHOCK_INTERVAL);
  const endTs = opts.asof - intervalMs;
  if (!Number.isFinite(endTs) || endTs <= 0) return emptyShock();

  const raw = store.listKlines({
    symbol,
    interval: SHOCK_INTERVAL,
    confirm: true,
    endTs,
    limit: SHOCK_KLINE_LIMIT,
    maxLimit: SHOCK_KLINE_LIMIT,
  }) as Array<Record<string, unknown>>;
  const rows = raw.map(mapKline).sort((a, b) => (a.start_ts ?? 0) - (b.start_ts ?? 0));
  const bars = barsFromKlines(rows);
  if (bars.length === 0) return emptyShock();

  const lastIndex = bars.length - 1;
  const last = bars[lastIndex]!;
  const atr = atrSma(bars, lastIndex);
  const bodyAtr = atr != null ? Math.abs(last.close - last.open) / atr : null;
  const rangeAtr = atr != null ? (last.high - last.low) / atr : null;
  const volumeZ = volumeZScore(bars, volumeByStart(rows), lastIndex);
  const flags: ShockFlags = {
    impulse: bodyAtr != null && bodyAtr >= ZONE_DETECT.impulseMinAtr,
    rangeExpand: rangeAtr != null && rangeAtr >= SHOCK_RANGE_ATR,
    volSpike: volumeZ != null && volumeZ >= SHOCK_VOL_Z,
  };
  const atrOk = atr != null;
  return {
    quality: atrOk ? "ok" : "missing",
    reading: pickReading(flags, atrOk),
    flags,
    interval: SHOCK_INTERVAL,
    startTs: last.startTs,
    atr14: ratioText(atr),
    bodyAtr: ratioText(bodyAtr),
    rangeAtr: ratioText(rangeAtr),
    volumeZ: ratioText(volumeZ),
    note: SHOCK_NOTE,
  };
}
