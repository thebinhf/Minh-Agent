import { Dec } from "./decimal";
import { PaperReject } from "./errors";
import { parseZoneId, rejectIfEntryBlocked } from "./gates";
import { paperMetrics } from "./metrics";
import type { PaperDb } from "./db";
import {
  estimateCrossLiq,
  feeOn,
  fundingAmount,
  furthestTakeProfit,
  liqHit,
  liqPrice,
  maintenanceMargin,
  marginOn,
  parseMarginMode,
  parseTakeProfits,
  requireLeverage,
  takeProfitCloseQty,
} from "./phase2";
import {
  assertOptionalMinRr,
  normalizeTimeframes,
  parseSide,
  pnlAt,
  requireBandPct,
  sizeFromRisk,
  slHit,
  tpHit,
} from "./risk";
import {
  assertMarketQty,
  defaultCatalog,
  floorCloseQty,
  floorQty,
  requireInstrument,
  snapLeverage,
  snapPrice,
  type InstrumentCatalog,
} from "./venue";
import {
  alertHit,
  assertInvalidateSide,
  limitFillHit,
  limitInvalidated,
  limitPostOnlyOk,
  parseAlertOp,
  parseOco,
  parsePostOnly,
} from "./watch";
import type {
  AccountView,
  AlertRequest,
  AlertStatus,
  AlertView,
  ClosedMark,
  EventView,
  FundingMark,
  LimitRequest,
  MarkedPosition,
  OpenRequest,
  OrderStatus,
  OrderView,
  PaperAlertRow,
  PaperCloseReason,
  PaperConfig,
  PaperEventRow,
  PaperFeed,
  PaperFillSource,
  PaperKlineSnap,
  PaperOrderRow,
  PaperPositionRow,
  PaperSide,
  PaperStatus,
  PaperTicker,
  PositionView,
  TakeProfitPlan,
} from "./types";

export type PaperUniverse = {
  symbols: string[];
  intervals: string[];
};

export type PaperEngine = ReturnType<typeof createPaperEngine>;

function parseJsonArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function parseMtf(raw: string | null): Record<string, PaperKlineSnap> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, PaperKlineSnap>;
  } catch {
    return null;
  }
}

function parsePlans(raw: string | null | undefined): TakeProfitPlan[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as TakeProfitPlan[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseEventPayload(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { raw };
  } catch {
    return { raw };
  }
}

export function viewPosition(row: PaperPositionRow): PositionView {
  const plans = parsePlans(row.take_profits_json);
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    qty: row.qty,
    riskPct: row.risk_pct,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    riskQuote: row.risk_quote,
    rewardQuote: row.reward_quote,
    rr: row.rr,
    timeframes: parseJsonArray(row.timeframes),
    mtfJson: parseMtf(row.mtf_json),
    status: row.status,
    openedTs: row.opened_ts,
    closedTs: row.closed_ts,
    closePrice: row.close_price,
    closeReason: row.close_reason,
    realizedPnl: row.realized_pnl,
    unrealizedPnl: row.unrealized_pnl ?? "0",
    markPrice: row.mark_price,
    fillSource: row.fill_source,
    fillRecvTs: row.fill_recv_ts,
    note: row.note,
    leverage: row.leverage ?? "1",
    qtyInitial: row.qty_initial ?? row.qty,
    margin: row.margin ?? "0",
    liqPrice: row.liq_price ?? "0",
    takeProfits: plans,
    openFee: row.open_fee ?? "0",
    closeFee: row.close_fee ?? "0",
    lastFundingTs: row.last_funding_ts ?? null,
    zoneId: row.zone_id ?? null,
  };
}

export function viewAlert(row: PaperAlertRow): AlertView {
  return {
    id: row.id,
    symbol: row.symbol,
    op: row.op,
    price: row.price,
    status: row.status,
    once: row.once !== 0,
    note: row.note,
    createdTs: row.created_ts,
    firedTs: row.fired_ts,
    firedLast: row.fired_last,
    channel: row.channel,
    zoneId: row.zone_id ?? null,
  };
}

export function viewOrder(row: PaperOrderRow): OrderView {
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    type: "limit",
    tif: "gtc",
    postOnly: row.post_only !== 0,
    status: row.status,
    limitPrice: row.limit_price,
    qty: row.qty,
    riskPct: row.risk_pct,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    riskQuote: row.risk_quote,
    rewardQuote: row.reward_quote,
    rr: row.rr,
    timeframes: parseJsonArray(row.timeframes),
    leverage: row.leverage,
    takeProfits: parsePlans(row.take_profits_json),
    note: row.note,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
    filledTs: row.filled_ts,
    filledPositionId: row.filled_position_id,
    rejectReason: row.reject_reason,
    oco: row.oco !== 0,
    invalidatePrice: row.invalidate_price ?? row.stop_loss,
    zoneId: row.zone_id ?? null,
  };
}

export function viewEvent(row: PaperEventRow): EventView {
  const payload = parseEventPayload(row.payload_json);
  const zoneId = row.zone_id ?? parseZoneId(payload.zoneId);
  return {
    id: row.id,
    kind: row.kind,
    symbol: row.symbol,
    payload,
    ts: row.ts,
    zoneId,
  };
}

function sumUnrealized(rows: PaperPositionRow[]): Dec {
  return rows.reduce((acc, row) => acc.add(Dec.from(row.unrealized_pnl ?? "0")), Dec.zero());
}

function sumMargin(rows: PaperPositionRow[]): Dec {
  return rows.reduce((acc, row) => acc.add(Dec.from(row.margin ?? "0")), Dec.zero());
}

function positionMm(row: PaperPositionRow, mmRate: Dec, feeRate: Dec): Dec {
  const mark = Dec.from(row.mark_price || row.entry_price);
  return maintenanceMargin(Dec.from(row.qty), mark, mmRate, {
    side: row.side,
    feeRate,
    entry: Dec.from(row.entry_price),
    leverage: Dec.from(row.leverage ?? "1"),
  });
}

