import { tradingGates } from "../paper/gates";
import type { PaperEngine } from "../paper/engine";
import type { PaperFeedHealth } from "../paper/types";
import {
  familyStatsFromEngine,
  fetchZoneCards,
  lastPricesFromMap,
  mapAcceptEnabled,
  mapSkipSymbol,
  runMapAccept,
  type MapAcceptResult,
} from "../paper/map-accept";
import { parseZoneCard, type CancelCode, type ZoneCard, type ZoneSide } from "../zones/card";
import { LEDGER_CAP_PER_SYMBOL, zoneExpiresTs } from "../zones/ledger";
import { proximityDecision } from "../zones/proximity";
import { familyFloorVeto, familyFromCard, familyKey, type FamilyStats } from "../paper/score";
import { isMidRange, readMapBias, type MapBias, type SymbolBias } from "./bias";
import { quantVeto, readMapQuant, type QuantTape } from "./quant";
import { oscAcceptVeto, type TaOscTape } from "./ta-gate";

/**
 * AGENT_MAP=0: this policy is a no-op. 4H close still uses the old MAP_ACCEPT
 * path (`runMapAccept`) when MAP_ACCEPT is on.
 * MAP_ACCEPT=0: old accept path off (no auto-copy at all).
 * Same env pattern (`!== "0"` means on). Default on.
 */
export function agentMapEnabled(): boolean {
  return process.env.AGENT_MAP !== "0";
}

/** AGENT_BIAS_CHOP=0: 4H chop is not a MAP deny (A/B). Default on. */
export function biasChopEnabled(): boolean {
  return biasChopMode() !== "off";
}

/**
 * How 4H mixed chop is gated at MAP accept.
 * `deny` (default): all chop is `bias_chop`.
 * `off` (`AGENT_BIAS_CHOP=0`): chop is not a veto.
 * `proximal`: chop is allowed only when last is in proximal→entry.
 */
export type BiasChopMode = "deny" | "off" | "proximal";

export function biasChopMode(): BiasChopMode {
  const raw = process.env.AGENT_BIAS_CHOP?.trim().toLowerCase();
  if (raw === "0" || raw === "off") return "off";
  if (raw === "proximal") return "proximal";
  return "deny";
}

const DROP_CODES = ["deep_mitigate", "htf_break", "expired"] as const;

