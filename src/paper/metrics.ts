import { Dec } from "./decimal";
import { PaperReject } from "./errors";
import type { EventView, OrderView, PaperMetrics, PositionView } from "./types";
import {
  bumpCancelCode,
  classifyCancelCode,
  emptyCancelCodeCounts,
  type CancelCode,
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
    const reason = String(event.payload.reason ?? "");
    if (reason === "kline_lag" || reason === "feed_unhealthy") return "gates_block";
    if (reason === "rr_below_min") return "rr_fail";
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
      if (risk.isPos()) realizedRr.push(pnl.div(risk));
    } catch {
      // skip
    }
  }

  const trades = closed.length;
  const resolvedNoFill = counts.invalidated + counts.cancelled;
  const resolvedAttempts = limitFilled + counts.invalidated + counts.cancelled;

  const zones = [...byZone.values()].map((bucket) => ({
    ...bucket,
    winRate: ratio(bucket.wins, bucket.trades),
    avgRr: meanDec(rrByZone.get(zoneKey(bucket.zoneId)) ?? []),
  }));
  zones.sort((a, b) => {
    if (a.zoneId == null) return 1;
    if (b.zoneId == null) return -1;
    return a.zoneId.localeCompare(b.zoneId);
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
    "funnel",
    "cancelCodes",
  ];
}
