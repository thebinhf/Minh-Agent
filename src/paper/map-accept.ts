import { PaperReject } from "./errors";
import type { PaperEngine } from "./engine";
import type { ZoneCard } from "../zones/card";
import { parseZoneCard } from "../zones/card";
import { proximityDecision } from "../zones/proximity";

/** 4H close only. 1H dumps MAP but does not auto-accept. */
export function mapAcceptEnabled(): boolean {
  return process.env.MAP_ACCEPT !== "0";
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
};

/**
 * Copy GET /zones cards into the paper ledger after a 4H MAP dump.
 * Does not arm. Kill switch: MAP_ACCEPT=0.
 */
export function runMapAccept(
  engine: PaperEngine,
  cards: unknown[],
  lastBySymbol: Map<string, number>,
  now = Date.now(),
): MapAcceptResult {
  const accepted: string[] = [];
  let skipped = 0;
  if (!mapAcceptEnabled()) return { accepted, skipped: cards.length };
  for (const card of pickAcceptable(cards, lastBySymbol)) {
    try {
      engine.acceptZone(card, now);
      accepted.push(card.zoneId);
    } catch (error) {
      skipped += 1;
      if (error instanceof PaperReject) {
        if (error.error === "duplicate_zone" || error.error === "ledger_cap") continue;
      }
      throw error;
    }
  }
  return { accepted, skipped };
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
