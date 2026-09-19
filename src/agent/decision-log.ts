import { dirname, resolve } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import type { QuantTape } from "./quant";
import type { SymbolBias } from "./bias";
import type { FamilyStats } from "../paper/score";
import type { ZoneCard } from "../zones/card";
import type { PolicyDecision } from "./policy";

/**
 * Per-card MAP decision record for the offline learning loop.
 * Opt-in: `MINH_DECISION_LOG=1` prints one JSON line per card on 4H close,
 * `MINH_DECISION_FILE=<path>` appends the same line as JSONL so the record
 * survives a process with no journald — replay writes here too, which is how a
 * corpus gets deep enough to measure anything. Never blocks accept. Never
 * invents tape.
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

/**
 * Where decisions are durable. `0` / blank = off. This host has no journald, so
 * without a file the record exists only as a line on stdout and is lost — and a
 * research corpus cannot be built from what is lost.
 */
export function decisionLogFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MINH_DECISION_FILE?.trim();
  if (!raw || raw === "0") return null;
  return raw;
}

export function emitDecision(record: DecisionRecord): void {
  const line = JSON.stringify(record);
  if (decisionLogEnabled()) console.log(`[minh:decision] ${line}`);
  const path = decisionLogFile();
  if (!path) return;
  // Never let a logging mistake change a trading decision.
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    appendFileSync(path, `${line}\n`);
  } catch (error) {
    console.error(`[minh:decision] write ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

/** One JSONL line from either sink format (`[minh:decision] {json}` or bare json). */
export function parseDecisionLine(line: string): DecisionRecord | null {
  const text = line.trim();
  if (!text) return null;
  const json = text.slice(text.indexOf("{"));
  if (!json.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.zoneId !== "string" || typeof row.asof !== "number") return null;
  return row as unknown as DecisionRecord;
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
