/** Zone-card v1 — suggest-only. Paper attaches `zoneId` by hand; nothing auto-arms. */

export const ZONE_FRESHNESS = ["virgin", "touched", "deep"] as const;
export type ZoneFreshness = (typeof ZONE_FRESHNESS)[number];

export const CANCEL_CODES = [
  "never_touched",
  "ops_cancel",
  "deep_mitigate",
  "htf_break",
  "expired",
  "rr_fail",
  "gates_block",
] as const;
export type CancelCode = (typeof CANCEL_CODES)[number];

export const ZONE_SIDES = ["supply", "demand"] as const;
export type ZoneSide = (typeof ZONE_SIDES)[number];

/** Setup family that emitted the card. Missing JSON → `sd` (legacy S/D). */
export const ZONE_SETUPS = ["sd", "breakout", "reversal"] as const;
export type ZoneSetup = (typeof ZONE_SETUPS)[number];

export const ZONE_SETUP_SLUG: Record<ZoneSetup, string> = {
  sd: "sd",
  breakout: "bo",
  reversal: "rv",
};

export const ZONE_SETUP_FROM_SLUG: Record<string, ZoneSetup> = {
  sd: "sd",
  bo: "breakout",
  rv: "reversal",
};

export const ZONE_CARD_KEYS = [
  "zoneId",
  "symbol",
  "tf",
  "side",
  "setup",
  "baseStartTs",
  "baseEndTs",
  "zoneLow",
  "zoneHigh",
  "distal",
  "proximal",
  "impulseBody",
  "atr14",
  "impulseAtr",
  "departureAtr",
  "freshness",
  "penetrationPct",
  "entry",
  "sl",
  "tp",
  "rr",
  "hardInvalid",
  "softInvalid",
  "expiryBars",
  "cancelCodes",
] as const;

export type ZoneCard = {
  zoneId: string;
  symbol: string;
  tf: string;
  side: ZoneSide;
  setup: ZoneSetup;
  baseStartTs: number;
  baseEndTs: number;
  zoneLow: number;
  zoneHigh: number;
  distal: number;
  proximal: number;
  impulseBody: number;
  atr14: number;
  impulseAtr: number;
  departureAtr: number;
  freshness: ZoneFreshness;
  penetrationPct: number;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  hardInvalid: number;
  softInvalid: number;
  expiryBars: number;
  cancelCodes: CancelCode[];
};

export class ZoneCardError extends Error {
  readonly field: string;
  readonly value: unknown;

  constructor(field: string, value: unknown, message?: string) {
    super(message ?? `invalid zone-card ${field}`);
    this.name = "ZoneCardError";
    this.field = field;
    this.value = value;
  }
}

export function emptyCancelCodeCounts(): Record<CancelCode, number> {
  return {
    never_touched: 0,
    ops_cancel: 0,
    deep_mitigate: 0,
    htf_break: 0,
    expired: 0,
    rr_fail: 0,
    gates_block: 0,
  };
}

export function isZoneFreshness(raw: unknown): raw is ZoneFreshness {
  return raw === "virgin" || raw === "touched" || raw === "deep";
}

export function parseZoneFreshness(raw: unknown): ZoneFreshness {
  if (isZoneFreshness(raw)) return raw;
  throw new ZoneCardError("freshness", raw);
}

export function isCancelCode(raw: unknown): raw is CancelCode {
  return (
    raw === "never_touched"
    || raw === "ops_cancel"
    || raw === "deep_mitigate"
    || raw === "htf_break"
    || raw === "expired"
    || raw === "rr_fail"
    || raw === "gates_block"
  );
}

export function parseCancelCode(raw: unknown): CancelCode {
  if (isCancelCode(raw)) return raw;
  throw new ZoneCardError("cancelCodes", raw);
}