export const POLICY_REASONS = [
  "ok",
  "gates_block",
  "bias_chop",
  "bias_mismatch",
  "stand_aside",
  "deep_mitigate",
  "htf_break",
  "expired",
  "rr_fail",
  "ledger_cap",
  "quant_crowded",
  "quant_oi",
  "quant_cascade",
  "quant_flow",
  "family_floor",
  "map_skip",
  "ta_osc",
  "ta_fib",
  "ta_vol",
  "ta_shock",
  "ta_rev",
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export type PolicyDecision = {
  allow: boolean;
  reason: PolicyReason;
};

export function emptySkipReasons(): Record<PolicyReason, number> {
  const out = {} as Record<PolicyReason, number>;
  for (const reason of POLICY_REASONS) out[reason] = 0;
  return out;
}

export function bumpSkipReason(
  out: Record<PolicyReason, number>,
  reason: PolicyReason | string,
  n = 1,
): void {
  if (reason === "ok" || n <= 0) return;
  for (const allowed of POLICY_REASONS) {
    if (allowed === reason) {
      out[allowed] += n;
      return;
    }
  }
}

export function mergeSkipReasons(
  out: Record<PolicyReason, number>,
  extra: Record<string, number> | undefined,
): void {
  if (!extra) return;
  for (const [reason, n] of Object.entries(extra)) {
    if (typeof n === "number") bumpSkipReason(out, reason, n);
  }
}

function biasForSide(side: ZoneSide): MapBias {
  switch (side) {
    case "demand":
      return "bull";
    case "supply":
      return "bear";
    default: {
      const _exhaustive: never = side;
      return _exhaustive;
    }
  }
}

function dropCodeReason(codes: CancelCode[]): PolicyReason | null {
  for (const code of DROP_CODES) {
    if (!codes.includes(code)) continue;
    switch (code) {
      case "deep_mitigate":
        return "deep_mitigate";
      case "htf_break":
        return "htf_break";
      case "expired":
        return "expired";
      default: {
        const _exhaustive: never = code;
        return _exhaustive;
      }
    }
  }
  return null;
}

function belowMinRr(cardRr: number, minRr: string | null | undefined): boolean {
  if (minRr == null || minRr === "") return false;
  const floor = Number(minRr);
  if (!Number.isFinite(floor)) return false;
  return cardRr < floor;
}

export type MapPolicyInput = {
  card: ZoneCard;
  bias: SymbolBias | undefined;
  last: number | undefined;
  minRr?: string | null;
  acceptedForSymbol?: number;
  tradingAllowed?: boolean;
  now?: number;
  tape?: QuantTape | null;
  family?: FamilyStats | null;
  osc?: TaOscTape | null;
};

/**
 * Whether a `/zones` card may be ledger-accepted after MAP_ACCEPT's pick.
 * Does not arm. Does not close open positions.
 */
export function decideMapAccept(input: MapPolicyInput): PolicyDecision {
  const { card, bias, last } = input;
  if (mapSkipSymbol(card.symbol)) return { allow: false, reason: "map_skip" };
  if (input.tradingAllowed === false) return { allow: false, reason: "gates_block" };
  if (bias && !bias.klineLagOk) return { allow: false, reason: "gates_block" };
  const coded = dropCodeReason(card.cancelCodes);
  if (coded) return { allow: false, reason: coded };
  if (card.freshness === "deep") return { allow: false, reason: "deep_mitigate" };
  const now = input.now ?? Date.now();
  if (now >= zoneExpiresTs(card, card.baseEndTs)) return { allow: false, reason: "expired" };
  if (belowMinRr(card.rr, input.minRr)) return { allow: false, reason: "rr_fail" };
  if (familyFloorVeto(input.family)) return { allow: false, reason: "family_floor" };
  if ((input.acceptedForSymbol ?? 0) >= LEDGER_CAP_PER_SYMBOL) {
    return { allow: false, reason: "ledger_cap" };
  }
  const htf: MapBias = bias?.htf ?? "chop";
  switch (htf) {
    case "chop": {
      const mode = biasChopMode();
      if (mode === "off") break;
      if (mode === "proximal") {
        if (last != null && Number.isFinite(last) && proximityDecision(card, last) === "arm") break;
      }
      return { allow: false, reason: "bias_chop" };
    }
    case "bull":
    case "bear":
      if (htf !== biasForSide(card.side)) return { allow: false, reason: "bias_mismatch" };
      break;
    default: {
      const _exhaustive: never = htf;
      return _exhaustive;
    }
  }
  if (last != null && Number.isFinite(last)) {
    const proximity = proximityDecision(card, last);
    switch (proximity) {
      case "deep":
        return { allow: false, reason: "deep_mitigate" };
      case "invalid":
        return { allow: false, reason: "htf_break" };
      case "wait":
      case "arm":
        if (isMidRange(last, bias?.nearestSwing ?? null) && proximity !== "arm") {
          return { allow: false, reason: "stand_aside" };
        }
        break;
      default: {
        const _exhaustive: never = proximity;
        return _exhaustive;
      }
    }
  }
  const veto = quantVeto(card.side, input.tape);
  if (!veto.allow) return { allow: false, reason: veto.reason };
  const oscVeto = oscAcceptVeto(card.side, input.osc);
  if (oscVeto) return { allow: false, reason: oscVeto };
  return { allow: true, reason: "ok" };
}

export type MapCloseAcceptInfo = {
  interval: string;
  map: unknown;
};

export async function loadFeedHealth(feedUrl = "http://127.0.0.1:43180"): Promise<PaperFeedHealth> {
  const base = feedUrl.replace(/\/$/, "").replace(/\/health$/, "");
  const url = `${base}/health`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, url, klineLagOk: false };
    const body = await res.json() as { ok?: unknown; klineLag?: { ok?: unknown } };
    return {
      ok: body.ok === true,
      url,
      klineLagOk: body.klineLag == null ? true : body.klineLag.ok !== false,
    };
  } catch {
    return { ok: false, url, klineLagOk: false };
  }
}

