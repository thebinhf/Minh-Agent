import type { TrackerDb } from "./db";
import { intervalToMs, normalizeKlineInterval } from "./recovery";
import type { BookLevel } from "./types";

export const DEFAULT_VIEW_SYMBOL = "BTCUSDT";
export const DEFAULT_CHART_INTERVAL = "15";
export const DEFAULT_CHART_LIMIT = 200;
export const CHART_MAX_LIMIT = 2_000;
export const DEFAULT_HEATMAP_LIMIT = 120;
export const HEATMAP_MAX_LIMIT = 500;
export const HEATMAP_MAX_PRICES = 300;

export type ChartBar = {
  startTs: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  turnover: string | null;
  confirm: boolean | null;
};

export type ChartGap = {
  afterTs: number;
  nextTs: number;
  missing: number;
};

export type ChartView = {
  symbol: string;
  interval: string;
  intervalMs: number;
  source: "kline";
  volumeSource: "kline.volume";
  bars: ChartBar[];
  gaps: ChartGap[];
  forming: boolean;
  count: number;
};

export type DepthLevel = {
  price: string;
  size: string;
  cumSize: string;
};

export type DepthView = {
  symbol: string;
  depth: number | null;
  recvTs: number | null;
  bestBid: string | null;
  bestAsk: string | null;
  spread: string | null;
  mid: string | null;
  bids: DepthLevel[];
  asks: DepthLevel[];
};

export type HeatmapView = {
  symbol: string;
  bucket: string | null;
  times: number[];
  prices: string[];
  bid: Array<Array<string | null>>;
  ask: Array<Array<string | null>>;
  bestBid: Array<string | null>;
  bestAsk: Array<string | null>;
  snapshotCount: number;
  /** Last column is `orderbook_latest` when newer than the last snapshot. */
  live: boolean;
};

export type MarketTicker = {
  lastPrice: string | null;
  markPrice: string | null;
  bid1Price: string | null;
  ask1Price: string | null;
  recvTs: number | null;
};

export type MarketView = {
  symbol: string;
  ts: number;
  interval: string;
  ticker: MarketTicker;
  chart: ChartView;
  depth: DepthView;
  heatmap: HeatmapView;
  meta: {
    sources: {
      chart: "kline";
      depth: "orderbook_latest";
      heatmap: "orderbook_snapshots";
    };
  };
};

export const DEFAULT_MARKET_CHART_LIMIT = 80;
export const DEFAULT_MARKET_HEATMAP_LIMIT = 60;

export type ViewStore = Pick<TrackerDb, "listKlines" | "listOrderbooks" | "listOrderbookSnapshots" | "listTickers">;

function normalizeSymbol(raw: string | undefined | null): string {
  const symbol = raw?.trim().toUpperCase();
  return symbol || DEFAULT_VIEW_SYMBOL;
}

function textField(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function numberField(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function confirmField(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return Boolean(value);
}

function cmpPrice(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function addSizes(a: number, b: number): string {
  const sum = a + b;
  if (Number.isInteger(sum)) return String(sum);
  return String(Number(sum.toPrecision(12)));
}

function parseLevels(raw: unknown): BookLevel[] {
  if (typeof raw === "string") {
    try {
      return parseLevels(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row[0] == null) continue;
    out.push([String(row[0]), String(row[1] ?? "0")]);
  }
  return out;
}

function mapBar(row: Record<string, unknown>): ChartBar | null {
  const startTs = numberField(row.start_ts ?? row.start);
  if (startTs == null) return null;
  return {
    startTs,
    open: textField(row.open),
    high: textField(row.high),
    low: textField(row.low),
    close: textField(row.close),
    volume: textField(row.volume),
    turnover: textField(row.turnover),
    confirm: confirmField(row.confirm),
  };
}

/**
 * Stitch kline rows into an oldest-first chart series.
 * Identity is `startTs` (one bar per interval open). Same-start updates
 * overwrite — that is how the live forming candle mutates. Volume is the
 * kline's own `volume`, never ticker `volume24h`.
 */
export function stitchBars(rows: Array<Record<string, unknown>>, intervalMs: number): {
  bars: ChartBar[];
  gaps: ChartGap[];
} {
  const byStart = new Map<number, ChartBar>();
  for (const row of rows) {
    const bar = mapBar(row);
    if (!bar) continue;
    byStart.set(bar.startTs, bar);
  }
  const bars = [...byStart.values()].sort((a, b) => a.startTs - b.startTs);
  const gaps: ChartGap[] = [];
  if (intervalMs > 0) {
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1]!;
      const cur = bars[i]!;
      const delta = cur.startTs - prev.startTs;
      if (delta > intervalMs) {
        const missing = Math.round(delta / intervalMs) - 1;
        if (missing > 0) {
          gaps.push({ afterTs: prev.startTs, nextTs: cur.startTs, missing });
        }
      }
    }
  }
  return { bars, gaps };
}

export function buildChart(
  store: ViewStore,
  opts: {
    symbol?: string | null;
    interval?: string | null;
    limit?: number;
    startTs?: number;
    endTs?: number;
  } = {},
): ChartView {
  const symbol = normalizeSymbol(opts.symbol);
  const interval = normalizeKlineInterval(opts.interval?.trim() || DEFAULT_CHART_INTERVAL);
  const intervalMs = intervalToMs(interval);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_CHART_LIMIT, 1), CHART_MAX_LIMIT);
  const rows = store.listKlines({
    symbol,
    interval,
    limit,
    startTs: opts.startTs,
    endTs: opts.endTs,
    maxLimit: CHART_MAX_LIMIT,
  }) as Array<Record<string, unknown>>;
  const { bars, gaps } = stitchBars(rows, intervalMs);
  return {
    symbol,
    interval,
    intervalMs,
    source: "kline",
    volumeSource: "kline.volume",
    bars,
    gaps,
    forming: bars.at(-1)?.confirm === false,
    count: bars.length,
  };
}

