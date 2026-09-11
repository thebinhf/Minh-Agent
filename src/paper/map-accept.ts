import { PaperReject } from "./errors";
import type { PaperEngine } from "./engine";
import type { ZoneCard } from "../zones/card";
import { parseZoneCard } from "../zones/card";
import { proximityDecision } from "../zones/proximity";
import {
  familyFloorVeto,
  familyFromCard,
  familyKey,
  paperZoneScoreEnabled,
  rankZoneCards,
  type FamilyStats,
} from "./score";

/** 4H close only. 1H dumps MAP but does not auto-accept. */
export function mapAcceptEnabled(): boolean {
  return process.env.MAP_ACCEPT !== "0";
}

const DEFAULT_MAP_SKIP = ["HYPEUSDT"];

/**
 * Symbols the feed still caches but MAP will not auto-accept.
 * Default HYPEUSDT (180d: accept without ARM). PAPER_MAP_SKIP=0 or blank = none.
 */
export function mapSkipSymbols(): string[] {
  const raw = process.env.PAPER_MAP_SKIP;
  if (raw === undefined) return [...DEFAULT_MAP_SKIP];
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "0") return [];
  return trimmed.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
}

export function mapSkipSymbol(symbol: string): boolean {
  return mapSkipSymbols().includes(symbol.trim().toUpperCase());
}

export function lastPricesFromMap(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!body || typeof body !== "object") return out;
  const row = body as { maps?: unknown; symbol?: unknown; ticker?: { lastPrice?: unknown } };
  const items = Array.isArray(row.maps) ? row.maps : [body];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { symbol?: unknown; ticker?: { lastPrice?: unknown } };
    const symbol = String(rec.symbol ?? "").trim().toUpperCase();
    const last = Number(rec.ticker?.lastPrice);
    if (symbol && Number.isFinite(last)) out.set(symbol, last);
  }
  return out;
}

/** Skip cards already through SL or ≥50% in. Mid-range (away) is OK — P3 waits. */
export function shouldAcceptCard(card: ZoneCard, last: number | undefined): boolean {
  if (mapSkipSymbol(card.symbol)) return false;
  if (last == null || !Number.isFinite(last)) return true;
  const decision = proximityDecision(card, last);
  return decision !== "deep" && decision !== "invalid";
}

export function pickAcceptable(cards: unknown[], lastBySymbol: Map<string, number>): ZoneCard[] {
  const out: ZoneCard[] = [];
  for (const raw of cards) {
    let card: ZoneCard;
    try {
      card = parseZoneCard(raw);
    } catch {
      continue;
    }
    if (!shouldAcceptCard(card, lastBySymbol.get(card.symbol))) continue;
    out.push(card);
  }
  return out;
}

export type MapAcceptResult = {
  accepted: string[];
  skipped: number;
  skipReasons: Record<string, number>;
};

/**
 * Copy GET /zones cards into the paper ledger after a 4H MAP dump.
 * Does not arm. Kill switch: MAP_ACCEPT=0.
 * When paper family scores exist, rank before the per-symbol cap (2).
 * Sampled families below the score floor or with avgRealizedRr ≤ 0 are skipped.
 * Missing / cold score is not a veto. PAPER_ZONE_SCORE=0 keeps detector order.
 */
export function runMapAccept(
  engine: PaperEngine,
  cards: unknown[],
  lastBySymbol: Map<string, number>,
  now = Date.now(),
  familyByKey?: Map<string, FamilyStats>,
): MapAcceptResult {
  const accepted: string[] = [];
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  const bump = (reason: string) => {
    skipped += 1;
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  };
  if (!mapAcceptEnabled()) return { accepted, skipped: cards.length, skipReasons };
  const stats = familyByKey ?? familyStatsFromEngine(engine, now);
  const picked: ZoneCard[] = [];
  for (const raw of cards) {
    let card: ZoneCard;
    try {
      card = parseZoneCard(raw);
    } catch {
      continue;
    }
    if (mapSkipSymbol(card.symbol)) {
      bump("map_skip");
      continue;
    }
    const last = lastBySymbol.get(card.symbol);
    if (last != null && Number.isFinite(last)) {
      const decision = proximityDecision(card, last);
      if (decision === "deep") {
        bump("deep_mitigate");
        continue;
      }
      if (decision === "invalid") {
        bump("htf_break");
        continue;
      }
    }
    picked.push(card);
  }
  const ranked = rankAcceptable(picked, stats);
  for (const card of ranked) {
    if (familyFloorVeto(stats.get(familyKey(familyFromCard(card))))) {
      bump("family_floor");
      continue;
    }
    try {
      engine.acceptZone(card, now);
      accepted.push(card.zoneId);
    } catch (error) {
      if (error instanceof PaperReject) {
        if (error.error === "duplicate_zone") {
          skipped += 1;
          continue;
        }
        if (error.error === "ledger_cap") {
          bump("ledger_cap");
          continue;
        }
      }
      skipped += 1;
      throw error;
    }
  }
  return { accepted, skipped, skipReasons };
}

export function familyStatsFromEngine(engine: PaperEngine, now: number, days = 7): Map<string, FamilyStats> {
  return familyStatsFromMetrics(engine.metrics(days, now));
}

export function familyStatsFromMetrics(metrics: {
  byFamily: Array<{
    family: string;
    trades: number;
    score: string | null;
    avgRealizedRr?: string | null;
  }>;
}): Map<string, FamilyStats> {
  const out = new Map<string, FamilyStats>();
  for (const row of metrics.byFamily) {
    out.set(row.family, {
      score: row.score,
      trades: row.trades,
      avgRealizedRr: row.avgRealizedRr ?? null,
    });
  }
  return out;
}

function rankAcceptable(cards: ZoneCard[], stats: Map<string, FamilyStats>): ZoneCard[] {
  if (!paperZoneScoreEnabled()) return cards;
  return rankZoneCards(cards, (card) => stats.get(familyKey(familyFromCard(card)))?.score ?? null);
}

export async function fetchZoneCards(
  feedUrl: string,
  getJson: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`zones HTTP ${res.status}`);
    return res.json();
  },
): Promise<unknown[]> {
  const base = feedUrl.replace(/\/$/, "").replace(/\/health$/, "");
  const payload = await getJson(`${base}/zones?interval=240`) as { zones?: unknown };
  return Array.isArray(payload.zones) ? payload.zones : [];
}