function mapLagOk(map: unknown): boolean {
  if (!map || typeof map !== "object") return true;
  const row = map as { klineLag?: { ok?: unknown }; maps?: unknown };
  if (row.klineLag && row.klineLag.ok === false) return false;
  if (Array.isArray(row.maps)) {
    return row.maps.every((item) => {
      if (!item || typeof item !== "object") return true;
      const lag = (item as { klineLag?: { ok?: unknown } }).klineLag;
      return lag?.ok !== false;
    });
  }
  return true;
}

/**
 * Composition-root hook: 4H map.close → MAP_ACCEPT pick → policy → acceptZone.
 * AGENT_MAP=0 → policy no-op, old MAP_ACCEPT path.
 * MAP_ACCEPT=0 → no auto-copy.
 * Stale gates → no accept / no new arm. Never closes open positions.
 * Quant veto is `quantVeto` (cascade → crowded → OI → flow). AGENT_QUANT=0 skips it.
 */
export async function onMapCloseAccept(
  info: MapCloseAcceptInfo,
  engine: PaperEngine | null,
  opts: {
    now?: number;
    feedUrl?: string;
    fetchCards?: (feedUrl: string) => Promise<unknown[]>;
    health?: PaperFeedHealth;
    oscBySymbol?: Map<string, TaOscTape>;
  } = {},
): Promise<MapAcceptResult | null> {
  if (info.interval !== "240") return null;
  if (!mapAcceptEnabled() || !engine) return null;

  const feedUrl = opts.feedUrl ?? "http://127.0.0.1:43180";
  const fetchCards = opts.fetchCards ?? fetchZoneCards;
  const lastBySymbol = lastPricesFromMap(info.map);
  const now = opts.now ?? Date.now();

  if (!agentMapEnabled()) {
    const cards = await fetchCards(feedUrl);
    return runMapAccept(engine, cards, lastBySymbol, now);
  }

  const lagOk = mapLagOk(info.map) && (opts.health?.klineLagOk !== false);
  const gates = tradingGates({
    feedOk: opts.health?.ok,
    klineLagOk: lagOk,
  });
  if (!gates.tradingAllowed) {
    return { accepted: [], skipped: 0, skipReasons: emptySkipReasons() };
  }

  const cards = await fetchCards(feedUrl);
  const biases = readMapBias(info.map);
  const tapes = readMapQuant(info.map);
  const minRr = engine.account().minRr;
  const familyByKey = familyStatsFromEngine(engine, now);
  const allow: ZoneCard[] = [];
  let skipped = 0;
  const skipReasons = emptySkipReasons();
  for (const raw of cards) {
    let card: ZoneCard;
    try {
      card = parseZoneCard(raw);
    } catch {
      continue;
    }
    const standing = engine.zones("accepted", now).filter((row) => row.symbol === card.symbol).length;
    const decision = decideMapAccept({
      card,
      bias: biases.get(card.symbol),
      last: lastBySymbol.get(card.symbol),
      minRr,
      acceptedForSymbol: standing + allow.filter((item) => item.symbol === card.symbol).length,
      tradingAllowed: gates.tradingAllowed,
      now,
      tape: tapes.get(card.symbol),
      family: familyByKey.get(familyKey(familyFromCard(card))) ?? null,
      osc: opts.oscBySymbol?.get(card.symbol) ?? null,
    });
    if (!decision.allow) {
      skipped += 1;
      bumpSkipReason(skipReasons, decision.reason);
      continue;
    }
    allow.push(card);
  }
  const result = runMapAccept(engine, allow, lastBySymbol, now, familyByKey);
  mergeSkipReasons(skipReasons, result.skipReasons);
  return { accepted: result.accepted, skipped: skipped + result.skipped, skipReasons };
}
