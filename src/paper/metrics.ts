import { Dec } from "./decimal";
import { PaperReject } from "./errors";
import { cancelCodeForReject } from "./gates";
import type { EventView, OrderView, PaperMetrics, PaperMetricsFamily, PositionView } from "./types";
import {
  familyFromCard,
  familyKey,
  resolveZoneFamily,
  zoneScore,
  type ZoneFamily,
} from "./score";
import {
  bumpCancelCode,
  classifyCancelCode,
  emptyCancelCodeCounts,
  type CancelCode,
  type ZoneSide,
} from "../zones/card";

const DAY_MS = 86_400_000;
export const DEFAULT_METRICS_DAYS = 7;
export const MAX_METRICS_DAYS = 365;

export function parseMetricsDays(raw: unknown, fallback = DEFAULT_METRICS_DAYS): number {
  if (raw == null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_METRICS_DAYS) {
    throw new PaperReject("invalid_days", "days", {
      days: raw,
      min: 1,
      max: MAX_METRICS_DAYS,
    });
  }
  return n;
}

export type PaperMetricsSource = {
  eventsBetween(fromTs: number, toTs: number, limit?: number): EventView[];
  positions(status: "open" | "closed" | "all"): PositionView[];
  account(): { openPositions: number; pendingOrders: number };
  orders?(status: "pending" | "filled" | "cancelled" | "rejected" | "invalidated" | "all"): OrderView[];
  zones?(status?: "accepted" | "rejected" | "expired" | "all"): Array<{
    zoneId: string;
    acceptedTs: number;
    symbol?: string;
    tf?: string;
    side?: ZoneSide;
  }>;
};

function metricsWindow(days: number, now: number): { fromTs: number; toTs: number } {
  return { fromTs: now - days * DAY_MS, toTs: now };
}

function inWindow(ts: number | null | undefined, fromTs: number, toTs: number): boolean {
  return ts != null && ts >= fromTs && ts <= toTs;
}

function meanDec(values: Dec[]): string | null {
  if (!values.length) return null;
  let sum = Dec.zero();
  for (const value of values) sum = sum.add(value);
  return sum.div(Dec.from(String(values.length))).toText();
}

function ratio(numer: number, denom: number): string | null {
  if (denom <= 0) return null;
  return Dec.from(String(numer)).div(Dec.from(String(denom))).toText();
}

function zoneKey(zoneId: string | null): string {
  return zoneId ?? "";
}

function emptyCloseReasons() {
  return { sl: 0, tp: 0, liq: 0, manual: 0 };
}

function emptyFunnel() {
  return {
    detected: 0,
    accepted: 0,
    armed: 0,
    touched: 0,
    filled: 0,
    cancelled: 0,
    exited: 0,
  };
}

function cancelCodeFromEvent(event: EventView): CancelCode | null {
  const tagged = classifyCancelCode(event.payload.cancelCode);
  if (tagged) return tagged;
  if (event.kind === "order.cancelled") return "ops_cancel";
  if (event.kind === "order.invalidated") return "never_touched";
  if (event.kind === "order.rejected") {
    return cancelCodeForReject(String(event.payload.reason ?? ""));
  }
  return null;
}

function emptyZoneBucket(zoneId: string | null) {
  return {
    zoneId,
    trades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: null as string | null,
    avgRr: null as string | null,
    filled: 0,
    invalidated: 0,
    cancelled: 0,
    score: null as string | null,
  };
}

function emptyFamilyBucket(family: ZoneFamily) {
  return {
    family: familyKey(family),
    symbol: family.symbol,
    tf: family.tf,
    side: family.side,
    trades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    filled: 0,
    invalidated: 0,
    cancelled: 0,
  };
}

/**
 * Method stats from the paper ledger + `paper_events`.
 * Missing rates are null; counts are 0. Does not invent zone ids.
 */
