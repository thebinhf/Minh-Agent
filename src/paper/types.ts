export type PaperSide = "long" | "short";
export type PaperStatus = "open" | "closed";
export type PaperMarginMode = "isolated" | "cross";
export type PaperCloseReason = "sl" | "tp" | "manual" | "liq";
export type PaperFillKind = "open" | "close";
export type PaperFillSource = "last" | "sl" | "tp" | "liq" | "limit";
export type AlertOp = "above" | "below";
export type AlertStatus = "armed" | "fired" | "cancelled";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected" | "invalidated";

export type TakeProfitPlan = {
  price: string;
  qtyPct: string;
  filled?: boolean;
};

export type PaperAccountSeed = {
  name: string;
  quote: string;
  startingCash: string;
  riskPctMin: string;
  riskPctMax: string;
  defaultRiskPct: string;
  minRr: string | null;
  feeRate: string;
  makerFeeRate: string;
  leverageMin: string;
  leverageMax: string;
  defaultLeverage: string;
  mmRate: string;
  marginMode: PaperMarginMode;
};

export type PaperConfig = {
  httpHost: string;
  httpPort: number;
  dbPath: string;
  feedUrl: string;
  staleMs: number;
  tickMs: number;
  account: PaperAccountSeed;
};

export type PaperTicker = {
  symbol: string;
  lastPrice: string | null;
  markPrice: string | null;
  recvTs: number | null;
  fundingRate: string | null;
  nextFundingTime: number | null;
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
  tickers(): Promise<PaperTicker[]>;
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
  fee_rate: string;
  maker_fee_rate: string;
  leverage_min: string;
  leverage_max: string;
  default_leverage: string;
  mm_rate: string;
  margin_mode: PaperMarginMode;
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
  leverage: string;
  qty_initial: string;
  margin: string;
  liq_price: string;
  take_profits_json: string;
  last_funding_ts: number | null;
  open_fee: string;
  close_fee: string;
};

export type PaperAlertRow = {
  id: number;
  account_id: number;
  symbol: string;
  op: AlertOp;
  price: string;
  status: AlertStatus;
  once: number;
  note: string | null;
  created_ts: number;
  fired_ts: number | null;
  fired_last: string | null;
  channel: string;
};

export type PaperOrderRow = {
  id: number;
  account_id: number;
  symbol: string;
  side: PaperSide;
  type: "limit";
  tif: "gtc";
  post_only: number;
  status: OrderStatus;
  limit_price: string;
  qty: string;
  risk_pct: string;
  stop_loss: string;
  take_profit: string;
  risk_quote: string;
  reward_quote: string;
  rr: string;
  timeframes: string;
  mtf_json: string | null;
  leverage: string;
  take_profits_json: string;
  note: string | null;
  created_ts: number;
  updated_ts: number;
  filled_ts: number | null;
  filled_position_id: number | null;
  reject_reason: string | null;
  oco: number;
  invalidate_price: string;
};

export type PaperEventRow = {
  id: number;
  kind: string;
  symbol: string | null;
  payload_json: string;
  ts: number;
};

export type OpenRequest = {
  symbol: string;
  side: string;
  stopLoss: string;
  takeProfit?: string;
  takeProfits?: TakeProfitPlan[];
  timeframes: string[];
  riskPct?: string;
  leverage?: string;
  note?: string;
};

export type LimitRequest = OpenRequest & {
  limitPrice: string;
  postOnly?: boolean;
  oco?: boolean;
  invalidatePrice?: string;
};

export type AlertRequest = {
  symbol: string;
  op: string;
  price: string;
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
  leverage: string;
  qtyInitial: string;
  margin: string;
  liqPrice: string;
  takeProfits: TakeProfitPlan[];
  openFee: string;
  closeFee: string;
  lastFundingTs: number | null;
};

export type AlertView = {
  id: number;
  symbol: string;
  op: AlertOp;
  price: string;
  status: AlertStatus;
  once: boolean;
  note: string | null;
  createdTs: number;
  firedTs: number | null;
  firedLast: string | null;
  channel: string;
};

export type OrderView = {
  id: number;
  symbol: string;
  side: PaperSide;
  type: "limit";
  tif: "gtc";
  postOnly: boolean;
  status: OrderStatus;
  limitPrice: string;
  qty: string;
  riskPct: string;
  stopLoss: string;
  takeProfit: string;
  riskQuote: string;
  rewardQuote: string;
  rr: string;
  timeframes: string[];
  leverage: string;
  takeProfits: TakeProfitPlan[];
  note: string | null;
  createdTs: number;
  updatedTs: number;
  filledTs: number | null;
  filledPositionId: number | null;
  rejectReason: string | null;
  oco: boolean;
  invalidatePrice: string;
};

export type EventView = {
  id: number;
  kind: string;
  symbol: string | null;
  payload: Record<string, unknown>;
  ts: number;
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
  feeRate: string;
  makerFeeRate: string;
  leverageMin: string;
  leverageMax: string;
  defaultLeverage: string;
  mmRate: string;
  marginMode: PaperMarginMode;
  marginUsed: string;
  marginBalance: string;
  totalMm: string;
  availableCash: string;
  openPositions: number;
  pendingOrders: number;
  armedAlerts: number;
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
  status: "closed" | "open";
  closeReason: PaperCloseReason;
  closePrice: string;
  realizedPnl: string;
  closedTs: number;
  qty: string;
  remainingQty: string;
  partial: boolean;
};

export type FundingMark = {
  positionId: number;
  symbol: string;
  rate: string;
  amount: string;
  fundingTime: number;
};
