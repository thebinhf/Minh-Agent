import { Dec } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperDb } from "./db";
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

export function viewPosition(row: PaperPositionRow): PositionView {
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
  };
}

function sumUnrealized(rows: PaperPositionRow[]): Dec {
  return rows.reduce((acc, row) => acc.add(Dec.from(row.unrealized_pnl ?? "0")), Dec.zero());
}

function viewAccount(store: PaperDb): AccountView {
  const account = store.getAccount();
  const opens = store.listOpen();
  const unrealized = sumUnrealized(opens);
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

  function closeRow(input: {
    row: PaperPositionRow;
    price: Dec;
    reason: PaperCloseReason;
    source: PaperFillSource;
    recvTs: number | null;
    now: number;
  }): ClosedMark {
    const realized = pnlAt(input.row.side, Dec.from(input.row.entry_price), input.price, Dec.from(input.row.qty));
    const changed = store.closePosition({
      id: input.row.id,
      closedTs: input.now,
      closePrice: input.price.toText(),
      closeReason: input.reason,
      realizedPnl: realized.toText(),
    });
    if (changed === 0) {
      throw new PaperReject("already_closed", "status", { id: input.row.id });
    }
    store.insertFill({
      positionId: input.row.id,
      kind: "close",
      symbol: input.row.symbol,
      side: input.row.side,
      qty: input.row.qty,
      price: input.price.toText(),
      source: input.source,
      recvTs: input.recvTs,
      ts: input.now,
    });
    const account = store.getAccount();
    const cash = Dec.from(account.cash).add(realized).toText();
    store.updateAccount(cash, cash, input.now);
    rewriteEquity(input.now);
    return {
      id: input.row.id,
      symbol: input.row.symbol,
      status: "closed",
      closeReason: input.reason,
      closePrice: input.price.toText(),
      realizedPnl: realized.toText(),
      closedTs: input.now,
    };
  }

  async function mark(now = Date.now()) {
    await requireHealthyFeed();
    const opens = store.listOpen();
    const stillOpen: MarkedPosition[] = [];
    const closed: ClosedMark[] = [];
    for (const row of opens) {
      const ticker = await requireTicker(row.symbol, now);
      const last = requireLast(ticker);
      const side = row.side as PaperSide;
      const stop = Dec.from(row.stop_loss);
      const take = Dec.from(row.take_profit);
      if (slHit(side, last, stop)) {
        const result = store.transaction(() => closeRow({
          row,
          price: stop,
          reason: "sl",
          source: "sl",
          recvTs: ticker.recvTs,
          now,
        }));
        closed.push(result);
        continue;
      }
      if (tpHit(side, last, take)) {
        const result = store.transaction(() => closeRow({
          row,
          price: take,
          reason: "tp",
          source: "tp",
          recvTs: ticker.recvTs,
          now,
        }));
        closed.push(result);
        continue;
      }
      const markPx = markPriceOf(ticker);
      const unrealized = pnlAt(side, Dec.from(row.entry_price), markPx, Dec.from(row.qty)).toText();
      store.markOpen(row.id, unrealized, markPx.toText());
      stillOpen.push({
        id: row.id,
        symbol: row.symbol,
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
      },
      positions: stillOpen,
      closed,
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
      if (!request.takeProfit?.trim()) {
        throw new PaperReject("missing_take_profit", "tp_side", { symbol });
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
      const ticker = await requireTicker(symbol, now);
      const entry = requireLast(ticker);
      const sized = sizeFromRisk({
        equity: Dec.from(account.equity),
        riskPct,
        side,
        entry,
        stopLoss: Dec.from(request.stopLoss.trim()),
        takeProfit: Dec.from(request.takeProfit.trim()),
      });
      assertOptionalMinRr(account, sized.rr);
      const opened = store.transaction(() => {
        const id = store.insertPosition({
          symbol,
          side,
          qty: sized.qty.toText(),
          riskPct: sized.riskPct.toText(),
          entryPrice: sized.entry.toText(),
          stopLoss: sized.stopLoss.toText(),
          takeProfit: sized.takeProfit.toText(),
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
      const closed = store.transaction(() => closeRow({
        row,
        price,
        reason: "manual",
        source: "last",
        recvTs: ticker.recvTs,
        now,
      }));
      return {
        mode: "paper" as const,
        position: {
          id: closed.id,
          status: "closed" as const,
          closeReason: closed.closeReason,
          closePrice: closed.closePrice,
          realizedPnl: closed.realizedPnl,
          closedTs: closed.closedTs,
        },
        account: {
          cash: store.getAccount().cash,
          equity: store.getAccount().equity,
        },
      };
    },
  };
}