export function paperMetrics(engine: PaperMetricsSource, days = DEFAULT_METRICS_DAYS, now = Date.now()): PaperMetrics {
  const windowDays = parseMetricsDays(days, DEFAULT_METRICS_DAYS);
  const window = metricsWindow(windowDays, now);
  const events = engine.eventsBetween(window.fromTs, window.toTs + 1, 10_000);
  const closed = engine.positions("closed").filter((row) => inWindow(row.closedTs, window.fromTs, window.toTs));
  const account = engine.account();

  const counts = {
    filled: 0,
    invalidated: 0,
    cancelled: 0,
    rejected: 0,
    closed: 0,
    closeReasons: emptyCloseReasons(),
  };
  let realized = Dec.zero();
  const byZone = new Map<string, ReturnType<typeof emptyZoneBucket>>();
  const rrByZone = new Map<string, Dec[]>();
  const cancelCodes = emptyCancelCodeCounts();
  const detectedIds = new Set<string>();
  let touched = 0;
  const ledgerFamilies = new Map<string, ZoneFamily>();
  for (const row of engine.zones?.("all") ?? []) {
    if (inWindow(row.acceptedTs, window.fromTs, window.toTs)) {
      detectedIds.add(row.zoneId);
    }
    if (row.symbol && row.tf && (row.side === "demand" || row.side === "supply")) {
      ledgerFamilies.set(row.zoneId, familyFromCard({
        symbol: row.symbol,
        tf: row.tf,
        side: row.side,
        zoneId: row.zoneId,
      }));
    }
  }

  function noteZone(zoneId: string | null) {
    if (zoneId) detectedIds.add(zoneId);
  }

  function zoneBucket(zoneId: string | null) {
    const key = zoneKey(zoneId);
    let bucket = byZone.get(key);
    if (!bucket) {
      bucket = emptyZoneBucket(zoneId);
      byZone.set(key, bucket);
    }
    return bucket;
  }

  for (const event of events) {
    const zoneId = event.zoneId ?? parseEventZoneId(event);
    noteZone(zoneId);
    const code = cancelCodeFromEvent(event);
    if (code) bumpCancelCode(cancelCodes, code);
    if (event.kind === "order.filled") {
      counts.filled += 1;
      zoneBucket(zoneId).filled += 1;
    } else if (event.kind === "order.invalidated") {
      counts.invalidated += 1;
      zoneBucket(zoneId).invalidated += 1;
    } else if (event.kind === "order.cancelled") {
      counts.cancelled += 1;
      zoneBucket(zoneId).cancelled += 1;
    } else if (event.kind === "order.rejected") {
      counts.rejected += 1;
    } else if (event.kind === "alert.fired") {
      if (zoneId) touched += 1;
    } else if (event.kind === "position.closed") {
      counts.closed += 1;
      const reason = String(event.payload.closeReason ?? "");
      if (reason === "sl") counts.closeReasons.sl += 1;
      else if (reason === "tp") counts.closeReasons.tp += 1;
      else if (reason === "liq") counts.closeReasons.liq += 1;
      else if (reason === "manual") counts.closeReasons.manual += 1;
      if (event.payload.realizedPnl) {
        realized = realized.add(Dec.from(String(event.payload.realizedPnl)));
      }
    }
  }

  // Market opens write paper_fills but not order.filled. noFillPct uses limit fills only.
  const limitFilled = counts.filled;
  const marketOpens = engine.positions("all").filter((row) => (
    row.fillSource === "last" && inWindow(row.openedTs, window.fromTs, window.toTs)
  ));
  counts.filled += marketOpens.length;
  for (const row of marketOpens) {
    noteZone(row.zoneId ?? null);
    zoneBucket(row.zoneId ?? null).filled += 1;
  }

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  const plannedRr: Dec[] = [];
  const realizedRr: Dec[] = [];
  const realizedRrByZone = new Map<string, Dec[]>();

  for (const row of closed) {
    const pnl = Dec.from(row.realizedPnl ?? "0");
    const zoneId = row.zoneId ?? null;
    noteZone(zoneId);
    const bucket = zoneBucket(zoneId);
    bucket.trades += 1;
    if (pnl.isPos()) {
      wins += 1;
      bucket.wins += 1;
    } else if (pnl.isNeg()) {
      losses += 1;
      bucket.losses += 1;
    } else {
      breakeven += 1;
      bucket.breakeven += 1;
    }
    try {
      const rr = Dec.from(row.rr);
      plannedRr.push(rr);
      const list = rrByZone.get(zoneKey(zoneId)) ?? [];
      list.push(rr);
      rrByZone.set(zoneKey(zoneId), list);
    } catch {
      // skip bad rr
    }
    try {
      const risk = Dec.from(row.riskQuote);
      if (risk.isPos()) {
        const realizedOne = pnl.div(risk);
        realizedRr.push(realizedOne);
        const list = realizedRrByZone.get(zoneKey(zoneId)) ?? [];
        list.push(realizedOne);
        realizedRrByZone.set(zoneKey(zoneId), list);
      }
    } catch {
      // skip
    }
  }

  const trades = closed.length;
  const resolvedNoFill = counts.invalidated + counts.cancelled;
  const resolvedAttempts = limitFilled + counts.invalidated + counts.cancelled;

  const zones = [...byZone.values()].map((bucket) => {
    const winRate = ratio(bucket.wins, bucket.trades);
    const avgRr = meanDec(rrByZone.get(zoneKey(bucket.zoneId)) ?? []);
    const score = zoneScore(bucket);
    return { ...bucket, winRate, avgRr, score };
  });
  zones.sort((a, b) => {
    if (a.zoneId == null) return 1;
    if (b.zoneId == null) return -1;
    return a.zoneId.localeCompare(b.zoneId);
  });

  const familyAcc = new Map<string, ReturnType<typeof emptyFamilyBucket> & { rr: Dec[]; realized: Dec[] }>();
  for (const bucket of zones) {
    const family = resolveZoneFamily(bucket.zoneId, ledgerFamilies);
    if (!family) continue;
    const key = familyKey(family);
    let row = familyAcc.get(key);
    if (!row) {
      row = { ...emptyFamilyBucket(family), rr: [], realized: [] };
      familyAcc.set(key, row);
    }
    row.trades += bucket.trades;
    row.wins += bucket.wins;
    row.losses += bucket.losses;
    row.breakeven += bucket.breakeven;
    row.filled += bucket.filled;
    row.invalidated += bucket.invalidated;
    row.cancelled += bucket.cancelled;
    row.rr.push(...(rrByZone.get(zoneKey(bucket.zoneId)) ?? []));
    row.realized.push(...(realizedRrByZone.get(zoneKey(bucket.zoneId)) ?? []));
  }
  const byFamily: PaperMetricsFamily[] = [...familyAcc.values()].map((row) => {
    const attempts = row.filled + row.invalidated + row.cancelled;
    return {
      family: row.family,
      symbol: row.symbol,
      tf: row.tf,
      side: row.side,
      trades: row.trades,
      wins: row.wins,
      losses: row.losses,
      breakeven: row.breakeven,
      winRate: ratio(row.wins, row.trades),
      avgRr: meanDec(row.rr),
      avgRealizedRr: meanDec(row.realized),
      filled: row.filled,
      invalidated: row.invalidated,
      cancelled: row.cancelled,
      noFillPct: ratio(row.invalidated + row.cancelled, attempts),
      score: zoneScore(row),
    };
  });
  byFamily.sort((a, b) => {
    if (a.score != null && b.score != null) {
      const cmp = Dec.from(b.score).cmp(Dec.from(a.score));
      if (cmp !== 0) return cmp;
    } else if (a.score != null) {
      return -1;
    } else if (b.score != null) {
      return 1;
    }
    return a.family.localeCompare(b.family);
  });

  const orders = engine.orders?.("all") ?? [];
  const armed = orders.filter((row) => (
    row.zoneId != null && inWindow(row.createdTs, window.fromTs, window.toTs)
  )).length;
  for (const row of orders) {
    if (inWindow(row.createdTs, window.fromTs, window.toTs)) noteZone(row.zoneId ?? null);
  }
  const funnel = {
    detected: detectedIds.size,
    accepted: (engine.zones?.("all") ?? []).filter((row) => inWindow(row.acceptedTs, window.fromTs, window.toTs)).length,
    armed,
    touched,
    filled: counts.filled,
    cancelled: counts.invalidated + counts.cancelled,
    exited: counts.closed,
  };

  return {
    mode: "paper",
    days: windowDays,
    fromTs: window.fromTs,
    toTs: window.toTs,
    trades,
    wins,
    losses,
    breakeven,
    winRate: ratio(wins, trades),
    avgRr: meanDec(plannedRr),
    avgRealizedRr: meanDec(realizedRr),
    noFillPct: ratio(resolvedNoFill, resolvedAttempts),
    filled: counts.filled,
    invalidated: counts.invalidated,
    cancelled: counts.cancelled,
    rejected: counts.rejected,
    closed: counts.closed,
    closeReasons: counts.closeReasons,
    realizedPnl: realized.toText(),
    openPositions: account.openPositions,
    pendingOrders: account.pendingOrders,
    events: events.length,
    byZone: zones,
    byFamily,
    funnel,
    cancelCodes,
  };
}

