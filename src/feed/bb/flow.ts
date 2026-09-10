import { normalizeBriefSymbol } from "./brief";
import type { TrackerDb } from "./db";

export const FLOW_NOTE = "quant veto — not a signal";
export const DEFAULT_FLOW_EXTREME = "0.15";
export const FLOW_BAR_MS = 60_000;
export const MAP_FLOW_WINDOWS = {
  "240": 4 * 3_600_000,
  "15": 15 * 60_000,
} as const;
export const MAP_FLOW_INTERVALS = ["240", "15"] as const;
export type MapFlowInterval = (typeof MAP_FLOW_INTERVALS)[number];

/** Bybit publicTrade: Buy = taker buy (CVD +); Sell = taker sell (CVD −). */
export type FlowSide = "Buy" | "Sell";
export type FlowReading = "buy_dom" | "sell_dom" | null;

export type FlowTrade = {
  symbol: string;
  side: FlowSide;
  price: string;
  size: string;
  exchTs: number;
};

export type FlowBar = {
  symbol: string;
  startTs: number;
  buySize: string;
  sellSize: string;
  buyNotional: string;
  sellNotional: string;
  tradeCount: number;
};

export type FlowWindow = {
  delta: string | null;
  buy: string;
  sell: string;
  imbalance: string | null;
  reading: FlowReading;
};

export type SnapshotFlow = {
  symbol: string;
  ts: number;
  "240": FlowWindow;
  "15": FlowWindow;
  delta: string | null;
  reading: FlowReading;
  extreme: string;
  meta: {
    db: string;
    note: typeof FLOW_NOTE;
  };
};

export type MapFlow = {
  "240": FlowWindow;
  "15": FlowWindow;
  delta: string | null;
  reading: FlowReading;
  extreme: string;
  note: typeof FLOW_NOTE;
};

export function flowEnabled(): boolean {
  return process.env.BYBIT_FLOW !== "0";
}

export function flowExtreme(): string {
  const raw = process.env.BYBIT_FLOW_EXTREME?.trim();
  if (!raw) return DEFAULT_FLOW_EXTREME;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? raw : DEFAULT_FLOW_EXTREME;
}

export function parseFlowSide(raw: unknown): FlowSide | null {
  return raw === "Buy" || raw === "Sell" ? raw : null;
}

export function flowBarStart(exchTs: number): number {
  return Math.floor(exchTs / FLOW_BAR_MS) * FLOW_BAR_MS;
}

export function addAmt(left: string, right: string): string {
  const sum = Number(left) + Number(right);
  if (!Number.isFinite(sum)) return left;
  return sum.toFixed(8);
}

export function parsePublicTrades(data: unknown, fallbackSymbol?: string): FlowTrade[] {
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const out: FlowTrade[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const side = parseFlowSide(rec.S);
    const price = rec.p == null ? "" : String(rec.p).trim();
    const size = rec.v == null ? "" : String(rec.v).trim();
    const exchTs = Number(rec.T);
    const symbol = String(rec.s ?? fallbackSymbol ?? "").trim().toUpperCase();
    if (!side || !symbol || price === "" || size === "" || !Number.isFinite(exchTs)) continue;
    out.push({ symbol, side, price, size, exchTs });
  }
  return out;
}

export function emptyFlowWindow(): FlowWindow {
  return {
    delta: null,
    buy: "0",
    sell: "0",
    imbalance: null,
    reading: null,
  };
}

export function emptyMapFlow(): MapFlow {
  return {
    "240": emptyFlowWindow(),
    "15": emptyFlowWindow(),
    delta: null,
    reading: null,
    extreme: flowExtreme(),
    note: FLOW_NOTE,
  };
}

export function flowImbalance(buy: number, sell: number): string | null {
  const total = buy + sell;
  if (!Number.isFinite(buy) || !Number.isFinite(sell) || total <= 0) return null;
  return ((buy - sell) / total).toFixed(4);
}

