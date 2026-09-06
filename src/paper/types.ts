export type PaperSide = "long" | "short";
export type PaperStatus = "open" | "closed";
export type PaperCloseReason = "sl" | "tp" | "manual";
export type PaperFillKind = "open" | "close";
export type PaperFillSource = "last" | "sl" | "tp";

export type PaperAccountSeed = {
  name: string;
  quote: string;
  startingCash: string;
  riskPctMin: string;
  riskPctMax: string;
  defaultRiskPct: string;
  minRr: string | null;
};

export type PaperConfig = {
  httpHost: string;
  httpPort: number;
  dbPath: string;
  feedUrl: string;
  staleMs: number;
  account: PaperAccountSeed;
};

export type PaperTicker = {
  symbol: string;
  lastPrice: string | null;
  markPrice: string | null;
  recvTs: number | null;
};

export type PaperKlineSnap = {
  interval: string;
  close: string | null;
  startTs: number | null;
  confirm: boolean | null;
};

export type PaperFeedHealth = {
  ok: boolean;
  url: string;
};

export type PaperFeed = {
  health(): Promise<PaperFeedHealth>;
  ticker(symbol: string): Promise<PaperTicker | null>;
  lastKline(symbol: string, interval: string): Promise<PaperKlineSnap | null>;
};

export type PaperAccountRow = {
  id: number;
  name: string;
  quote: string;
  cash: string;
  equity: string;
  starting_cash: string;
  risk_pct_min: string;
  risk_pct_max: string;
  default_risk_pct: string;
  min_rr: string | null;
  created_ts: number;
  updated_ts: number;
};

export type PaperPositionRow = {
  id: number;
  account_id: number;
  symbol: string;
  side: PaperSide;
  qty: string;
  risk_pct: string;
  entry_price: string;
  stop_loss: string;
  take_profit: string;
  risk_quote: string;
  reward_quote: string;
  rr: string;
  timeframes: string;
  mtf_json: string | null;
  status: PaperStatus;
  opened_ts: number;
  closed_ts: number | null;
  close_price: string | null;
  close_reason: PaperCloseReason | null;
  realized_pnl: string | null;
  unrealized_pnl: string | null;
  mark_price: string | null;
  fill_source: PaperFillSource;
  fill_recv_ts: number;
  note: string | null;
};

export type OpenRequest = {
  symbol: string;
  side: string;
  stopLoss: string;
  takeProfit: string;
  timeframes: string[];
  riskPct?: string;
  note?: string;
};

export type PositionView = {
  id: number;
  symbol: string;
  side: PaperSide;
  qty: string;
  riskPct: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  riskQuote: string;
  rewardQuote: string;
  rr: string;
  timeframes: string[];
  mtfJson?: Record<string, PaperKlineSnap> | null;
  status: PaperStatus;
  openedTs: number;
  closedTs: number | null;
  closePrice: string | null;
  closeReason: PaperCloseReason | null;
  realizedPnl: string | null;
  unrealizedPnl: string;
  markPrice: string | null;
  fillSource: PaperFillSource;
  fillRecvTs: number;
  note: string | null;
};

export type AccountView = {
  mode: "paper";
  id: number;
  name: string;
  quote: string;
  cash: string;
  equity: string;
  unrealizedPnl: string;
  startingCash: string;
  riskPctMin: string;
  riskPctMax: string;
  defaultRiskPct: string;
  minRr: string | null;
  openPositions: number;
  updatedTs: number;
};

export type MarkedPosition = {
  id: number;
  symbol: string;
  markPrice: string;
  unrealizedPnl: string;
  status: PaperStatus;
};

export type ClosedMark = {
  id: number;
  symbol: string;
  status: "closed";
  closeReason: PaperCloseReason;
  closePrice: string;
  realizedPnl: string;
  closedTs: number;
};