function parseEventZoneId(event: EventView): string | null {
  const raw = event.payload.zoneId;
  if (raw == null || raw === "") return null;
  return String(raw);
}

export function emptyPaperMetrics(days = DEFAULT_METRICS_DAYS, now = Date.now()): PaperMetrics {
  const window = metricsWindow(days, now);
  return {
    mode: "paper",
    days,
    fromTs: window.fromTs,
    toTs: window.toTs,
    trades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: null,
    avgRr: null,
    avgRealizedRr: null,
    noFillPct: null,
    filled: 0,
    invalidated: 0,
    cancelled: 0,
    rejected: 0,
    closed: 0,
    closeReasons: emptyCloseReasons(),
    realizedPnl: "0",
    openPositions: 0,
    pendingOrders: 0,
    events: 0,
    byZone: [],
    byFamily: [],
    funnel: emptyFunnel(),
    cancelCodes: emptyCancelCodeCounts(),
  };
}

export function metricsKeys(): Array<keyof PaperMetrics> {
  return [
    "mode",
    "days",
    "fromTs",
    "toTs",
    "trades",
    "wins",
    "losses",
    "breakeven",
    "winRate",
    "avgRr",
    "avgRealizedRr",
    "noFillPct",
    "filled",
    "invalidated",
    "cancelled",
    "rejected",
    "closed",
    "closeReasons",
    "realizedPnl",
    "openPositions",
    "pendingOrders",
    "events",
    "byZone",
    "byFamily",
    "funnel",
    "cancelCodes",
  ];
}
