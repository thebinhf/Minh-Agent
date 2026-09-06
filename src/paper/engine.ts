import { Dec } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperDb } from "./db";
import {
  feeOn,
  fundingAmount,
  furthestTakeProfit,
  liqHit,
  liqPrice,
  marginOn,
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
import type {
  AccountView,
  ClosedMark,
  FundingMark,
  MarkedPosition,
  OpenRequest,
  PaperCloseReason,
  PaperConfig,
  PaperFeed,
  PaperFillSource,
  PaperKlineSnap,
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
  };
}

function sumUnrealized(rows: PaperPositionRow[]): Dec {
  return rows.reduce((acc, row) => acc.add(Dec.from(row.unrealized_pnl ?? "0")), Dec.zero());
}

function sumMargin(rows: PaperPositionRow[]): Dec {
  return rows.reduce((acc, row) => acc.add(Dec.from(row.margin ?? "0")), Dec.zero());
}

function viewAccount(store: PaperDb): AccountView {
  const account = store.getAccount();
  const opens = store.listOpen();
  const unrealized = sumUnrealized(opens);
  const marginUsed = sumMargin(opens);
  const cash = Dec.from(account.cash);
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
    leverageMin: account.leverage_min ?? "1",
    leverageMax: account.leverage_max ?? "25",
    defaultLeverage: account.default_leverage ?? "1",
    mmRate: account.mm_rate ?? "0.005",
    marginUsed: marginUsed.toText(),
    availableCash: cash.sub(marginUsed).toText(),
    openPositions: opens.length,
    updatedTs: account.updated_ts,
  };
}

