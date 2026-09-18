import type { QuantTape } from "./quant";
import type { SymbolBias } from "./bias";
import type { FamilyStats } from "../paper/score";
import type { ZoneCard } from "../zones/card";
import type { PolicyDecision } from "./policy";

/**
 * Per-card MAP decision record for the offline learning loop.
 * Opt-in: set MINH_DECISION_LOG=1 to emit one JSON line per card on 4H close
 * (journald captures it; nightly ETL greps `minh:decision` into parquet).
 * Default off. Never blocks accept. Never invents tape.
 */
export type DecisionRecord = {
  v: 1;
  asof: number;
  symbol: string;
  zoneId: string;
  side: string;
  setup: string;
  tf: string;
  rr: number;
  freshness: string;
  impulseAtr: number;
  biasHtf: string;
  bias4h: string;
  bias1h: string;
  last: number | null;
  crowded: string | null;
  oiReading: string | null;
  cascadeActive: boolean | null;
  cascadeSide: string | null;
  flowReading: string | null;
  familyScore: string | null;
  familyTrades: number | null;
  familyAvgRealizedRr: string | null;
  allow: boolean;
  reason: string;
};

export function decisionLogEnabled(): boolean {
  return process.env.MINH_DECISION_LOG?.trim() === "1";
}

export function formatDecision(input: {
  card: ZoneCard;
  bias?: SymbolBias | null;
  last?: number | null;
  tape?: QuantTape | null;
  family?: FamilyStats | null;
  decision: PolicyDecision;
  asof: number;
}): DecisionRecord {
  const { card, bias, last, tape, family, decision, asof } = input;
  return {
    v: 1,
    asof,
    symbol: card.symbol,
    zoneId: card.zoneId,
    side: card.side,
    setup: card.setup ?? "sd",
    tf: card.tf,
    rr: card.rr,
    freshness: card.freshness,
    impulseAtr: card.impulseAtr,
    biasHtf: bias?.htf ?? "chop",
    bias4h: bias?.["240"] ?? "chop",
    bias1h: bias?.["60"] ?? "chop",
    last: last ?? null,
    crowded: tape?.crowded ?? null,
    oiReading: tape?.oiReading ?? null,
    cascadeActive: tape?.cascade ? tape.cascade.active : null,
    cascadeSide: tape?.cascade?.side ?? null,
    flowReading: tape?.flowReading ?? null,
    familyScore: family?.score ?? null,
    familyTrades: family?.trades ?? null,
    familyAvgRealizedRr: family?.avgRealizedRr ?? null,
    allow: decision.allow,
    reason: decision.reason,
  };
}

export function emitDecision(record: DecisionRecord): void {
  if (!decisionLogEnabled()) return;
  console.log(`[minh:decision] ${JSON.stringify(record)}`);
}
