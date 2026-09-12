import { intervalToMs } from "../feed/bb/recovery";
import { buildFeatures, type FeaturesStore, type SnapshotFeatures } from "./snapshot";
import { SHOCK_INTERVAL, type ShockReading } from "./shock";

export const FEATURES_SCAN_NOTE = "as-of shock + tape scan — not a signal";
export const FEATURES_SCAN_DAYS_MAX = 180;

export type ShockPointKind =
  | "impulse"
  | "range_expand"
  | "vol_spike"
  | "cascade"
  | "flow_flip"
  | "oi_flush";

export type ShockPoint = {
  symbol: string;
  asof: number;
  startTs: number | null;
  kinds: ShockPointKind[];
  shock: SnapshotFeatures["shock"];
  tape: SnapshotFeatures["tape"];
  fields: SnapshotFeatures["fields"];
};

export type FeaturesScan = {
  mode: "features";
  scan: true;
  days: number;
  fromTs: number;
  toTs: number;
  symbols: string[];
  points: ShockPoint[];
  counts: Record<ShockPointKind, number>;
  meta: {
    db: string;
    note: typeof FEATURES_SCAN_NOTE;
    signal: false;
    autoArm: false;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyCounts(): Record<ShockPointKind, number> {
  return {
    impulse: 0,
    range_expand: 0,
    vol_spike: 0,
    cascade: 0,
    flow_flip: 0,
    oi_flush: 0,
  };
}

function kindsOf(
  reading: ShockReading,
  tape: SnapshotFeatures["tape"],
  prevFlow: string | null,
): ShockPointKind[] {
  const kinds: ShockPointKind[] = [];
  if (reading === "impulse") kinds.push("impulse");
  if (reading === "range_expand") kinds.push("range_expand");
  if (reading === "vol_spike") kinds.push("vol_spike");
  if (tape.cascade?.active === true) kinds.push("cascade");
  const shocked = reading === "impulse" || reading === "range_expand" || reading === "vol_spike";
  if (shocked && (tape.oiReading === "flush" || tape.oiReading === "cover")) {
    kinds.push("oi_flush");
  }
  if (
    prevFlow != null
    && tape.flowReading != null
    && tape.flowReading !== prevFlow
  ) {
    kinds.push("flow_flip");
  }
  return kinds;
}

function closedStarts(store: FeaturesStore, symbol: string, fromTs: number, toTs: number): number[] {
  const intervalMs = intervalToMs(SHOCK_INTERVAL);
  const startTs = fromTs - intervalMs;
  const endTs = toTs - intervalMs;
  if (endTs < startTs) return [];
  const span = Math.max(0, endTs - startTs);
  const needed = Math.min(Math.ceil(span / intervalMs) + 4, 2_000);
  const rows = store.listKlines({
    symbol,
    interval: SHOCK_INTERVAL,
    confirm: true,
    startTs,
    endTs,
    limit: needed,
    maxLimit: needed,
  }) as Array<{ start_ts?: unknown }>;
  return rows
    .map((row) => Number(row.start_ts))
    .filter((ts) => Number.isFinite(ts) && ts >= startTs && ts <= endTs)
    .sort((a, b) => a - b);
}

/**
 * Walk closed 4H stamps and emit shock/tape inflection points.
 * Missing flow/liq stays missing — no invented CVD. Does not arm.
 */
export function scanFeatures(
  store: FeaturesStore,
  opts: {
    symbols: string[];
    dbPath: string;
    fromTs: number;
    toTs: number;
    days: number;
  },
): FeaturesScan {
  const intervalMs = intervalToMs(SHOCK_INTERVAL);
  const points: ShockPoint[] = [];
  const counts = emptyCounts();
  for (const symbol of opts.symbols) {
    let prevFlow: string | null = null;
    for (const startTs of closedStarts(store, symbol, opts.fromTs, opts.toTs)) {
      const asof = startTs + intervalMs;
      const snap = buildFeatures(store, { symbol, asof, dbPath: opts.dbPath });
      const kinds = kindsOf(snap.shock.reading, snap.tape, prevFlow);
      if (snap.tape.flowReading != null) prevFlow = snap.tape.flowReading;
      if (kinds.length === 0) continue;
      points.push({
        symbol,
        asof,
        startTs: snap.shock.startTs,
        kinds,
        shock: snap.shock,
        tape: snap.tape,
        fields: snap.fields,
      });
      for (const kind of kinds) counts[kind] += 1;
    }
  }
  points.sort((a, b) => a.asof - b.asof || a.symbol.localeCompare(b.symbol));
  return {
    mode: "features",
    scan: true,
    days: opts.days,
    fromTs: opts.fromTs,
    toTs: opts.toTs,
    symbols: opts.symbols,
    points,
    counts,
    meta: {
      db: opts.dbPath,
      note: FEATURES_SCAN_NOTE,
      signal: false,
      autoArm: false,
    },
  };
}

export function scanWindow(days: number, now = Date.now()): { fromTs: number; toTs: number } {
  const toTs = now;
  return { fromTs: toTs - days * DAY_MS, toTs };
}
