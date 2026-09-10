import type { ZoneSide } from "../zones/card";

/**
 * AGENT_QUANT=0: skip this veto (structure policy still runs).
 * Default on. Missing tape is not a veto — do not invent crowded/OI/cascade.
 */
export function agentQuantEnabled(): boolean {
  return process.env.AGENT_QUANT !== "0";
}

export const QUANT_REASONS = ["ok", "quant_crowded", "quant_oi", "quant_cascade"] as const;
export type QuantReason = (typeof QUANT_REASONS)[number];

export type QuantCascade = {
  active: boolean;
  side: "long" | "short" | null;
  fuel: string;
};

export type QuantTape = {
  crowded: "long" | "short" | null;
  oiReading: "long_add" | "short_add" | "cover" | "flush" | null;
  cascade: QuantCascade | null;
};

export type QuantDecision = {
  allow: boolean;
  reason: QuantReason;
};

export type QuantGate = "accept" | "arm";

const OI_READINGS = new Set(["long_add", "short_add", "cover", "flush"]);

function asCrowded(value: unknown): QuantTape["crowded"] {
  return value === "long" || value === "short" ? value : null;
}

function asOi(value: unknown): QuantTape["oiReading"] {
  return typeof value === "string" && OI_READINGS.has(value)
    ? value as QuantTape["oiReading"]
    : null;
}

function asCascade(value: unknown): QuantCascade | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { active?: unknown; side?: unknown; fuel?: unknown };
  const side = row.side === "long" || row.side === "short" ? row.side : null;
  return {
    active: row.active === true,
    side,
    fuel: row.fuel == null ? "0" : String(row.fuel),
  };
}

export function tapeFromMapItem(item: unknown): QuantTape | null {
  if (!item || typeof item !== "object") return null;
  const row = item as {
    funding?: { crowded?: unknown };
    oi?: { reading?: unknown };
    liq?: { cascade?: unknown };
  };
  return {
    crowded: asCrowded(row.funding?.crowded),
    oiReading: asOi(row.oi?.reading),
    cascade: asCascade(row.liq?.cascade),
  };
}

/** Walk `/map` batch or a single map row. Same shape `readMapBias` already uses. */
export function readMapQuant(map: unknown): Map<string, QuantTape> {
  const out = new Map<string, QuantTape>();
  if (!map || typeof map !== "object") return out;
  const root = map as { maps?: unknown; symbol?: unknown };
  const items = Array.isArray(root.maps) ? root.maps : [map];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const symbol = String((item as { symbol?: unknown }).symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const tape = tapeFromMapItem(item);
    if (tape) out.set(symbol, tape);
  }
  return out;
}

/**
 * One flow. Cascade and crowded at both gates.
 * Opposing OI add (`short_add` vs demand / `long_add` vs supply) is MAP-accept
 * only — at ARM, last is already in the zone and that add is the fill, not a knife.
 * cover/flush confirm cascade; they are not a second veto.
 */
export function quantVeto(
  side: ZoneSide,
  tape: QuantTape | null | undefined,
  gate: QuantGate = "accept",
): QuantDecision {
  if (!agentQuantEnabled()) return { allow: true, reason: "ok" };
  if (!tape) return { allow: true, reason: "ok" };

  const long = side === "demand";
  const cascade = tape.cascade;
  if (cascade?.active && cascade.side === (long ? "long" : "short")) {
    return { allow: false, reason: "quant_cascade" };
  }
  if (tape.crowded === (long ? "long" : "short")) {
    return { allow: false, reason: "quant_crowded" };
  }
  if (gate === "accept" && tape.oiReading === (long ? "short_add" : "long_add")) {
    return { allow: false, reason: "quant_oi" };
  }
  return { allow: true, reason: "ok" };
}
