import { normalizeBriefSymbol } from "../feed/bb/brief";
import type { TrackerDb } from "../feed/bb/db";
import { intervalToMs, parseTimeArg } from "../feed/bb/recovery";
import { asOfShock, type AsOfShock } from "./shock";
import { asOfTape, type AsOfStore, type AsOfTape } from "./tape";

export const FEATURES_NOTE = "quant veto — not a signal";

export type FeaturesStore = AsOfStore & Pick<TrackerDb, "listKlines">;

export type SnapshotFeatures = {
  symbol: string;
  asof: number;
  quality: AsOfTape["quality"];
  fields: AsOfTape["fields"];
  tape: AsOfTape["tape"];
  shock: AsOfShock;
  meta: {
    db: string;
    note: typeof FEATURES_NOTE;
  };
};

export function parseFeaturesAsof(
  raw: string | null | undefined,
  now = Date.now(),
): number | { error: "features_asof" } {
  if (raw == null || raw.trim() === "") return now;
  try {
    const n = parseTimeArg(raw);
    if (!Number.isFinite(n) || n <= 0) return { error: "features_asof" };
    return n;
  } catch {
    return { error: "features_asof" };
  }
}

function closedCloses(store: FeaturesStore, symbol: string, asof: number): string[] {
  const endTs = asof - intervalToMs("240");
  const rows = store.listKlines({
    symbol,
    interval: "240",
    confirm: true,
    endTs,
    limit: 20,
    maxLimit: 20,
  }) as Array<{ close?: unknown; start_ts?: unknown }>;
  const bars = rows
    .map((row) => ({
      startTs: Number(row.start_ts),
      close: row.close == null ? "" : String(row.close),
    }))
    .filter((row) => Number.isFinite(row.startTs) && row.close !== "")
    .sort((a, b) => a.startTs - b.startTs);
  return bars.map((row) => row.close);
}

/**
 * Read-only as-of tape + 4H kline shock. Does not arm. Missing stays null.
 */
export function buildFeatures(
  store: FeaturesStore,
  opts: { symbol?: string | null; asof: number; dbPath: string },
): SnapshotFeatures {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const closes = closedCloses(store, symbol, opts.asof);
  const lastClose = closes.length ? Number(closes[closes.length - 1]) : null;
  const row = asOfTape(store, {
    symbol,
    asof: opts.asof,
    lastPrice: lastClose != null && Number.isFinite(lastClose) ? lastClose : null,
    closes,
  });
  return {
    symbol,
    asof: opts.asof,
    quality: row.quality,
    fields: row.fields,
    tape: row.tape,
    shock: asOfShock(store, { symbol, asof: opts.asof }),
    meta: { db: opts.dbPath, note: FEATURES_NOTE },
  };
}
