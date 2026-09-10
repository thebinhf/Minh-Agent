import { tradingGates } from "../paper/gates";
import type { PaperEngine } from "../paper/engine";
import type { PaperFeedHealth } from "../paper/types";
import {
  fetchZoneCards,
  lastPricesFromMap,
  mapAcceptEnabled,
  pickAcceptable,
  runMapAccept,
  type MapAcceptResult,
} from "../paper/map-accept";
import type { CancelCode, ZoneCard, ZoneSide } from "../zones/card";
import { LEDGER_CAP_PER_SYMBOL, zoneExpiresTs } from "../zones/ledger";
import { proximityDecision } from "../zones/proximity";
import { isMidRange, readMapBias, type MapBias, type SymbolBias } from "./bias";

/**
 * AGENT_MAP=0: this policy is a no-op. 4H close still uses the old MAP_ACCEPT
 * path (`runMapAccept`) when MAP_ACCEPT is on.
 * MAP_ACCEPT=0: old accept path off (no auto-copy at all).
 * Same env pattern (`!== "0"` means on). Default on.
 */
export function agentMapEnabled(): boolean {
  return process.env.AGENT_MAP !== "0";
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
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export type PolicyDecision = {
  allow: boolean;
  reason: PolicyReason;
};

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
};

/**
 * Whether a `/zones` card may be ledger-accepted after MAP_ACCEPT's pick.
 * Does not arm. Does not close open positions.
 */
export function decideMapAccept(input: MapPolicyInput): PolicyDecision {
  const { card, bias, last } = input;
  if (input.tradingAllowed === false) return { allow: false, reason: "gates_block" };
  if (bias && !bias.klineLagOk) return { allow: false, reason: "gates_block" };
  const coded = dropCodeReason(card.cancelCodes);
  if (coded) return { allow: false, reason: coded };
  if (card.freshness === "deep") return { allow: false, reason: "deep_mitigate" };
  const now = input.now ?? Date.now();
  if (now >= zoneExpiresTs(card, card.baseEndTs)) return { allow: false, reason: "expired" };
  if (belowMinRr(card.rr, input.minRr)) return { allow: false, reason: "rr_fail" };
  if ((input.acceptedForSymbol ?? 0) >= LEDGER_CAP_PER_SYMBOL) {
    return { allow: false, reason: "ledger_cap" };
  }
  const htf: MapBias = bias?.htf ?? "chop";
  switch (htf) {
    case "chop":
      return { allow: false, reason: "bias_chop" };
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
 */
export async function onMapCloseAccept(
  info: MapCloseAcceptInfo,
  engine: PaperEngine | null,
  opts: {
    now?: number;
    feedUrl?: string;
    fetchCards?: (feedUrl: string) => Promise<unknown[]>;
    health?: PaperFeedHealth;
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
    return { accepted: [], skipped: 0 };
  }

  const cards = await fetchCards(feedUrl);
  const biases = readMapBias(info.map);
  const minRr = engine.account().minRr;
  const picked = pickAcceptable(cards, lastBySymbol);
  const allow: ZoneCard[] = [];
  let skipped = 0;
  for (const card of picked) {
    const standing = engine.zones("accepted", now).filter((row) => row.symbol === card.symbol).length;
    const decision = decideMapAccept({
      card,
      bias: biases.get(card.symbol),
      last: lastBySymbol.get(card.symbol),
      minRr,
      acceptedForSymbol: standing + allow.filter((item) => item.symbol === card.symbol).length,
      tradingAllowed: gates.tradingAllowed,
      now,
    });
    if (!decision.allow) {
      skipped += 1;
      continue;
    }
    allow.push(card);
  }
  const result = runMapAccept(engine, allow, lastBySymbol, now);
  return { accepted: result.accepted, skipped: skipped + result.skipped };
}
