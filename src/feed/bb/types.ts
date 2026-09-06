export type JsonObject = Record<string, unknown>;

export type OrderbookConfig = {
  depth: number;
  symbols: string[];
};

export type RecoveryConfig = {
  pongStaleMs: number;
  watchdogIntervalMs: number;
  watchdogGraceMs: number;
  subscribeChunkSize: number;
  subscribeRetries: number;
  subscribeRetryDelayMs: number;
  subscribeAckTimeoutMs: number;
  restRetries: number;
  restRetryDelayMs: number;
  restTimeoutMs: number;
  gapFill: boolean;
};

/** Public linear intervals used for price-action history (not the live 5m stream). */
export const PA_KLINE_INTERVALS = ["15", "60", "240"] as const;

export type TrackerConfig = {
  endpoint: string;
  restEndpoint: string;
  /** Extra public REST bases tried after `restEndpoint` returns 401/403/404. */
  restFallbacks: string[];
  httpHost: string;
  httpPort: number;
  dbPath: string;
  symbols: string[];
  klineIntervals: string[];
  orderbook: OrderbookConfig;
  pingIntervalMs: number;
  reconnect: {
    initialDelayMs: number;
    maxDelayMs: number;
  };
  retention: {
    tickerSnapshotsHours: number;
    orderbookSnapshotsHours: number;
    klinesDays: number;
    pruneIntervalMs: number;
  };
  snapshot: {
    tickerEveryMs: number;
    orderbookEveryMs: number;
  };
  recovery: RecoveryConfig;
};

export type BookLevel = [price: string, size: string];

export type OrderBookState = {
  symbol: string;
  bids: Map<string, string>;
  asks: Map<string, string>;
  updateId: number;
  seq: number;
  ready: boolean;
};

export type TickerState = {
  symbol: string;
  fields: Record<string, string>;
  cs?: number;
  ts?: number;
  type: "snapshot" | "delta";
};

export type BybitTickerData = {
  symbol: string;
  [key: string]: unknown;
};

export type BybitOrderbookData = {
  s: string;
  b: BookLevel[];
  a: BookLevel[];
  u: number;
  seq: number;
};

export type BybitKline = {
  start: number;
  end: number;
  interval: string;
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
  turnover: string;
  confirm: boolean;
  timestamp: number;
};

export type BybitPushMessage = {
  topic?: string;
  type?: "snapshot" | "delta";
  ts?: number;
  cs?: number;
  cts?: number;
  op?: string;
  success?: boolean;
  ret_msg?: string;
  conn_id?: string;
  req_id?: string;
  data?: unknown;
};
