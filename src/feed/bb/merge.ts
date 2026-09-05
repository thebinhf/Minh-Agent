import type { BookLevel, BybitOrderbookData, BybitTickerData, OrderBookState, TickerState } from "./types";

function pickDefinedFields(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "symbol" || value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Linear tickers send a snapshot, then deltas. A missing field means unchanged
 * (Bybit V5 ticker docs). Present keys — including empty strings — overwrite.
 */
export function mergeTicker(
  prev: TickerState | null,
  type: "snapshot" | "delta",
  data: BybitTickerData,
  extras: { cs?: number; ts?: number } = {},
): TickerState {
  const incoming = pickDefinedFields(data);
  const symbol = String(data.symbol ?? prev?.symbol ?? "");

  if (!prev || type === "snapshot") {
    return {
      symbol,
      fields: incoming,
      cs: extras.cs,
      ts: extras.ts,
      type,
    };
  }

  return {
    symbol,
    fields: { ...prev.fields, ...incoming },
    cs: extras.cs ?? prev.cs,
    ts: extras.ts ?? prev.ts,
    type,
  };
}

function levelsToMap(levels: BookLevel[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  applyLevels(map, levels);
  return map;
}

export function applyLevels(map: Map<string, string>, levels: BookLevel[] | undefined): void {
  if (!levels) return;
  for (const entry of levels) {
    const price = entry[0];
    const size = entry[1];
    if (!price) continue;
    if (size === "0") map.delete(price);
    else map.set(price, size);
  }
}

/**
 * Bybit V5 orderbook.50:
 * - snapshot (or u=1 service restart) replaces the local book
 * - delta size 0 deletes a level; otherwise insert/update
 * - deltas before a snapshot are ignored so a reconnect cannot merge onto a stale book
 */
export function applyOrderbook(
  prev: OrderBookState | null,
  type: "snapshot" | "delta",
  data: BybitOrderbookData,
): OrderBookState | null {
  const replace = type === "snapshot" || data.u === 1;
  if (!replace) {
    if (!prev?.ready) return prev;
    const bids = new Map(prev.bids);
    const asks = new Map(prev.asks);
    applyLevels(bids, data.b);
    applyLevels(asks, data.a);
    return {
      symbol: data.s,
      bids,
      asks,
      updateId: data.u,
      seq: data.seq,
      ready: true,
    };
  }

  return {
    symbol: data.s,
    bids: levelsToMap(data.b),
    asks: levelsToMap(data.a),
    updateId: data.u,
    seq: data.seq,
    ready: true,
  };
}

function cmpPrice(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedLevels(map: Map<string, string>, side: "bid" | "ask"): BookLevel[] {
  const levels = [...map.entries()] as BookLevel[];
  levels.sort((a, b) => (side === "bid" ? cmpPrice(b[0], a[0]) : cmpPrice(a[0], b[0])));
  return levels;
}

export function serializeBook(state: OrderBookState): { bids: BookLevel[]; asks: BookLevel[] } {
  return {
    bids: sortedLevels(state.bids, "bid"),
    asks: sortedLevels(state.asks, "ask"),
  };
}