function sumMm(rows: PaperPositionRow[], mmRate: Dec, feeRate: Dec): Dec {
  return rows.reduce((acc, row) => acc.add(positionMm(row, mmRate, feeRate)), Dec.zero());
}

function viewAccount(store: PaperDb): AccountView {
  const account = store.getAccount();
  const opens = store.listOpen();
  const unrealized = sumUnrealized(opens);
  const marginUsed = sumMargin(opens);
  const cash = Dec.from(account.cash);
  const equity = cash.add(unrealized);
  const marginMode = parseMarginMode(account.margin_mode);
  const feeRate = Dec.from(account.fee_rate ?? "0");
  const mmRate = Dec.from(account.mm_rate ?? "0.005");
  const totalMm = sumMm(opens, mmRate, feeRate);
  const available = (marginMode === "cross" ? equity : cash).sub(marginUsed);
  return {
    mode: "paper",
    id: account.id,
    name: account.name,
    quote: account.quote,
    cash: account.cash,
    equity: account.equity,
    unrealizedPnl: unrealized.toText(),
    startingCash: account.starting_cash,
    riskPctMin: account.risk_pct_min,
    riskPctMax: account.risk_pct_max,
    defaultRiskPct: account.default_risk_pct,
    minRr: account.min_rr,
    feeRate: account.fee_rate ?? "0",
    makerFeeRate: account.maker_fee_rate ?? "0",
    leverageMin: account.leverage_min ?? "1",
    leverageMax: account.leverage_max ?? "25",
    defaultLeverage: account.default_leverage ?? "1",
    mmRate: account.mm_rate ?? "0.005",
    marginMode,
    marginUsed: marginUsed.toText(),
    marginBalance: equity.toText(),
    totalMm: totalMm.toText(),
    availableCash: available.toText(),
    openPositions: opens.length,
    pendingOrders: store.countPendingOrders(),
    armedAlerts: store.countArmedAlerts(),
    updatedTs: account.updated_ts,
  };
}