export function flowReading(imbalance: string | null, extreme = flowExtreme()): FlowReading {
  if (imbalance == null || imbalance === "") return null;
  const n = Number(imbalance);
  const floor = Number(extreme);
  if (!Number.isFinite(n) || !Number.isFinite(floor) || floor <= 0) return null;
  if (Math.abs(n) < floor) return null;
  return n > 0 ? "buy_dom" : "sell_dom";
}

export function summarizeFlow(buyNotional: string, sellNotional: string, extreme = flowExtreme()): FlowWindow {
  const buy = Number(buyNotional);
  const sell = Number(sellNotional);
  const safeBuy = Number.isFinite(buy) ? buy : 0;
  const safeSell = Number.isFinite(sell) ? sell : 0;
  const buyText = Number.isFinite(buy) ? buyNotional : "0";
  const sellText = Number.isFinite(sell) ? sellNotional : "0";
  if (safeBuy === 0 && safeSell === 0) return emptyFlowWindow();
  const delta = (safeBuy - safeSell).toFixed(4);
  const imbalance = flowImbalance(safeBuy, safeSell);
  return {
    delta,
    buy: buyText,
    sell: sellText,
    imbalance,
    reading: flowReading(imbalance, extreme),
  };
}

export type FlowStore = Pick<TrackerDb, "sumFlowWindow">;

export function buildFlowWindow(
  store: FlowStore,
  symbol: string,
  windowMs: number,
  now: number,
  extreme = flowExtreme(),
): FlowWindow {
  const fromTs = now - windowMs;
  const row = store.sumFlowWindow(symbol, fromTs, now);
  return summarizeFlow(row.buyNotional, row.sellNotional, extreme);
}

export function buildMapFlow(store: FlowStore, symbol: string, now = Date.now()): MapFlow {
  const extreme = flowExtreme();
  const h4 = buildFlowWindow(store, symbol, MAP_FLOW_WINDOWS["240"], now, extreme);
  const m15 = buildFlowWindow(store, symbol, MAP_FLOW_WINDOWS["15"], now, extreme);
  return {
    "240": h4,
    "15": m15,
    delta: h4.delta,
    reading: h4.reading,
    extreme,
    note: FLOW_NOTE,
  };
}

export function buildFlow(
  store: FlowStore,
  opts: { symbol?: string | null; dbPath: string; now?: number },
): SnapshotFlow {
  const symbol = normalizeBriefSymbol(opts.symbol);
  const now = opts.now ?? Date.now();
  const map = buildMapFlow(store, symbol, now);
  return {
    symbol,
    ts: now,
    "240": map["240"],
    "15": map["15"],
    delta: map.delta,
    reading: map.reading,
    extreme: map.extreme,
    meta: { db: opts.dbPath, note: FLOW_NOTE },
  };
}

export function aggregateFlowTrades(trades: FlowTrade[]): FlowBar[] {
  const grouped = new Map<string, FlowBar>();
  for (const trade of trades) {
    const startTs = flowBarStart(trade.exchTs);
    const key = `${trade.symbol}:${startTs}`;
    const price = Number(trade.price);
    const size = Number(trade.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    const notional = (price * size).toFixed(8);
    const sizeText = size.toFixed(8);
    let bar = grouped.get(key);
    if (!bar) {
      bar = {
        symbol: trade.symbol,
        startTs,
        buySize: "0",
        sellSize: "0",
        buyNotional: "0",
        sellNotional: "0",
        tradeCount: 0,
      };
      grouped.set(key, bar);
    }
    bar.tradeCount += 1;
    switch (trade.side) {
      case "Buy":
        bar.buySize = addAmt(bar.buySize, sizeText);
        bar.buyNotional = addAmt(bar.buyNotional, notional);
        break;
      case "Sell":
        bar.sellSize = addAmt(bar.sellSize, sizeText);
        bar.sellNotional = addAmt(bar.sellNotional, notional);
        break;
      default: {
        const _exhaustive: never = trade.side;
        return _exhaustive;
      }
    }
  }
  return [...grouped.values()];
}