export function parseCancelCodes(raw: unknown): CancelCode[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ZoneCardError("cancelCodes", raw);
  const out: CancelCode[] = [];
  const seen = new Set<CancelCode>();
  for (const item of raw) {
    const code = parseCancelCode(item);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function bumpCancelCode(counts: Record<CancelCode, number>, code: CancelCode): void {
  switch (code) {
    case "never_touched":
    case "ops_cancel":
    case "deep_mitigate":
    case "htf_break":
    case "expired":
    case "rr_fail":
    case "gates_block":
      counts[code] += 1;
      return;
    default: {
      const _exhaustive: never = code;
      throw new ZoneCardError("cancelCodes", _exhaustive);
    }
  }
}

export function classifyCancelCode(raw: unknown): CancelCode | null {
  if (isCancelCode(raw)) return raw;
  return null;
}

function parseFiniteNumber(field: string, raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) throw new ZoneCardError(field, raw);
  return n;
}

function parsePositiveInt(field: string, raw: unknown): number {
  const n = parseFiniteNumber(field, raw);
  if (!Number.isInteger(n) || n <= 0) throw new ZoneCardError(field, raw);
  return n;
}

function parseNonNegNumber(field: string, raw: unknown): number {
  const n = parseFiniteNumber(field, raw);
  if (n < 0) throw new ZoneCardError(field, raw);
  return n;
}

function parseTs(field: string, raw: unknown): number {
  const n = parseFiniteNumber(field, raw);
  if (!Number.isInteger(n) || n < 0) throw new ZoneCardError(field, raw);
  return n;
}

function parseText(field: string, raw: unknown): string {
  if (typeof raw !== "string") throw new ZoneCardError(field, raw);
  const text = raw.trim();
  if (!text) throw new ZoneCardError(field, raw);
  return text;
}

export function parseZoneSide(raw: unknown): ZoneSide {
  if (raw === "supply" || raw === "demand") return raw;
  throw new ZoneCardError("side", raw);
}

export function parseZoneSetup(raw: unknown): ZoneSetup {
  if (raw == null || raw === "") return "sd";
  if (raw === "sd" || raw === "breakout" || raw === "reversal") return raw;
  throw new ZoneCardError("setup", raw);
}

function assertSideGeometry(card: ZoneCard): void {
  if (card.zoneLow > card.zoneHigh) {
    throw new ZoneCardError("zoneLow", card.zoneLow, "zoneLow must be <= zoneHigh");
  }
  switch (card.side) {
    case "supply":
      if (card.distal !== card.zoneHigh || card.proximal !== card.zoneLow) {
        throw new ZoneCardError("distal", card.distal, "supply distal is zoneHigh, proximal is zoneLow");
      }
      if (!(card.sl >= card.distal)) throw new ZoneCardError("sl", card.sl);
      if (!(card.tp < card.entry)) throw new ZoneCardError("tp", card.tp);
      break;
    case "demand":
      if (card.distal !== card.zoneLow || card.proximal !== card.zoneHigh) {
        throw new ZoneCardError("distal", card.distal, "demand distal is zoneLow, proximal is zoneHigh");
      }
      if (!(card.sl <= card.distal)) throw new ZoneCardError("sl", card.sl);
      if (!(card.tp > card.entry)) throw new ZoneCardError("tp", card.tp);
      break;
    default: {
      const _exhaustive: never = card.side;
      throw new ZoneCardError("side", _exhaustive);
    }
  }
  if (card.entry < card.zoneLow || card.entry > card.zoneHigh) {
    throw new ZoneCardError("entry", card.entry, "entry must sit inside the zone");
  }
}

export function parseZoneCard(raw: unknown): ZoneCard {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ZoneCardError("card", raw);
  }
  const row = raw as Record<string, unknown>;
  const card: ZoneCard = {
    zoneId: parseText("zoneId", row.zoneId),
    symbol: parseText("symbol", row.symbol).toUpperCase(),
    tf: parseText("tf", row.tf),
    side: parseZoneSide(row.side),
    setup: parseZoneSetup(row.setup),
    baseStartTs: parseTs("baseStartTs", row.baseStartTs),
    baseEndTs: parseTs("baseEndTs", row.baseEndTs),
    zoneLow: parseFiniteNumber("zoneLow", row.zoneLow),
    zoneHigh: parseFiniteNumber("zoneHigh", row.zoneHigh),
    distal: parseFiniteNumber("distal", row.distal),
    proximal: parseFiniteNumber("proximal", row.proximal),
    impulseBody: parseNonNegNumber("impulseBody", row.impulseBody),
    atr14: parseNonNegNumber("atr14", row.atr14),
    impulseAtr: parseNonNegNumber("impulseAtr", row.impulseAtr),
    departureAtr: parseNonNegNumber("departureAtr", row.departureAtr),
    freshness: parseZoneFreshness(row.freshness),
    penetrationPct: parseNonNegNumber("penetrationPct", row.penetrationPct),
    entry: parseFiniteNumber("entry", row.entry),
    sl: parseFiniteNumber("sl", row.sl),
    tp: parseFiniteNumber("tp", row.tp),
    rr: parseNonNegNumber("rr", row.rr),
    hardInvalid: parseFiniteNumber("hardInvalid", row.hardInvalid),
    softInvalid: parseFiniteNumber("softInvalid", row.softInvalid),
    expiryBars: parsePositiveInt("expiryBars", row.expiryBars),
    cancelCodes: parseCancelCodes(row.cancelCodes),
  };
  if (card.baseEndTs < card.baseStartTs) {
    throw new ZoneCardError("baseEndTs", card.baseEndTs);
  }
  if (card.hardInvalid !== card.sl) {
    throw new ZoneCardError("hardInvalid", card.hardInvalid, "hardInvalid must equal sl");
  }
  if (card.softInvalid !== card.distal) {
    throw new ZoneCardError("softInvalid", card.softInvalid, "softInvalid must equal distal");
  }
  assertSideGeometry(card);
  return card;
}

export function zoneCardKeys(card: ZoneCard): string[] {
  return Object.keys(card);
}