function withCumulative(levels: BookLevel[], side: "bid" | "ask"): DepthLevel[] {
  const sorted = [...levels].sort((a, b) => (side === "bid" ? cmpPrice(b[0], a[0]) : cmpPrice(a[0], b[0])));
  let cum = 0;
  return sorted.map(([price, size]) => {
    cum += Number(size) || 0;
    return { price, size, cumSize: addSizes(0, cum) };
  });
}

export function buildDepth(store: ViewStore, opts: { symbol?: string | null } = {}): DepthView {
  const symbol = normalizeSymbol(opts.symbol);
  const rows = store.listOrderbooks(symbol) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) {
    return {
      symbol,
      depth: null,
      recvTs: null,
      bestBid: null,
      bestAsk: null,
      spread: null,
      mid: null,
      bids: [],
      asks: [],
    };
  }
  const bids = withCumulative(parseLevels(row.bids_json ?? row.bids), "bid");
  const asks = withCumulative(parseLevels(row.asks_json ?? row.asks), "ask");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  let spread: string | null = null;
  let mid: string | null = null;
  if (bestBid != null && bestAsk != null) {
    const bidN = Number(bestBid);
    const askN = Number(bestAsk);
    if (Number.isFinite(bidN) && Number.isFinite(askN)) {
      spread = addSizes(askN, -bidN);
      mid = addSizes((askN + bidN) / 2, 0);
    }
  }
  return {
    symbol,
    depth: numberField(row.depth),
    recvTs: numberField(row.recv_ts),
    bestBid,
    bestAsk,
    spread,
    mid,
    bids,
    asks,
  };
}

export function bucketPrice(price: string, step: number): string {
  const n = Number(price);
  if (!Number.isFinite(n) || !(step > 0)) return price;
  return addSizes(Math.round(n / step) * step, 0);
}

function lastMid(bestBids: Array<string | null>, bestAsks: Array<string | null>): number | null {
  for (let i = bestBids.length - 1; i >= 0; i--) {
    const bid = Number(bestBids[i]);
    const ask = Number(bestAsks[i]);
    if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
    if (Number.isFinite(bid)) return bid;
    if (Number.isFinite(ask)) return ask;
  }
  return null;
}

/**
 * Liquidity heatmap from `orderbook_snapshots` (L50 book over time).
 * This is not a trade-footprint / CVD map — public linear WS does not
 * stream prints here. Size at each price is the resting book, sampled
 * on the snapshot timer (default 5s).
 */
function ingestBook(
  row: Record<string, unknown>,
  bucket: number | null,
  into: {
    times: number[];
    bestBid: Array<string | null>;
    bestAsk: Array<string | null>;
    bidMaps: Array<Map<string, number>>;
    askMaps: Array<Map<string, number>>;
    priceSet: Set<string>;
  },
): boolean {
  const ts = numberField(row.recv_ts);
  if (ts == null) return false;
  const bidLevels = parseLevels(row.bids_json ?? row.bids);
  const askLevels = parseLevels(row.asks_json ?? row.asks);
  const bidMap = new Map<string, number>();
  const askMap = new Map<string, number>();
  for (const [price, size] of bidLevels) {
    const key = bucket ? bucketPrice(price, bucket) : price;
    bidMap.set(key, (bidMap.get(key) ?? 0) + (Number(size) || 0));
    into.priceSet.add(key);
  }
  for (const [price, size] of askLevels) {
    const key = bucket ? bucketPrice(price, bucket) : price;
    askMap.set(key, (askMap.get(key) ?? 0) + (Number(size) || 0));
    into.priceSet.add(key);
  }
  into.times.push(ts);
  into.bidMaps.push(bidMap);
  into.askMaps.push(askMap);
  const sortedBids = [...bidMap.keys()].sort((a, b) => cmpPrice(b, a));
  const sortedAsks = [...askMap.keys()].sort(cmpPrice);
  into.bestBid.push(sortedBids[0] ?? null);
  into.bestAsk.push(sortedAsks[0] ?? null);
  return true;
}

