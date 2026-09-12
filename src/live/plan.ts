import {
  bumpSkipReason,
  decideMapAccept,
  emptySkipReasons,
  loadFeedHealth,
  type PolicyReason,
} from "../agent/policy";
import { readMapBias } from "../agent/bias";
import { quantVeto, readMapQuant, type QuantTape } from "../agent/quant";
import { tradingGates } from "../paper/gates";
import { fetchZoneCards, lastPricesFromMap, mapAcceptEnabled } from "../paper/map-accept";
import { confirm15Bar, paperArmMaxSymbols, proximityArmEnabled } from "../paper/proximity";
import { compareZoneCards } from "../paper/score";
import type { PaperKlineSnap } from "../paper/types";
import { parseZoneCard, type ZoneCard } from "../zones/card";
import { proximityDecision } from "../zones/proximity";
import { LEDGER_CAP_PER_SYMBOL } from "../zones/ledger";
import type { LiveDb, ShadowCard } from "./db";
import { taArmWait, type TaArmTape, type TaOscTape } from "../agent/ta-gate";

export type ShadowMapPlan = {
  accepted: string[];
  skipped: number;
  skipReasons: Record<PolicyReason, number>;
};

export type ShadowArmPlan = {
  wouldArm: string[];
  dropped: string[];
};

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

function latestStartTs(bars: unknown): string | null {
  if (!Array.isArray(bars)) return null;
  let best: number | null = null;
  for (const bar of bars) {
    if (!bar || typeof bar !== "object") continue;
    const rec = bar as { start_ts?: unknown; startTs?: unknown };
    const n = Number(rec.start_ts ?? rec.startTs);
    if (Number.isFinite(n) && (best == null || n > best)) best = n;
  }
  return best == null ? null : String(best);
}

/** Fingerprint of the latest confirmed 4H bar per symbol. Poll uses this so 1H dumps do not re-plan. */
export function map240Fingerprint(map: unknown): string {
  if (!map || typeof map !== "object") return "";
  const root = map as { maps?: unknown };
  const items = Array.isArray(root.maps) ? root.maps : [map];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { symbol?: unknown; klines?: { "240"?: unknown } };
    const symbol = String(rec.symbol ?? "").trim().toUpperCase();
    const start = latestStartTs(rec.klines?.["240"]);
    if (symbol && start) parts.push(`${symbol}:${start}`);
  }
  return parts.sort().join("|");
}

/** Policy-only MAP plan. Does not acceptZone. Does not arm. Family is always cold (null). */
export async function planMapClose(
  store: LiveDb,
  info: { interval: string; map: unknown },
  opts: {
    now?: number;
    feedUrl?: string;
    fetchCards?: (feedUrl: string) => Promise<unknown[]>;
    minRr?: string | null;
    health?: { ok?: boolean; klineLagOk?: boolean };
    oscBySymbol?: Map<string, TaOscTape>;
  } = {},
): Promise<ShadowMapPlan | null> {
  if (info.interval !== "240") return null;
  if (!mapAcceptEnabled()) return { accepted: [], skipped: 0, skipReasons: emptySkipReasons() };

  const now = opts.now ?? Date.now();
  store.expire(now);
  const feedUrl = opts.feedUrl ?? "http://127.0.0.1:43180";
  const fetchCards = opts.fetchCards ?? fetchZoneCards;
  const lastBySymbol = lastPricesFromMap(info.map);
  const lagOk = mapLagOk(info.map) && (opts.health?.klineLagOk !== false);
  const gates = tradingGates({
    feedOk: opts.health?.ok,
    klineLagOk: lagOk,
  });
  const skipReasons = emptySkipReasons();
  if (!gates.tradingAllowed) {
    return { accepted: [], skipped: 0, skipReasons };
  }

  const cards = await fetchCards(feedUrl);
  const biases = readMapBias(info.map);
  const tapes = readMapQuant(info.map);
  const rows: Array<{ card: ZoneCard; allow: boolean; reason: PolicyReason }> = [];
  for (const raw of cards) {
    let card: ZoneCard;
    try {
      card = parseZoneCard(raw);
    } catch {
      continue;
    }
    const decision = decideMapAccept({
      card,
      bias: biases.get(card.symbol),
      last: lastBySymbol.get(card.symbol),
      minRr: opts.minRr,
      acceptedForSymbol: store.acceptedForSymbol(card.symbol),
      tradingAllowed: gates.tradingAllowed,
      now,
      tape: tapes.get(card.symbol),
      family: null,
      osc: opts.oscBySymbol?.get(card.symbol) ?? null,
    });
    rows.push({ card, allow: decision.allow, reason: decision.reason });
  }

  const passed = rows.filter((row) => row.allow).map((row) => row.card);
  const ranked = [...passed].sort((a, b) => compareZoneCards(a, b, () => null));
  const take = new Set<string>();
  const takenBySymbol = new Map<string, number>();
  for (const card of ranked) {
    const standing = store.acceptedForSymbol(card.symbol) + (takenBySymbol.get(card.symbol) ?? 0);
    if (standing >= LEDGER_CAP_PER_SYMBOL) continue;
    take.add(card.zoneId);
    takenBySymbol.set(card.symbol, (takenBySymbol.get(card.symbol) ?? 0) + 1);
  }

  const accepted: string[] = [];
  let skipped = 0;
  for (const row of rows) {
    let allow = row.allow && take.has(row.card.zoneId);
    let reason = row.reason;
    if (row.allow && !allow) reason = "ledger_cap";
    store.recordEvent({
      ts: now,
      kind: "map_plan",
      symbol: row.card.symbol,
      zoneId: row.card.zoneId,
      allow,
      reason,
      last: lastBySymbol.get(row.card.symbol),
      payload: { reason },
    });
    if (!allow) {
      skipped += 1;
      bumpSkipReason(skipReasons, reason);
      continue;
    }
    store.acceptCard(row.card, now);
    accepted.push(row.card.zoneId);
  }
  return { accepted, skipped, skipReasons };
}

