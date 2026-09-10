import type { PaperEngine } from "../paper/engine";
import {
  fetchZoneCards,
  lastPricesFromMap,
  mapAcceptEnabled,
  pickAcceptable,
  runMapAccept,
  type MapAcceptResult,
} from "../paper/map-accept";
import type { ZoneCard, ZoneSide } from "../zones/card";
import { ZONE_DETECT } from "../zones/detect";
import { proximityDecision } from "../zones/proximity";
import { readMapBias, type MapBias, type SymbolBias } from "./bias";

/**
 * AGENT_MAP=0: do not run agent policy and do not agent-accept.
 * Same env pattern as MAP_ACCEPT=0 (`!== "0"` means on). Default on.
 * Does **not** fall back to ungated P5 `runMapAccept`. Manual `paper zone accept` still works.
 */
export function agentMapEnabled(): boolean {
  return process.env.AGENT_MAP !== "0";
}

export const POLICY_REASONS = [
  "ok",
  "agent_map_off",
  "kline_lag",
  "bias_aside",
  "bias_mismatch",
  "proximity_deep",
  "proximity_invalid",
  "playbook_rr",
  "playbook_freshness",
  "playbook_tf",
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

function asideOrMismatch(htf: MapBias, side: ZoneSide): PolicyReason | null {
  switch (htf) {
    case "aside":
      return "bias_aside";
    case "bull":
    case "bear":
      return htf === biasForSide(side) ? null : "bias_mismatch";
    default: {
      const _exhaustive: never = htf;
      return _exhaustive;
    }
  }
}

export type MapPolicyInput = {
  card: ZoneCard;
  bias: SymbolBias | undefined;
  last: number | undefined;
};

/**
 * Whether a `/zones` card may be ledger-accepted after MAP_ACCEPT's pick.
 * Does not arm. Deep/invalid reuse `proximityDecision` (away/`wait` is OK).
 */
export function decideMapAccept(input: MapPolicyInput): PolicyDecision {
  if (!agentMapEnabled()) return { allow: false, reason: "agent_map_off" };
  const { card, bias, last } = input;
  if (card.tf !== "240") return { allow: false, reason: "playbook_tf" };
  if (card.freshness === "deep") return { allow: false, reason: "playbook_freshness" };
  if (!(card.rr >= ZONE_DETECT.minRr)) return { allow: false, reason: "playbook_rr" };
  if (bias && !bias.klineLagOk) return { allow: false, reason: "kline_lag" };
  const htf: MapBias = bias?.htf ?? "aside";
  const biasFail = asideOrMismatch(htf, card.side);
  if (biasFail) return { allow: false, reason: biasFail };
  if (last != null && Number.isFinite(last)) {
    const proximity = proximityDecision(card, last);
    switch (proximity) {
      case "deep":
        return { allow: false, reason: "proximity_deep" };
      case "invalid":
        return { allow: false, reason: "proximity_invalid" };
      case "wait":
      case "arm":
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

/**
 * Composition-root hook: 4H map.close → MAP_ACCEPT pick → policy → acceptZone.
 * 1H closes dump MAP only. Never arms. Never hits Bybit private API.
 */
export async function onMapCloseAccept(
  info: MapCloseAcceptInfo,
  engine: PaperEngine | null,
  opts: {
    now?: number;
    feedUrl?: string;
    fetchCards?: (feedUrl: string) => Promise<unknown[]>;
  } = {},
): Promise<MapAcceptResult | null> {
  if (info.interval !== "240") return null;
  if (!mapAcceptEnabled() || !engine) return null;
  if (!agentMapEnabled()) return { accepted: [], skipped: 0 };

  const feedUrl = opts.feedUrl ?? "http://127.0.0.1:43180";
  const fetchCards = opts.fetchCards ?? fetchZoneCards;
  const cards = await fetchCards(feedUrl);
  const lastBySymbol = lastPricesFromMap(info.map);
  const biases = readMapBias(info.map);
  const picked = pickAcceptable(cards, lastBySymbol);
  const allow: ZoneCard[] = [];
  let skipped = 0;
  for (const card of picked) {
    const decision = decideMapAccept({
      card,
      bias: biases.get(card.symbol),
      last: lastBySymbol.get(card.symbol),
    });
    if (!decision.allow) {
      skipped += 1;
      continue;
    }
    allow.push(card);
  }
  const result = runMapAccept(engine, allow, lastBySymbol, opts.now);
  return { accepted: result.accepted, skipped: skipped + result.skipped };
}