export function buildHeatmap(
  store: ViewStore,
  opts: {
    symbol?: string | null;
    limit?: number;
    startTs?: number;
    endTs?: number;
    bucket?: number | null;
    includeLive?: boolean;
  } = {},
): HeatmapView {
  const symbol = normalizeSymbol(opts.symbol);
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_HEATMAP_LIMIT, 1), HEATMAP_MAX_LIMIT);
  const bucket = opts.bucket != null && opts.bucket > 0 ? opts.bucket : null;
  const includeLive = opts.includeLive !== false;
  const rows = (store.listOrderbookSnapshots({
    symbol,
    limit,
    startTs: opts.startTs,
    endTs: opts.endTs,
    maxLimit: HEATMAP_MAX_LIMIT,
  }) as Array<Record<string, unknown>>).slice().reverse();

  const acc = {
    times: [] as number[],
    bestBid: [] as Array<string | null>,
    bestAsk: [] as Array<string | null>,
    bidMaps: [] as Array<Map<string, number>>,
    askMaps: [] as Array<Map<string, number>>,
    priceSet: new Set<string>(),
  };

  for (const row of rows) ingestBook(row, bucket, acc);

  let live = false;
  if (includeLive) {
    const latest = (store.listOrderbooks(symbol) as Array<Record<string, unknown>>)[0];
    const latestTs = latest ? numberField(latest.recv_ts) : null;
    const lastSnap = acc.times.at(-1);
    if (latest && latestTs != null && (lastSnap == null || latestTs > lastSnap)) {
      ingestBook(latest, bucket, acc);
      live = true;
    } else if (latest && latestTs != null && lastSnap === latestTs) {
      live = true;
    }
  }

  let prices = [...acc.priceSet].sort(cmpPrice);
  const mid = lastMid(acc.bestBid, acc.bestAsk);
  if (prices.length > HEATMAP_MAX_PRICES && mid != null) {
    prices = prices
      .map((price) => ({ price, dist: Math.abs(Number(price) - mid) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, HEATMAP_MAX_PRICES)
      .map((row) => row.price)
      .sort(cmpPrice);
  }

  const bid = acc.bidMaps.map((map) => prices.map((price) => {
    const size = map.get(price);
    return size == null ? null : addSizes(size, 0);
  }));
  const ask = acc.askMaps.map((map) => prices.map((price) => {
    const size = map.get(price);
    return size == null ? null : addSizes(size, 0);
  }));

  return {
    symbol,
    bucket: bucket == null ? null : addSizes(bucket, 0),
    times: acc.times,
    prices,
    bid,
    ask,
    bestBid: acc.bestBid,
    bestAsk: acc.bestAsk,
    snapshotCount: acc.times.length,
    live,
  };
}

function readMarketTicker(store: ViewStore, symbol: string): MarketTicker {
  const empty: MarketTicker = {
    lastPrice: null,
    markPrice: null,
    bid1Price: null,
    ask1Price: null,
    recvTs: null,
  };
  try {
    const rows = store.listTickers(symbol) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return empty;
    return {
      lastPrice: textField(row.last_price),
      markPrice: textField(row.mark_price),
      bid1Price: textField(row.bid1_price),
      ask1Price: textField(row.ask1_price),
      recvTs: numberField(row.recv_ts),
    };
  } catch {
    return empty;
  }
}

/**
 * One local payload for Minh: stitched kline chart + live depth + liquidity heatmap.
 * Does not invent prices. Missing pieces are empty / null.
 */
export function buildMarket(
  store: ViewStore,
  opts: {
    symbol?: string | null;
    interval?: string | null;
    limit?: number;
    heatmapLimit?: number;
    bucket?: number | null;
    now?: number;
  } = {},
): MarketView {
  const symbol = normalizeSymbol(opts.symbol);
  const interval = normalizeKlineInterval(opts.interval?.trim() || DEFAULT_CHART_INTERVAL);
  return {
    symbol,
    ts: opts.now ?? Date.now(),
    interval,
    ticker: readMarketTicker(store, symbol),
    chart: buildChart(store, {
      symbol,
      interval,
      limit: opts.limit ?? DEFAULT_MARKET_CHART_LIMIT,
    }),
    depth: buildDepth(store, { symbol }),
    heatmap: buildHeatmap(store, {
      symbol,
      limit: opts.heatmapLimit ?? DEFAULT_MARKET_HEATMAP_LIMIT,
      bucket: opts.bucket,
      includeLive: true,
    }),
    meta: {
      sources: {
        chart: "kline",
        depth: "orderbook_latest",
        heatmap: "orderbook_snapshots",
      },
    },
  };
}