export function createPaperEngine(opts: {
  store: PaperDb;
  feed: PaperFeed;
  config: PaperConfig;
  universe: PaperUniverse;
}) {
  const { store, feed, config, universe } = opts;
  const symbolSet = new Set(universe.symbols.map((s) => s.toUpperCase()));
  const intervalSet = new Set(universe.intervals.map(String));

  async function requireHealthyFeed(): Promise<void> {
    const health = await feed.health();
    if (!health.ok) {
      throw new PaperReject("feed_unhealthy", "feed", { feed: health });
    }
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

  function feeRateOf(): Dec {
    return Dec.from(store.getAccount().fee_rate ?? "0");
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
    const fee = feeOn(input.qty, input.price, feeRateOf());
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
      store.partialClose({
        id: input.row.id,
        qty: remaining.toText(),
        margin: marginOn(remaining, Dec.from(input.row.entry_price), lev).toText(),
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
    const mark = markPriceOf(ticker);
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

  async function mark(now = Date.now()) {
    await requireHealthyFeed();
    const opens = store.listOpen();
    const stillOpen: MarkedPosition[] = [];
    const closed: ClosedMark[] = [];
    const funding: FundingMark[] = [];
    for (const row of opens) {
      const ticker = await requireTicker(row.symbol, now);
      const funded = store.transaction(() => applyFunding(row, ticker, now));
      if (funded) funding.push(funded);
      const fresh = store.getPosition(row.id);
      if (!fresh || fresh.status === "closed") continue;
      const last = requireLast(ticker);
      const side = fresh.side as PaperSide;
      const stop = Dec.from(fresh.stop_loss);
      const liq = Dec.from(fresh.liq_price ?? "0");
      if (slHit(side, last, stop)) {
        closed.push(store.transaction(() => applyCloseQty({
          row: fresh,
          qty: Dec.from(fresh.qty),
          price: stop,
          reason: "sl",
          source: "sl",
          recvTs: ticker.recvTs,
          now,
          plans: parsePlans(fresh.take_profits_json).map((plan) => ({ ...plan, filled: true })),
        })));
        continue;
      }
      if (liqHit(side, last, liq) && Dec.from(fresh.leverage ?? "1").gt(Dec.from("1"))) {
        closed.push(store.transaction(() => applyCloseQty({
          row: fresh,
          qty: Dec.from(fresh.qty),
          price: liq,
          reason: "liq",
          source: "liq",
          recvTs: ticker.recvTs,
          now,
          plans: parsePlans(fresh.take_profits_json).map((plan) => ({ ...plan, filled: true })),
        })));
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
        const qty = takeProfitCloseQty(
          Dec.from(working.qty_initial ?? working.qty),
          Dec.from(working.qty),
          plan,
          isLast,
        );
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
        if (result.status === "closed") break;
        working = store.getPosition(working.id)!;
      }
      if (hitTp && store.getPosition(row.id)?.status === "closed") continue;
      const latest = store.getPosition(row.id);
      if (!latest || latest.status === "closed") continue;
      const markPx = markPriceOf(ticker);
      const unrealized = pnlAt(side, Dec.from(latest.entry_price), markPx, Dec.from(latest.qty)).toText();
      store.markOpen(latest.id, unrealized, markPx.toText());
      stillOpen.push({
        id: latest.id,
        symbol: latest.symbol,
        markPrice: markPx.toText(),
        unrealizedPnl: unrealized,
        status: "open",
      });
    }
    const account = rewriteEquity(now);
    return {
      mode: "paper" as const,
      account: {
        cash: account.cash,
        equity: account.equity,
        unrealizedPnl: account.unrealizedPnl,
        marginUsed: account.marginUsed,
      },
      positions: stillOpen,
      closed,
      funding,
    };
  }

  return {
    account(): AccountView {
      return viewAccount(store);
    },

    positions(status: PaperStatus | "all" = "open"): PositionView[] {
      return store.listPositions(status).map(viewPosition);
    },

    mark,

    async open(request: OpenRequest, now = Date.now()) {
      await requireHealthyFeed();
      const symbol = request.symbol.trim().toUpperCase();
      if (!symbolSet.has(symbol)) {
        throw new PaperReject("unknown_symbol", "symbol", { symbol, allowed: universe.symbols });
      }
      if (!request.stopLoss?.trim()) {
        throw new PaperReject("missing_stop_loss", "sl_side", { symbol });
      }
      const side = parseSide(request.side);
      const timeframes = normalizeTimeframes(request.timeframes ?? []);
      const mtf = await snapshotMtf(symbol, timeframes);
      await mark(now);
      if (store.openIdOnSymbol(symbol) != null) {
        throw new PaperReject("duplicate_symbol", "duplicate_symbol", { symbol });
      }
      const account = store.getAccount();
      const riskPct = requireBandPct(account, request.riskPct);
      const leverage = requireLeverage(account, request.leverage);
      const ticker = await requireTicker(symbol, now);
      const entry = requireLast(ticker);
      const plans = parseTakeProfits(side, entry, request.takeProfit, request.takeProfits);
      const takeProfit = furthestTakeProfit(plans);
      const sized = sizeFromRisk({
        equity: Dec.from(account.equity),
        riskPct,
        side,
        entry,
        stopLoss: Dec.from(request.stopLoss.trim()),
        takeProfit: Dec.from(takeProfit),
      });
      assertOptionalMinRr(account, sized.rr);
      const openFee = feeOn(sized.qty, sized.entry, Dec.from(account.fee_rate ?? "0"));
      const margin = marginOn(sized.qty, sized.entry, leverage);
      const used = sumMargin(store.listOpen());
      if (Dec.from(account.cash).sub(used).sub(margin).sub(openFee).isNeg()) {
        throw new PaperReject("insufficient_margin", "leverage", {
          cash: account.cash,
          margin: margin.toText(),
          openFee: openFee.toText(),
          marginUsed: used.toText(),
        });
      }
      const liq = liqPrice(side, sized.entry, leverage, Dec.from(account.mm_rate ?? "0"));
      const opened = store.transaction(() => {
        store.updateAccount(Dec.from(store.getAccount().cash).sub(openFee).toText(), account.equity, now);
        const id = store.insertPosition({
          symbol,
          side,
          qty: sized.qty.toText(),
          riskPct: sized.riskPct.toText(),
          entryPrice: sized.entry.toText(),
          stopLoss: sized.stopLoss.toText(),
          takeProfit,
          riskQuote: sized.riskQuote.toText(),
          rewardQuote: sized.rewardQuote.toText(),
          rr: sized.rr.toText(),
          timeframes: JSON.stringify(timeframes),
          mtfJson: JSON.stringify(mtf),
          openedTs: now,
          unrealizedPnl: "0",
          markPrice: sized.entry.toText(),
          fillRecvTs: ticker.recvTs ?? now,
          note: request.note?.trim() ? request.note.trim() : null,
          leverage: leverage.toText(),
          qtyInitial: sized.qty.toText(),
          margin: margin.toText(),
          liqPrice: liq.toText(),
          takeProfitsJson: JSON.stringify(plans),
          openFee: openFee.toText(),
        });
        store.insertFill({
          positionId: id,
          kind: "open",
          symbol,
          side,
          qty: sized.qty.toText(),
          price: sized.entry.toText(),
          source: "last",
          recvTs: ticker.recvTs,
          ts: now,
        });
        rewriteEquity(now);
        return store.getPosition(id)!;
      });
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
      const price = requireLast(ticker);
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
