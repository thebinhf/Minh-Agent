import { Dec } from "./decimal";
import type { ZoneCard, ZoneSide } from "../zones/card";

/**
 * PAPER_ZONE_SCORE=0: keep detector order at MAP accept (metrics still compute scores).
 * Default on. Missing / cold history is not a veto.
 */
export function paperZoneScoreEnabled(): boolean {
  return process.env.PAPER_ZONE_SCORE !== "0";
}

/** Fill+invalidate+cancel attempts before fillRate counts. */
export const ZONE_SCORE_MIN_ATTEMPTS = 3;
/** Closed trades before winRate counts as a sample. */
export const ZONE_SCORE_MIN_TRADES = 2;

const FILL_WEIGHT = Dec.from("0.6");
const WIN_WEIGHT = Dec.from("0.4");

const TF_FROM_SLUG: Record<string, string> = {
  "4h": "240",
  "1h": "60",
  "15m": "15",
  "5m": "5",
  d: "D",
};

const FAMILY_ID = /^([a-z0-9]+)-(4h|1h|15m|5m|d)-(s|d)-(\d{8})-(\d{2})$/i;

export type ZoneFamily = {
  symbol: string;
  tf: string;
  side: ZoneSide;
};

export type ZoneScoreInput = {
  trades: number;
  wins: number;
  filled: number;
  invalidated: number;
  cancelled: number;
};

export function familyKey(family: ZoneFamily): string {
  return `${family.symbol}:${family.tf}:${family.side}`;
}

export function familyFromCard(card: Pick<ZoneCard, "symbol" | "tf" | "side">): ZoneFamily {
  return { symbol: card.symbol, tf: card.tf, side: card.side };
}

function sideFromSlug(slug: string): ZoneSide | null {
  switch (slug) {
    case "s":
      return "supply";
    case "d":
      return "demand";
    default:
      return null;
  }
}

/**
 * Detector ids (`btc-4h-s-20260908-01`). Operator stamps like `htf-demand-1`
 * return null — do not invent a family.
 */
export function parseFamilyFromZoneId(zoneId: string | null | undefined): ZoneFamily | null {
  if (!zoneId) return null;
  const match = FAMILY_ID.exec(zoneId.trim());
  if (!match) return null;
  const slug = match[1]!.toLowerCase();
  const tf = TF_FROM_SLUG[match[2]!.toLowerCase()];
  const side = sideFromSlug(match[3]!.toLowerCase());
  if (!tf || !side) return null;
  return {
    symbol: `${slug.toUpperCase()}USDT`,
    tf,
    side,
  };
}

export function resolveZoneFamily(
  zoneId: string | null | undefined,
  ledger: Map<string, ZoneFamily>,
): ZoneFamily | null {
  if (!zoneId) return null;
  return ledger.get(zoneId) ?? parseFamilyFromZoneId(zoneId);
}

function rate(numer: number, denom: number): Dec | null {
  if (denom <= 0) return null;
  return Dec.from(String(numer)).div(Dec.from(String(denom)));
}

/**
 * Empirical 0–1 TEXT from paper fills + closed trades.
 * `0.6 * fillRate + 0.4 * winRate` when both exist.
 * Cold start (attempts < 3 and trades < 2) → null. Not a signal. Not a veto.
 */
export function zoneScore(input: ZoneScoreInput): string | null {
  const attempts = input.filled + input.invalidated + input.cancelled;
  const cold = attempts < ZONE_SCORE_MIN_ATTEMPTS && input.trades < ZONE_SCORE_MIN_TRADES;
  if (cold) return null;
  const fillRate = rate(input.filled, attempts);
  const winRate = rate(input.wins, input.trades);
  if (fillRate && winRate) {
    return FILL_WEIGHT.mul(fillRate).add(WIN_WEIGHT.mul(winRate)).toText();
  }
  if (fillRate) return fillRate.toText();
  if (winRate) return winRate.toText();
  return null;
}

export function compareZoneCards(
  a: ZoneCard,
  b: ZoneCard,
  scoreOf: (card: ZoneCard) => string | null,
): number {
  const sa = scoreOf(a);
  const sb = scoreOf(b);
  if (sa != null && sb != null) {
    const cmp = Dec.from(sb).cmp(Dec.from(sa));
    if (cmp !== 0) return cmp;
  } else if (sa != null) {
    return -1;
  } else if (sb != null) {
    return 1;
  }
  if (a.rr !== b.rr) return b.rr - a.rr;
  return a.zoneId.localeCompare(b.zoneId);
}

/**
 * Rank by family score (high first). All-null / kill-switch keeps input order.
 * Tie-break: higher card RR, then zoneId.
 */
export function rankZoneCards(
  cards: ZoneCard[],
  scoreOf: (card: ZoneCard) => string | null,
): ZoneCard[] {
  if (!paperZoneScoreEnabled()) return cards;
  if (!cards.some((card) => scoreOf(card) != null)) return cards;
  return [...cards].sort((a, b) => compareZoneCards(a, b, scoreOf));
}