/** Would-arm only. Never paperArm / never rest OCO. Cascade/crowded still wait. */
export function planArm(
  store: LiveDb,
  lastBySymbol: Map<string, number>,
  opts: {
    now?: number;
    kline15BySymbol?: Map<string, PaperKlineSnap>;
    quantBySymbol?: Map<string, QuantTape>;
    tradingAllowed?: boolean;
    taBySymbol?: Map<string, TaArmTape>;
  } = {},
): ShadowArmPlan {
  const now = opts.now ?? Date.now();
  store.expire(now);
  const wouldArm: string[] = [];
  const dropped: string[] = [];
  if (!proximityArmEnabled()) return { wouldArm, dropped };

  const standing = store.accepted(now);
  const occupied = new Set(
    standing.filter((row) => row.armedTs != null).map((row) => row.symbol),
  );
  const cap = paperArmMaxSymbols();
  const candidates: ShadowCard[] = [];

  for (const row of standing) {
    const last = lastBySymbol.get(row.symbol);
    if (last == null || !Number.isFinite(last)) continue;
    const proximity = proximityDecision(row.card, last);
    if (proximity === "deep" || proximity === "invalid") {
      store.drop(row.zoneId);
      dropped.push(row.zoneId);
      continue;
    }
    if (proximity !== "arm") continue;
    if (confirm15Bar(row.card, opts.kline15BySymbol?.get(row.symbol)) !== "ok") continue;
    if (row.armedTs != null) continue;
    if (occupied.has(row.symbol)) continue;
    if (opts.tradingAllowed === false) continue;
    if (!quantVeto(row.card.side, opts.quantBySymbol?.get(row.symbol), "arm").allow) continue;
    if (taArmWait(row.card.side, opts.taBySymbol?.get(row.symbol))) continue;
    candidates.push(row);
  }

  candidates.sort((a, b) => compareZoneCards(a.card, b.card, () => null));
  let free = cap == null ? candidates.length : cap - occupied.size;
  for (const row of candidates) {
    if (free <= 0) break;
    store.recordEvent({
      ts: now,
      kind: "arm_plan",
      symbol: row.symbol,
      zoneId: row.zoneId,
      allow: true,
      reason: "ok",
      last: lastBySymbol.get(row.symbol),
    });
    store.markArmed(row.zoneId, now);
    occupied.add(row.symbol);
    wouldArm.push(row.zoneId);
    free -= 1;
  }
  return { wouldArm, dropped };
}

export async function fetchFeedHealth(feedUrl: string) {
  return loadFeedHealth(feedUrl);
}
