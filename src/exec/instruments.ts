import type { ExecClient } from "./client";
import type { ExecDb } from "./db";

type RawInstrumentRow = {
  symbol?: string;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: {
    qtyStep?: string;
    minOrderQty?: string;
    maxOrderQty?: string;
    minNotionalValue?: string;
  };
  leverageFilter?: { minLeverage?: string; maxLeverage?: string };
};

export type ExecInstrumentSpec = {
  venue: "bybit";
  category: "linear";
  asOf: string;
  asOfTs: number;
  source: "GET /v5/market/instruments-info?category=linear";
  symbols: Record<
    string,
    {
      tickSize: string | null;
      qtyStep: string | null;
      minOrderQty: string | null;
      maxOrderQty: string | null;
      minNotionalValue: string | null;
      maxLeverage: string | null;
    }
  >;
};

export type SpecRefresh = {
  refreshed: boolean;
  reason: "missing" | "stale" | "fresh";
  spec: ExecInstrumentSpec | null;
};

/** A stale spec means wrong lot rounding or venue rejects — never trade on one (Stage 3 relies on this). */
export function specStale(
  spec: { asOfTs: number } | null,
  now: number,
  maxAgeHours: number,
): boolean {
  if (!spec) return true;
  return now - spec.asOfTs > maxAgeHours * 3_600_000;
}

export function specAgeHours(spec: { asOfTs: number } | null, now: number): number | null {
  if (!spec) return null;
  return (now - spec.asOfTs) / 3_600_000;
}

export function normalizeInstruments(result: unknown, now: number): ExecInstrumentSpec {
  const list = (result as { list?: unknown } | null)?.list;
  const rows = Array.isArray(list) ? (list as RawInstrumentRow[]) : [];
  const symbols: ExecInstrumentSpec["symbols"] = {};
  for (const row of rows) {
    if (!row?.symbol) continue;
    symbols[row.symbol] = {
      tickSize: row.priceFilter?.tickSize ?? null,
      qtyStep: row.lotSizeFilter?.qtyStep ?? null,
      minOrderQty: row.lotSizeFilter?.minOrderQty ?? null,
      maxOrderQty: row.lotSizeFilter?.maxOrderQty ?? null,
      minNotionalValue: row.lotSizeFilter?.minNotionalValue ?? null,
      maxLeverage: row.leverageFilter?.maxLeverage ?? null,
    };
  }
  return {
    venue: "bybit",
    category: "linear",
    asOf: new Date(now).toISOString(),
    asOfTs: now,
    source: "GET /v5/market/instruments-info?category=linear",
    symbols,
  };
}

export async function refreshSpec(
  db: ExecDb,
  client: Pick<ExecClient, "instrumentsInfo">,
  opts: { now?: number; maxAgeHours: number; force?: boolean } = { maxAgeHours: 168 },
): Promise<SpecRefresh> {
  const now = opts.now ?? Date.now();
  const existing = db.loadSpec();
  if (!opts.force && !specStale(existing, now, opts.maxAgeHours)) {
    return { refreshed: false, reason: "fresh", spec: existing?.payload as ExecInstrumentSpec };
  }
  const raw = await client.instrumentsInfo();
  const spec = normalizeInstruments(raw, now);
  db.saveSpec(spec.asOfTs, spec);
  const reason = existing ? "stale" : "missing";
  db.recordEvent("spec.refreshed", { reason, symbols: Object.keys(spec.symbols).length });
  return { refreshed: true, reason, spec };
}
