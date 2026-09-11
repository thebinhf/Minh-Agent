import type { QuantTape } from "../agent/quant";
import type { TrackerDb } from "../feed/bb/db";
import { FLOW_BAR_MS, MAP_FLOW_WINDOWS, summarizeFlow } from "../feed/bb/flow";
import { MAP_FUNDING_LIMIT, readFundingBars, summarizeFunding } from "../feed/bb/funding";
import { buildMapLiq } from "../feed/bb/liq";
import { MAP_OI_LIMITS, readOiBars, summarizeOi, type OiInterval } from "../feed/bb/oi";
import { intervalToMs } from "../feed/bb/recovery";

export type FeatureQuality = "ok" | "missing";

export type AsOfStore = Pick<TrackerDb, "listOi" | "listFunding" | "sumFlowWindow" | "listLiquidations">;

export type AsOfTape = {
  tape: QuantTape;
  quality: "asof" | "missing";
  fields: {
    oi: FeatureQuality;
    funding: FeatureQuality;
    flow: FeatureQuality;
    cascade: FeatureQuality;
  };
};

export const QUANT_FIELDS = ["oi", "funding", "flow", "cascade"] as const;
export type QuantField = (typeof QUANT_FIELDS)[number];

export type QuantCoverageCount = { ok: number; missing: number };

export type QuantCoverage = {
  samples: number;
  oi: QuantCoverageCount;
  funding: QuantCoverageCount;
  flow: QuantCoverageCount;
  cascade: QuantCoverageCount;
};

export function emptyQuantCoverage(): QuantCoverage {
  return {
    samples: 0,
    oi: { ok: 0, missing: 0 },
    funding: { ok: 0, missing: 0 },
    flow: { ok: 0, missing: 0 },
    cascade: { ok: 0, missing: 0 },
  };
}

export function bumpQuantCoverage(out: QuantCoverage, fields: AsOfTape["fields"]): void {
  out.samples += 1;
  for (const key of QUANT_FIELDS) {
    if (fields[key] === "ok") out[key].ok += 1;
    else out[key].missing += 1;
  }
}

export function mergeQuantCoverage(out: QuantCoverage, extra: QuantCoverage): void {
  out.samples += extra.samples;
  for (const key of QUANT_FIELDS) {
    out[key].ok += extra[key].ok;
    out[key].missing += extra[key].missing;
  }
}

function closedStartCap(asof: number, interval: OiInterval): number {
  return asof - intervalToMs(interval);
}

function emptyTape(): QuantTape {
  return {
    crowded: null,
    oiReading: null,
    cascade: null,
    flowReading: null,
  };
}

/**
 * Quant tape as of `asof` (inclusive). Closed HTF bars only.
 * Missing rows stay null — not 0, not a veto.
 */
export function asOfTape(
  store: AsOfStore,
  opts: {
    symbol: string;
    asof: number;
    lastPrice?: number | null;
    closes?: Array<string | null | undefined>;
  },
): AsOfTape {
  const symbol = opts.symbol.trim().toUpperCase();
  const asof = opts.asof;
  const tape = emptyTape();
  const fields: AsOfTape["fields"] = {
    oi: "missing",
    funding: "missing",
    flow: "missing",
    cascade: "missing",
  };

  const h4 = readOiBars(store, symbol, "240", MAP_OI_LIMITS["240"], closedStartCap(asof, "240"));
  const h1 = readOiBars(store, symbol, "60", MAP_OI_LIMITS["60"], closedStartCap(asof, "60"));
  const primary = h4.length >= 2 ? h4 : h1;
  const oi = summarizeOi(primary, { closes: opts.closes ?? [] });
  tape.oiReading = oi.reading;
  if (oi.reading) fields.oi = "ok";

  const fundingBars = readFundingBars(store, symbol, MAP_FUNDING_LIMIT, asof);
  const funding = summarizeFunding(fundingBars);
  tape.crowded = funding.crowded;
  if (funding.crowded || funding.latest) fields.funding = "ok";

  const flowTo = asof - FLOW_BAR_MS;
  if (flowTo > 0) {
    const row = store.sumFlowWindow(symbol, flowTo - MAP_FLOW_WINDOWS["240"], flowTo);
    const window = summarizeFlow(row.buyNotional, row.sellNotional);
    tape.flowReading = window.reading;
    if (window.reading || window.delta != null) fields.flow = "ok";
  }

  const last = opts.lastPrice != null && Number.isFinite(opts.lastPrice)
    ? String(opts.lastPrice)
    : null;
  const liq = buildMapLiq(store, symbol, last, asof, tape.oiReading);
  if (liq.count > 0) {
    tape.cascade = {
      active: liq.cascade.active,
      side: liq.cascade.side,
      fuel: liq.cascade.fuel,
    };
    fields.cascade = "ok";
  }

  const quality = Object.values(fields).some((item) => item === "ok") ? "asof" : "missing";
  return { tape, quality, fields };
}