export function createPaperEngine(opts: {
  store: PaperDb;
  feed: PaperFeed;
  config: PaperConfig;
  universe: PaperUniverse;
  instruments?: InstrumentCatalog;
  onEvent?: (event: EventView) => void;
}) {
  const { store, feed, config, universe, onEvent } = opts;
  const instruments = opts.instruments ?? defaultCatalog();
  const symbolSet = new Set(universe.symbols.map((s) => s.toUpperCase()));
  const intervalSet = new Set(universe.intervals.map(String));

  async function requireHealthyFeed(): Promise<void> {
    const health = await feed.health();
    if (!health.ok) {
      throw new PaperReject("feed_unhealthy", "feed", { feed: health });
    }
  }

  async function requireEntryAllowed(): Promise<void> {
    rejectIfEntryBlocked(await feed.health());
  }

  function requireFresh(ticker: PaperTicker, now: number): void {
    if (ticker.recvTs == null) {
      throw new PaperReject("stale_ticker", "stale", { recvTs: null, staleMs: config.staleMs });
    }
    if (now - ticker.recvTs > config.staleMs) {
      throw new PaperReject("stale_ticker", "stale", {
        recvTs: ticker.recvTs,
        ageMs: now - ticker.recvTs,
        staleMs: config.staleMs,
      });
    }
  }

  async function requireTicker(symbol: string, now: number): Promise<PaperTicker> {
    const ticker = await feed.ticker(symbol);
    if (!ticker) {
      throw new PaperReject("missing_last_price", "stale", { symbol });
    }
    requireFresh(ticker, now);
    return ticker;
  }

  function requireLast(ticker: PaperTicker): Dec {
    if (ticker.lastPrice == null || ticker.lastPrice === "") {
      throw new PaperReject("missing_last_price", "stale", { symbol: ticker.symbol });
    }
    return Dec.from(ticker.lastPrice);
  }

  function markPriceOf(ticker: PaperTicker): Dec {
    const raw = ticker.markPrice && ticker.markPrice !== "" ? ticker.markPrice : ticker.lastPrice;
    if (raw == null || raw === "") {
      throw new PaperReject("missing_mark_price", "stale", { symbol: ticker.symbol });
    }
    return Dec.from(raw);
  }

  async function snapshotMtf(symbol: string, timeframes: string[]): Promise<Record<string, PaperKlineSnap>> {
    if (timeframes.length < 2) {
      throw new PaperReject("mtf_required", "mtf", { timeframes });
    }
    const snap: Record<string, PaperKlineSnap> = {};
    for (const interval of timeframes) {
      if (!intervalSet.has(interval)) {
        throw new PaperReject("mtf_unknown_interval", "mtf", {
          interval,
          allowed: universe.intervals,
        });
      }
      const kline = await feed.lastKline(symbol, interval);
      if (!kline) {
        throw new PaperReject("mtf_incomplete", "mtf", { symbol, interval });
      }
      snap[interval] = kline;
    }
    return snap;
  }

  function rewriteEquity(now: number): AccountView {
    const account = store.getAccount();
    const opens = store.listOpen();
    const unrealized = sumUnrealized(opens);
    const equity = Dec.from(account.cash).add(unrealized).toText();
    store.updateAccount(account.cash, equity, now);
    return viewAccount(store);
  }

  function takerFeeRate(): Dec {
    return Dec.from(store.getAccount().fee_rate ?? "0");
  }

  function makerFeeRate(): Dec {
    return Dec.from(store.getAccount().maker_fee_rate ?? "0");
  }

  function emit(
    kind: string,
    symbol: string | null,
    payload: Record<string, unknown>,
    now: number,
    zoneId: string | null = null,
  ): EventView {
    const resolved = zoneId ?? parseZoneId(payload.zoneId);
    const body = resolved == null ? payload : { ...payload, zoneId: resolved };
    const id = store.insertEvent({
      kind,
      symbol,
      payloadJson: JSON.stringify(body),
      ts: now,
      zoneId: resolved,
    });
    const view = { id, kind, symbol, payload: body, ts: now, zoneId: resolved };
    onEvent?.(view);
    return view;
  }

  function requireKnownSymbol(raw: string): string {
    const symbol = raw.trim().toUpperCase();
    if (!symbolSet.has(symbol)) {
      throw new PaperReject("unknown_symbol", "symbol", { symbol, allowed: universe.symbols });
    }
    return symbol;
  }

  function assertFlatSymbol(symbol: string): void {
    const openId = store.openIdOnSymbol(symbol);
    if (openId != null) {
      throw new PaperReject("duplicate_symbol", "duplicate_symbol", { symbol, openId });
    }
    const pendingId = store.pendingOrderIdOnSymbol(symbol);
    if (pendingId != null) {
      throw new PaperReject("duplicate_symbol", "duplicate_symbol", { symbol, pendingOrderId: pendingId });
    }
  }

  function applyCloseQty(input: {
    row: PaperPositionRow;
    qty: Dec;
    price: Dec;
    reason: PaperCloseReason;
    source: PaperFillSource;
    recvTs: number | null;
    now: number;
    plans: TakeProfitPlan[];
  }): ClosedMark {
    const pnl = pnlAt(input.row.side, Dec.from(input.row.entry_price), input.price, input.qty);
    const fee = feeOn(input.qty, input.price, takerFeeRate());
    const realized = Dec.from(input.row.realized_pnl ?? "0").add(pnl);
    const closeFee = Dec.from(input.row.close_fee ?? "0").add(fee);
    const remaining = Dec.from(input.row.qty).sub(input.qty);
    const full = !remaining.isPos();
    store.insertFill({
      positionId: input.row.id,
      kind: "close",
      symbol: input.row.symbol,
      side: input.row.side,
      qty: input.qty.toText(),
      price: input.price.toText(),
      source: input.source,
      recvTs: input.recvTs,
      ts: input.now,
    });
    const account = store.getAccount();
    const cash = Dec.from(account.cash).add(pnl).sub(fee).toText();
    store.updateAccount(cash, cash, input.now);
    if (full) {
      const changed = store.closePosition({
        id: input.row.id,
        closedTs: input.now,
        closePrice: input.price.toText(),
        closeReason: input.reason,
        realizedPnl: realized.toText(),
        closeFee: closeFee.toText(),
        takeProfitsJson: JSON.stringify(input.plans),
      });
      if (changed === 0) {
        throw new PaperReject("already_closed", "status", { id: input.row.id });
      }
    } else {
      const lev = Dec.from(input.row.leverage ?? "1");
      const entryPx = Dec.from(input.row.entry_price);
      const mode = parseMarginMode(store.getAccount().margin_mode);
      const notional = mode === "cross"
        ? Dec.from(input.row.mark_price || input.row.entry_price)
        : entryPx;
      store.partialClose({
        id: input.row.id,
        qty: remaining.toText(),
        margin: marginOn(remaining, notional, lev, {
          side: input.row.side,
          feeRate: takerFeeRate(),
          entry: entryPx,
        }).toText(),
        realizedPnl: realized.toText(),
        closeFee: closeFee.toText(),
        takeProfitsJson: JSON.stringify(input.plans),
        markPrice: input.price.toText(),
        unrealizedPnl: "0",
      });
    }
    rewriteEquity(input.now);
    return {
      id: input.row.id,
      symbol: input.row.symbol,
      status: full ? "closed" : "open",
      closeReason: input.reason,
      closePrice: input.price.toText(),
      realizedPnl: pnl.toText(),
      closedTs: input.now,
      qty: input.qty.toText(),
      remainingQty: full ? "0" : remaining.toText(),
      partial: !full,
    };
  }

  function applyFunding(row: PaperPositionRow, ticker: PaperTicker, now: number): FundingMark | null {
    if (ticker.nextFundingTime == null || ticker.fundingRate == null || ticker.fundingRate === "") return null;
    if (now < ticker.nextFundingTime) return null;
    if (row.last_funding_ts != null && row.last_funding_ts === ticker.nextFundingTime) return null;
    const mark = snapPrice(markPriceOf(ticker), requireInstrument(row.symbol, instruments));
    const amount = fundingAmount(row.side, Dec.from(row.qty), mark, Dec.from(ticker.fundingRate));
    const account = store.getAccount();
    store.updateAccount(Dec.from(account.cash).add(amount).toText(), account.equity, now);
    store.insertFunding({
      positionId: row.id,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      markPrice: mark.toText(),
      rate: ticker.fundingRate,
      amount: amount.toText(),
      fundingTime: ticker.nextFundingTime,
      ts: now,
    });
    store.setLastFunding(row.id, ticker.nextFundingTime);
    return {
      positionId: row.id,
      symbol: row.symbol,
      rate: ticker.fundingRate,
      amount: amount.toText(),
      fundingTime: ticker.nextFundingTime,
    };
  }

  async function tickerMap(symbols: string[], now: number): Promise<Map<string, PaperTicker>> {
    const map = new Map<string, PaperTicker>();
    let batched: PaperTicker[] = [];
    try {
      batched = await feed.tickers();
    } catch {
      batched = [];
    }
    for (const ticker of batched) {
      const symbol = ticker.symbol?.toUpperCase();
      if (!symbol) continue;
      try {
        requireFresh(ticker, now);
        requireLast(ticker);
        map.set(symbol, { ...ticker, symbol });
      } catch {
        // skip stale batch row; per-symbol fallback below
      }
    }
    for (const symbol of symbols) {
      if (map.has(symbol)) continue;
      try {
        map.set(symbol, await requireTicker(symbol, now));
      } catch {
        // evaluate skips symbols without a fresh print
      }
    }
    return map;
  }

  function assertMargin(margin: Dec, openFee: Dec): void {
    const account = store.getAccount();
    const opens = store.listOpen();
    const used = sumMargin(opens);
    const marginMode = parseMarginMode(account.margin_mode);
    const availBase = marginMode === "cross"
      ? Dec.from(account.cash).add(sumUnrealized(opens))
      : Dec.from(account.cash);
    if (availBase.sub(used).sub(margin).sub(openFee).isNeg()) {
      throw new PaperReject("insufficient_margin", "leverage", {
        cash: account.cash,
        margin: margin.toText(),
        openFee: openFee.toText(),
        marginUsed: used.toText(),
        marginMode,
      });
    }
  }

  type OpenPlan = {
    symbol: string;
    side: PaperSide;
    qty: Dec;
    riskPct: Dec;
    entry: Dec;
    stopLoss: Dec;
    takeProfit: string;
    riskQuote: Dec;
    rewardQuote: Dec;
    rr: Dec;
    timeframes: string[];
    mtf: Record<string, PaperKlineSnap>;
    leverage: Dec;
    margin: Dec;
    liq: Dec;
    plans: TakeProfitPlan[];
    openFee: Dec;
    note: string | null;
    fillSource: PaperFillSource;
    fillRecvTs: number;
    zoneId: string | null;
  };

  async function planOpen(
    request: OpenRequest,
    entryRaw: Dec,
    ticker: PaperTicker,
    feeRate: Dec,
    fillSource: PaperFillSource,
  ): Promise<OpenPlan> {
    const symbol = requireKnownSymbol(request.symbol);
    if (!request.stopLoss?.trim()) {
      throw new PaperReject("missing_stop_loss", "sl_side", { symbol });
    }
    const side = parseSide(request.side);
    const timeframes = normalizeTimeframes(request.timeframes ?? []);
    const mtf = await snapshotMtf(symbol, timeframes);
    const account = store.getAccount();
    const spec = requireInstrument(symbol, instruments);
    const riskPct = requireBandPct(account, request.riskPct);
    const leverage = snapLeverage(requireLeverage(account, request.leverage), spec);
    const entry = snapPrice(entryRaw, spec);
    const stopLoss = snapPrice(Dec.from(request.stopLoss.trim()), spec);
    const snappedTps = request.takeProfits?.map((plan) => ({
      ...plan,
      price: snapPrice(Dec.from(String(plan.price)), spec).toText(),
    }));
    const snappedTp = request.takeProfit
      ? snapPrice(Dec.from(request.takeProfit), spec).toText()
      : undefined;
    const plans = parseTakeProfits(side, entry, snappedTp, snappedTps);
    const takeProfit = furthestTakeProfit(plans);
    const sized = sizeFromRisk({
      equity: Dec.from(account.equity),
      riskPct,
      side,
      entry,
      stopLoss,
      takeProfit: Dec.from(takeProfit),
    });
    const qty = floorQty(sized.qty, spec);
    assertMarketQty(spec, qty, entry);
    const riskQuote = sized.stopDist.mul(qty);
    const rewardQuote = sized.rewardDist.mul(qty);
    assertOptionalMinRr(account, sized.rr);
    const openFee = feeOn(qty, entry, feeRate);
    const margin = marginOn(qty, entry, leverage, { side, feeRate, entry });
    assertMargin(margin, openFee);
    const mmRate = Dec.from(account.mm_rate ?? "0");
    const marginMode = parseMarginMode(account.margin_mode);
    let liq = Dec.zero();
    if (marginMode === "isolated") {
      const rawLiq = liqPrice(side, entry, leverage, mmRate);
      liq = leverage.gt(Dec.from("1")) ? snapPrice(rawLiq, spec) : Dec.zero();
    } else {
      const opens = store.listOpen();
      const rawCross = estimateCrossLiq({
        side,
        qty,
        entry,
        leverage,
        mmRate,
        feeRate,
        cash: Dec.from(account.cash),
        othersUnrealized: sumUnrealized(opens),
        othersMm: sumMm(opens, mmRate, feeRate),
      });
      liq = rawCross.isPos() ? snapPrice(rawCross, spec) : Dec.zero();
    }
    return {
      symbol,
      side,
      qty,
      riskPct: sized.riskPct,
      entry,
      stopLoss,
      takeProfit,
      riskQuote,
      rewardQuote,
      rr: sized.rr,
      timeframes,
      mtf,
      leverage,
      margin,
      liq,
      plans,
      openFee,
      note: request.note?.trim() ? request.note.trim() : null,
      fillSource,
      fillRecvTs: ticker.recvTs ?? Date.now(),
      zoneId: parseZoneId(request.zoneId),
    };
  }

  function commitOpen(plan: OpenPlan, now: number): PaperPositionRow {
    const opened = store.transaction(() => {
      store.updateAccount(Dec.from(store.getAccount().cash).sub(plan.openFee).toText(), store.getAccount().equity, now);
      const id = store.insertPosition({
        symbol: plan.symbol,
        side: plan.side,
        qty: plan.qty.toText(),
        riskPct: plan.riskPct.toText(),
        entryPrice: plan.entry.toText(),
        stopLoss: plan.stopLoss.toText(),
        takeProfit: plan.takeProfit,
        riskQuote: plan.riskQuote.toText(),
        rewardQuote: plan.rewardQuote.toText(),
        rr: plan.rr.toText(),
        timeframes: JSON.stringify(plan.timeframes),
        mtfJson: JSON.stringify(plan.mtf),
        openedTs: now,
        unrealizedPnl: "0",
        markPrice: plan.entry.toText(),
        fillSource: plan.fillSource,
        fillRecvTs: plan.fillRecvTs,
        note: plan.note,
        leverage: plan.leverage.toText(),
        qtyInitial: plan.qty.toText(),
        margin: plan.margin.toText(),
        liqPrice: plan.liq.toText(),
        takeProfitsJson: JSON.stringify(plan.plans),
        openFee: plan.openFee.toText(),
        zoneId: plan.zoneId,
      });
      store.insertFill({
        positionId: id,
        kind: "open",
        symbol: plan.symbol,
        side: plan.side,
        qty: plan.qty.toText(),
        price: plan.entry.toText(),
        source: plan.fillSource,
        recvTs: plan.fillRecvTs,
        ts: now,
      });
      rewriteEquity(now);
      return store.getPosition(id)!;
    });
    return opened;
  }

  function fillPendingOrder(order: PaperOrderRow, ticker: PaperTicker, now: number): {
    order: OrderView;
    position: PositionView;
    event: EventView;
  } {
    const spec = requireInstrument(order.symbol, instruments);
    const entry = snapPrice(Dec.from(order.limit_price), spec);
    const side = order.side;
    const qty = Dec.from(order.qty);
    const leverage = Dec.from(order.leverage);
    const feeRate = makerFeeRate();
    const openFee = feeOn(qty, entry, feeRate);
    const margin = marginOn(qty, entry, leverage, { side, feeRate, entry });
    assertMargin(margin, openFee);
    if (store.openIdOnSymbol(order.symbol) != null) {
      throw new PaperReject("duplicate_symbol", "duplicate_symbol", { symbol: order.symbol });
    }
    const mmRate = Dec.from(store.getAccount().mm_rate ?? "0");
    const marginMode = parseMarginMode(store.getAccount().margin_mode);
    let liq = Dec.zero();
    if (marginMode === "isolated") {
      const rawLiq = liqPrice(side, entry, leverage, mmRate);
      liq = leverage.gt(Dec.from("1")) ? snapPrice(rawLiq, spec) : Dec.zero();
    } else {
      const opens = store.listOpen();
      const rawCross = estimateCrossLiq({
        side,
        qty,
        entry,
        leverage,
        mmRate,
        feeRate,
        cash: Dec.from(store.getAccount().cash),
        othersUnrealized: sumUnrealized(opens),
        othersMm: sumMm(opens, mmRate, feeRate),
      });
      liq = rawCross.isPos() ? snapPrice(rawCross, spec) : Dec.zero();
    }
    const opened = commitOpen({
      symbol: order.symbol,
      side,
      qty,
      riskPct: Dec.from(order.risk_pct),
      entry,
      stopLoss: Dec.from(order.stop_loss),
      takeProfit: order.take_profit,
      riskQuote: Dec.from(order.risk_quote),
      rewardQuote: Dec.from(order.reward_quote),
      rr: Dec.from(order.rr),
      timeframes: parseJsonArray(order.timeframes),
      mtf: parseMtf(order.mtf_json) ?? {},
      leverage,
      margin,
      liq,
      plans: parsePlans(order.take_profits_json),
      openFee,
      note: order.note,
      fillSource: "limit",
      fillRecvTs: ticker.recvTs ?? now,
      zoneId: order.zone_id ?? null,
    }, now);
    store.fillOrder(order.id, opened.id, now);
    const event = emit("order.filled", order.symbol, {
      orderId: order.id,
      positionId: opened.id,
      limitPrice: order.limit_price,
      qty: order.qty,
      last: ticker.lastPrice,
    }, now, order.zone_id ?? null);
    return { order: viewOrder(store.getOrder(order.id)!), position: viewPosition(opened), event };
  }

  function fireArmedAlerts(
    tickers: Map<string, PaperTicker>,
    now: number,
  ): { fired: AlertView[]; events: EventView[] } {
    const fired: AlertView[] = [];
    const events: EventView[] = [];
    for (const row of store.listAlerts("armed")) {
      const ticker = tickers.get(row.symbol);
      if (!ticker) continue;
      let last: Dec;
      try {
        last = snapPrice(requireLast(ticker), requireInstrument(row.symbol, instruments));
      } catch {
        continue;
      }
      if (!alertHit(row.op, last, Dec.from(row.price))) continue;
      if (store.fireAlert(row.id, now, last.toText()) === 0) continue;
      const view = viewAlert(store.getAlert(row.id)!);
      fired.push(view);
      events.push(emit("alert.fired", row.symbol, {
        alertId: row.id,
        op: row.op,
        price: row.price,
        last: last.toText(),
        note: row.note,
      }, now, row.zone_id ?? null));
    }
    return { fired, events };
  }

  function fillPendingLimits(
    tickers: Map<string, PaperTicker>,
    now: number,
  ): { filled: OrderView[]; rejected: OrderView[]; invalidated: OrderView[]; events: EventView[] } {
    const filled: OrderView[] = [];
    const rejected: OrderView[] = [];
    const invalidated: OrderView[] = [];
    const events: EventView[] = [];
    for (const row of store.listOrders("pending")) {
      const ticker = tickers.get(row.symbol);
      if (!ticker) continue;
      let last: Dec;
      try {
        last = snapPrice(requireLast(ticker), requireInstrument(row.symbol, instruments));
      } catch {
        continue;
      }
      const invalidate = Dec.from(row.invalidate_price || row.stop_loss);
      if ((row.oco == null || row.oco !== 0) && limitInvalidated(row.side, last, invalidate)) {
        if (store.invalidateOrder(row.id, now) === 0) continue;
        const view = viewOrder(store.getOrder(row.id)!);
        invalidated.push(view);
        events.push(emit("order.invalidated", row.symbol, {
          orderId: row.id,
          invalidate: invalidate.toText(),
          stopLoss: row.stop_loss,
          last: last.toText(),
          cancelCode: "never_touched",
        }, now, row.zone_id ?? null));
        continue;
      }
      if (!limitFillHit(row.side, last, Dec.from(row.limit_price))) continue;
      try {
        const result = fillPendingOrder(row, ticker, now);
        filled.push(result.order);
        events.push(result.event);
      } catch (error) {
        if (!(error instanceof PaperReject)) throw error;
        store.rejectOrder(row.id, error.error, now);
        const view = viewOrder(store.getOrder(row.id)!);
        rejected.push(view);
        events.push(emit("order.rejected", row.symbol, {
          orderId: row.id,
          reason: error.error,
          gate: error.gate,
          last: last.toText(),
          ...(error.error === "kline_lag" || error.error === "feed_unhealthy"
            ? { cancelCode: "gates_block" }
            : error.error === "rr_below_min" ? { cancelCode: "rr_fail" } : {}),
        }, now, row.zone_id ?? null));
      }
    }
    return { filled, rejected, invalidated, events };
  }

  async function markOpenPositions(
    tickers: Map<string, PaperTicker>,
    now: number,
  ): Promise<{ stillOpen: MarkedPosition[]; closed: ClosedMark[]; funding: FundingMark[]; events: EventView[] }> {
    const stillOpen: MarkedPosition[] = [];
    const closed: ClosedMark[] = [];
    const funding: FundingMark[] = [];
    const events: EventView[] = [];
    for (const row of store.listOpen()) {
      const ticker = tickers.get(row.symbol);
      if (!ticker) continue;
      const funded = store.transaction(() => applyFunding(row, ticker, now));
      if (funded) funding.push(funded);
      const fresh = store.getPosition(row.id);
      if (!fresh || fresh.status === "closed") continue;
      const spec = requireInstrument(fresh.symbol, instruments);
      const last = snapPrice(requireLast(ticker), spec);
      const side = fresh.side as PaperSide;
      const stop = Dec.from(fresh.stop_loss);
      const liq = Dec.from(fresh.liq_price ?? "0");
      if (slHit(side, last, stop)) {
        const result = store.transaction(() => applyCloseQty({
          row: fresh,
          qty: Dec.from(fresh.qty),
          price: stop,
          reason: "sl",
          source: "sl",
          recvTs: ticker.recvTs,
          now,
          plans: parsePlans(fresh.take_profits_json).map((plan) => ({ ...plan, filled: true })),
        }));
        closed.push(result);
        events.push(emit("position.closed", fresh.symbol, {
          positionId: result.id,
          closeReason: result.closeReason,
          closePrice: result.closePrice,
          realizedPnl: result.realizedPnl,
        }, now, fresh.zone_id ?? null));
        continue;
      }
      if (
        parseMarginMode(store.getAccount().margin_mode) === "isolated"
        && liqHit(side, last, liq)
        && Dec.from(fresh.leverage ?? "1").gt(Dec.from("1"))
      ) {
        const result = store.transaction(() => applyCloseQty({
          row: fresh,
          qty: Dec.from(fresh.qty),
          price: liq,
          reason: "liq",
          source: "liq",
          recvTs: ticker.recvTs,
          now,
          plans: parsePlans(fresh.take_profits_json).map((plan) => ({ ...plan, filled: true })),
        }));
        closed.push(result);
        events.push(emit("position.closed", fresh.symbol, {
          positionId: result.id,
          closeReason: result.closeReason,
          closePrice: result.closePrice,
          realizedPnl: result.realizedPnl,
        }, now, fresh.zone_id ?? null));
        continue;
      }
      const plans = parsePlans(fresh.take_profits_json);
      let working = fresh;
      let hitTp = false;
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]!;
        if (plan.filled) continue;
        if (!tpHit(side, last, Dec.from(plan.price))) continue;
        const unfilled = plans.filter((item) => !item.filled && item !== plan);
        const isLast = unfilled.length === 0;
        plan.filled = true;
        const remaining = Dec.from(working.qty);
        const rawQty = takeProfitCloseQty(
          Dec.from(working.qty_initial ?? working.qty),
          remaining,
          plan,
          isLast,
        );
        const qty = floorCloseQty(rawQty, spec, remaining, isLast);
        if (!qty.isPos()) continue;
        const result = store.transaction(() => applyCloseQty({
          row: working,
          qty,
          price: Dec.from(plan.price),
          reason: "tp",
          source: "tp",
          recvTs: ticker.recvTs,
          now,
          plans,
        }));
        closed.push(result);
        hitTp = true;
        if (result.status === "closed") {
          events.push(emit("position.closed", working.symbol, {
            positionId: result.id,
            closeReason: result.closeReason,
            closePrice: result.closePrice,
            realizedPnl: result.realizedPnl,
            partial: result.partial,
          }, now, working.zone_id ?? null));
          break;
        }
        working = store.getPosition(working.id)!;
      }
      if (hitTp && store.getPosition(row.id)?.status === "closed") continue;
      const latest = store.getPosition(row.id);
      if (!latest || latest.status === "closed") continue;
      const markPx = snapPrice(markPriceOf(ticker), spec);
      const unrealizedDec = pnlAt(side, Dec.from(latest.entry_price), markPx, Dec.from(latest.qty));
      const acc = store.getAccount();
      const mode = parseMarginMode(acc.margin_mode);
      const feeRate = Dec.from(acc.fee_rate ?? "0");
      const lev = Dec.from(latest.leverage ?? "1");
      const qty = Dec.from(latest.qty);
      const entryPx = Dec.from(latest.entry_price);
      const notional = mode === "cross" ? markPx : entryPx;
      const margin = marginOn(qty, notional, lev, { side, feeRate, entry: entryPx });
      let liqOut: string | null = null;
      if (mode === "cross") {
        const others = store.listOpen().filter((item) => item.id !== latest.id);
        const rawCross = estimateCrossLiq({
          side,
          qty,
          entry: entryPx,
          leverage: lev,
          mmRate: Dec.from(acc.mm_rate ?? "0.005"),
          feeRate,
          cash: Dec.from(acc.cash),
          othersUnrealized: sumUnrealized(others),
          othersMm: sumMm(others, Dec.from(acc.mm_rate ?? "0.005"), feeRate),
        });
        liqOut = rawCross.isPos() ? snapPrice(rawCross, spec).toText() : "0";
      }
      store.markOpen(latest.id, unrealizedDec.toText(), markPx.toText(), margin.toText(), liqOut);
      stillOpen.push({
        id: latest.id,
        symbol: latest.symbol,
        markPrice: markPx.toText(),
        unrealizedPnl: unrealizedDec.toText(),
        status: "open",
      });
    }
    if (parseMarginMode(store.getAccount().margin_mode) === "cross") {
      const left = store.listOpen();
      const acc = store.getAccount();
      const feeRate = Dec.from(acc.fee_rate ?? "0");
      const mmRate = Dec.from(acc.mm_rate ?? "0.005");
      const marginBalance = Dec.from(acc.cash).add(sumUnrealized(left));
      const totalMm = sumMm(left, mmRate, feeRate);
      if (left.length > 0 && !marginBalance.gt(totalMm)) {
        stillOpen.length = 0;
        for (const row of left) {
          const price = Dec.from(row.mark_price || row.entry_price);
          const result = store.transaction(() => applyCloseQty({
            row,
            qty: Dec.from(row.qty),
            price,
            reason: "liq",
            source: "liq",
            recvTs: null,
            now,
            plans: parsePlans(row.take_profits_json).map((plan) => ({ ...plan, filled: true })),
          }));
          closed.push(result);
          events.push(emit("position.closed", row.symbol, {
            positionId: result.id,
            closeReason: result.closeReason,
            closePrice: result.closePrice,
            realizedPnl: result.realizedPnl,
          }, now, row.zone_id ?? null));
        }
      }
    }
    return { stillOpen, closed, funding, events };
  }

  async function evaluate(now = Date.now()) {
    await requireHealthyFeed();
    const symbols = [...new Set([
      ...store.listOpen().map((row) => row.symbol),
      ...store.listAlerts("armed").map((row) => row.symbol),
      ...store.listOrders("pending").map((row) => row.symbol),
    ])];
    const tickers = await tickerMap(symbols, now);
    const alerts = fireArmedAlerts(tickers, now);
    const orders = fillPendingLimits(tickers, now);
    const marked = await markOpenPositions(tickers, now);
    const account = rewriteEquity(now);
    return {
      mode: "paper" as const,
      account: {
        cash: account.cash,
        equity: account.equity,
        unrealizedPnl: account.unrealizedPnl,
        marginUsed: account.marginUsed,
        marginMode: account.marginMode,
        marginBalance: account.marginBalance,
        totalMm: account.totalMm,
      },
      positions: marked.stillOpen,
      closed: marked.closed,
      funding: marked.funding,
      alerts: alerts.fired,
      filled: orders.filled,
      rejected: orders.rejected,
      invalidated: orders.invalidated,
      events: [...alerts.events, ...orders.events, ...marked.events],
    };
  }

  return {
    account(): AccountView {
      return viewAccount(store);
    },

    positions(status: PaperStatus | "all" = "open"): PositionView[] {
      return store.listPositions(status).map(viewPosition);
    },

    alerts(status: AlertStatus | "all" = "armed"): AlertView[] {
      return store.listAlerts(status).map(viewAlert);
    },

    orders(status: OrderStatus | "all" = "pending"): OrderView[] {
      return store.listOrders(status).map(viewOrder);
    },

    events(limit = 50): EventView[] {
      return store.listEvents(limit).map(viewEvent);
    },

    eventsBetween(fromTs: number, toTs: number, limit = 500): EventView[] {
      return store.listEventsRange(fromTs, toTs, limit).map(viewEvent);
    },

    metrics(days = 7, now = Date.now()) {
      return paperMetrics({
        eventsBetween: (fromTs, toTs, limit = 500) => store.listEventsRange(fromTs, toTs, limit).map(viewEvent),
        positions: (status) => store.listPositions(status).map(viewPosition),
        account: () => viewAccount(store),
      }, days, now);
    },

    mark: evaluate,
    evaluate,

    async setAlert(request: AlertRequest, now = Date.now()) {
      await requireHealthyFeed();
      const symbol = requireKnownSymbol(request.symbol);
      const op = parseAlertOp(request.op);
      const spec = requireInstrument(symbol, instruments);
      if (!request.price?.trim()) {
        throw new PaperReject("invalid_alert_price", "alert", { price: request.price });
      }
      const price = snapPrice(Dec.from(request.price.trim()), spec);
      const ticker = await requireTicker(symbol, now);
      requireLast(ticker);
      try {
        const id = store.insertAlert({
          symbol,
          op,
          price: price.toText(),
          note: request.note?.trim() ? request.note.trim() : null,
          createdTs: now,
          zoneId: parseZoneId(request.zoneId),
        });
        const armed = store.getAlert(id)!;
        const last = snapPrice(requireLast(ticker), spec);
        if (alertHit(op, last, price)) {
          store.fireAlert(id, now, last.toText());
          const event = emit("alert.fired", symbol, {
            alertId: id,
            op,
            price: price.toText(),
            last: last.toText(),
            note: armed.note,
            immediate: true,
          }, now, parseZoneId(request.zoneId));
          return {
            mode: "paper" as const,
            alert: viewAlert(store.getAlert(id)!),
            event,
          };
        }
        return { mode: "paper" as const, alert: viewAlert(armed) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("UNIQUE") || message.includes("unique")) {
          throw new PaperReject("duplicate_alert", "alert", { symbol, op, price: price.toText() });
        }
        throw error;
      }
    },

    cancelAlert(id: number) {
      const row = store.getAlert(id);
      if (!row) throw new PaperReject("not_found", "id", { id });
      if (row.status !== "armed") {
        throw new PaperReject("alert_not_armed", "status", { id, status: row.status });
      }
      store.cancelAlert(id);
      return { mode: "paper" as const, alert: viewAlert(store.getAlert(id)!) };
    },

    async limit(request: LimitRequest, now = Date.now()) {
      await requireEntryAllowed();
      const symbol = requireKnownSymbol(request.symbol);
      if (!request.limitPrice?.trim()) {
        throw new PaperReject("missing_limit_price", "limit", { symbol });
      }
      await evaluate(now);
      assertFlatSymbol(symbol);
      const ticker = await requireTicker(symbol, now);
      const spec = requireInstrument(symbol, instruments);
      const last = snapPrice(requireLast(ticker), spec);
      const limitPrice = snapPrice(Dec.from(request.limitPrice.trim()), spec);
      const side = parseSide(request.side);
      const postOnly = parsePostOnly(request.postOnly);
      if (postOnly && !limitPostOnlyOk(side, last, limitPrice)) {
        throw new PaperReject("limit_crossed", "limit", {
          side,
          last: last.toText(),
          limitPrice: limitPrice.toText(),
          postOnly: true,
        });
      }
      const plan = await planOpen(request, limitPrice, ticker, makerFeeRate(), "limit");
      const oco = parseOco(request.oco);
      const invalidate = snapPrice(
        Dec.from((request.invalidatePrice ?? plan.stopLoss.toText()).trim()),
        spec,
      );
      assertInvalidateSide(side, plan.entry, invalidate);
      if (oco && limitInvalidated(side, last, invalidate)) {
        throw new PaperReject("already_invalidated", "oco", {
          side,
          last: last.toText(),
          invalidate: invalidate.toText(),
          limitPrice: plan.entry.toText(),
        });
      }
      const id = store.insertOrder({
        symbol: plan.symbol,
        side: plan.side,
        postOnly,
        limitPrice: plan.entry.toText(),
        qty: plan.qty.toText(),
        riskPct: plan.riskPct.toText(),
        stopLoss: plan.stopLoss.toText(),
        takeProfit: plan.takeProfit,
        riskQuote: plan.riskQuote.toText(),
        rewardQuote: plan.rewardQuote.toText(),
        rr: plan.rr.toText(),
        timeframes: JSON.stringify(plan.timeframes),
        mtfJson: JSON.stringify(plan.mtf),
        leverage: plan.leverage.toText(),
        takeProfitsJson: JSON.stringify(plan.plans),
        note: plan.note,
        createdTs: now,
        oco,
        invalidatePrice: invalidate.toText(),
        zoneId: plan.zoneId,
      });
      let order = store.getOrder(id)!;
      let position: PositionView | undefined;
      let event: EventView | undefined;
      if (!postOnly && limitFillHit(side, last, plan.entry)) {
        try {
          const filled = fillPendingOrder(order, ticker, now);
          order = store.getOrder(id)!;
          position = filled.position;
          event = filled.event;
        } catch (error) {
          if (!(error instanceof PaperReject)) throw error;
          store.rejectOrder(id, error.error, now);
          order = store.getOrder(id)!;
          event = emit("order.rejected", symbol, {
            orderId: id,
            reason: error.error,
            gate: error.gate,
            last: last.toText(),
            ...(error.error === "kline_lag" || error.error === "feed_unhealthy"
              ? { cancelCode: "gates_block" }
              : error.error === "rr_below_min" ? { cancelCode: "rr_fail" } : {}),
          }, now, order.zone_id ?? null);
        }
      }
      return {
        mode: "paper" as const,
        order: viewOrder(order),
        ...(position ? { position } : {}),
        ...(event ? { event } : {}),
      };
    },

    cancelOrder(id: number, now = Date.now()) {
      const row = store.getOrder(id);
      if (!row) throw new PaperReject("not_found", "id", { id });
      if (row.status !== "pending") {
        throw new PaperReject("order_not_pending", "status", { id, status: row.status });
      }
      store.cancelOrder(id, now);
      const event = emit("order.cancelled", row.symbol, {
        orderId: id,
        cancelCode: "ops_cancel",
      }, now, row.zone_id ?? null);
      return { mode: "paper" as const, order: viewOrder(store.getOrder(id)!), event };
    },

    async open(request: OpenRequest, now = Date.now()) {
      await requireEntryAllowed();
      const symbol = requireKnownSymbol(request.symbol);
      await evaluate(now);
      assertFlatSymbol(symbol);
      const ticker = await requireTicker(symbol, now);
      const plan = await planOpen(request, requireLast(ticker), ticker, takerFeeRate(), "last");
      const opened = commitOpen(plan, now);
      return { mode: "paper" as const, position: viewPosition(opened) };
    },

    async close(id: number, now = Date.now()) {
      await requireHealthyFeed();
      const row = store.getPosition(id);
      if (!row) {
        throw new PaperReject("not_found", "id", { id });
      }
      if (row.status === "closed") {
        throw new PaperReject("already_closed", "status", { id });
      }
      const ticker = await requireTicker(row.symbol, now);
      const price = snapPrice(requireLast(ticker), requireInstrument(row.symbol, instruments));
      const closed = store.transaction(() => applyCloseQty({
        row,
        qty: Dec.from(row.qty),
        price,
        reason: "manual",
        source: "last",
        recvTs: ticker.recvTs,
        now,
        plans: parsePlans(row.take_profits_json),
      }));
      emit("position.closed", row.symbol, {
        positionId: closed.id,
        closeReason: closed.closeReason,
        closePrice: closed.closePrice,
        realizedPnl: closed.realizedPnl,
      }, now, row.zone_id ?? null);
      return {
        mode: "paper" as const,
        position: {
          id: closed.id,
          status: closed.status,
          closeReason: closed.closeReason,
          closePrice: closed.closePrice,
          realizedPnl: closed.realizedPnl,
          closedTs: closed.closedTs,
          qty: closed.qty,
          remainingQty: closed.remainingQty,
        },
        account: {
          cash: store.getAccount().cash,
          equity: store.getAccount().equity,
        },
      };
    },
  };
}
