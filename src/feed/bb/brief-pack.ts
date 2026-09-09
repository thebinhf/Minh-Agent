import { DEFAULT_BRIEF_SYMBOL, normalizeBriefSymbol } from "./brief";
import {
  buildFeedHealth,
  buildKlineLag,
  tradingGates,
  type FeedHealthStore,
  type KlineLagSummary,
  type TradingGates,
} from "./health";
import type { TrackerDb } from "./db";
import type { TrackerConfig } from "./types";

export type BriefPackTicker = {
  symbol: string;
  lastPrice: string | null;
  price24hPcnt: string | null;
  highPrice24h: string | null;
  lowPrice24h: string | null;
  volume24h: string | null;
  turnover24h: string | null;
  fundingRate: string | null;
  nextFundingTime: string | null;
  openInterest: string | null;
  openInterestValue: string | null;
  recvTs: number | null;
};

/** `http://127.0.0.1:43181` | `sqlite:<path>` | null */
export type BriefPackPaperSourceLabel = string | null;

export type BriefPackPosition = {
  id: number | null;
  symbol: string | null;
  side: string | null;
  entryPrice: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  qty: string | null;
  leverage: string | null;
  riskPct: string | null;
  status: string | null;
  openedTs: number | null;
};

export type BriefPackPendingOrder = {
  id: number | null;
  symbol: string | null;
  side: string | null;
  type: string | null;
  limitPrice: string | null;
  qty: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  status: string | null;
  createdTs: number | null;
};

export type BriefPackArmedAlert = {
  id: number | null;
  symbol: string | null;
  op: string | null;
  price: string | null;
  status: string | null;
  createdTs: number | null;
};

export type BriefPackPaper = {
  source: BriefPackPaperSourceLabel;
  positions: BriefPackPosition[];
  pendingOrders: BriefPackPendingOrder[];
  armedAlerts: BriefPackArmedAlert[];
};

export const EMPTY_BRIEF_PACK_PAPER: BriefPackPaper = {
  source: null,
  positions: [],
  pendingOrders: [],
  armedAlerts: [],
};

export const EMPTY_BRIEF_PACK_TICKER: Omit<BriefPackTicker, "symbol"> = {
  lastPrice: null,
  price24hPcnt: null,
  highPrice24h: null,
  lowPrice24h: null,
  volume24h: null,
  turnover24h: null,
  fundingRate: null,
  nextFundingTime: null,
  openInterest: null,
  openInterestValue: null,
  recvTs: null,
};

export const DEFAULT_PAPER_HTTP_SOURCE = "http://127.0.0.1:43181";

export function sqlitePaperSource(dbPath: string): string {
  const path = dbPath.trim();
  return path.startsWith("sqlite:") ? path : `sqlite:${path}`;
}

export function httpPaperSource(url: string | null | undefined): string {
  const trimmed = url?.trim().replace(/\/$/, "") ?? "";
  return trimmed || DEFAULT_PAPER_HTTP_SOURCE;
}

/**
 * Agent-drawn MAP zones stay empty on the pack.
 * Suggest-only cards live on GET /zones — this pack does not auto-detect or auto-arm.
 */
export function readMapZones(): unknown[] {
  return [];
}

export const EMPTY_TRADING_GATES: TradingGates = {
  tradingAllowed: true,
  reasons: [],
};

export type SnapshotBriefPack = {
  ts: number;
  symbols: string[];
  tickers: BriefPackTicker[];
  klineLag: KlineLagSummary;
  /** Additive kill-switch. `klineLag` on this payload stays the lag source of truth. */
  gates: TradingGates;
  paper: BriefPackPaper;
  zones: unknown[];
  meta: {
    db: string;
    klinesDays: number | null;
    paperSource: BriefPackPaperSourceLabel;
  };
};

export type BriefPackStore = Pick<TrackerDb, "listTickers" | "latestKlines"> & Partial<Pick<TrackerDb, "getHealth">>;

export type BriefPackPaperSource = () => BriefPackPaper | Promise<BriefPackPaper | null | undefined> | null | undefined;

export function emptyBriefPack(
  opts: {
    dbPath: string;
    symbols?: string[];
    now?: number;
    klinesDays?: number | null;
    paper?: BriefPackPaper;
    klineLag?: KlineLagSummary;
    gates?: TradingGates;
  },
): SnapshotBriefPack {
  const symbols = opts.symbols?.length ? opts.symbols : [DEFAULT_BRIEF_SYMBOL];
  const paper = projectBriefPackPaper(opts.paper ?? EMPTY_BRIEF_PACK_PAPER);
  const klineLag = opts.klineLag ?? {
    ok: true,
    staleMs: 0,
    intervals: [],
    rows: [],
  };
  return {
    ts: opts.now ?? Date.now(),
    symbols,
    tickers: symbols.map((symbol) => ({ symbol, ...EMPTY_BRIEF_PACK_TICKER })),
    klineLag,
    gates: opts.gates ?? tradingGates({ klineLagOk: klineLag.ok }),
    paper,
    zones: readMapZones(),
    meta: {
      db: opts.dbPath,
      klinesDays: opts.klinesDays ?? null,
      paperSource: paper.source,
    },
  };
}

export function parseBriefPackArgs(argv: string[]): { symbol?: string } {
  if (argv.includes("--help") || argv.includes("-h")) briefPackUsage();
  const positional = argv.find((arg) => !arg.startsWith("-"));
  if (!positional?.trim()) return {};
  return { symbol: normalizeBriefSymbol(positional) };
}

export async function resolvePaperDesk(source?: BriefPackPaperSource): Promise<BriefPackPaper> {
  if (!source) return { ...EMPTY_BRIEF_PACK_PAPER };
  try {
    const snap = await source();
    return projectBriefPackPaper(snap);
  } catch {
    return { ...EMPTY_BRIEF_PACK_PAPER };
  }
}

export function projectBriefPackPaper(snap: BriefPackPaper | null | undefined): BriefPackPaper {
  if (!snap) return { ...EMPTY_BRIEF_PACK_PAPER };
  return {
    source: normalizePaperSource(snap.source),
    positions: asArray(snap.positions).map(projectPosition),
    pendingOrders: asArray(snap.pendingOrders).map(projectPendingOrder),
    armedAlerts: asArray(snap.armedAlerts).map(projectArmedAlert),
  };
}

function normalizePaperSource(raw: unknown): BriefPackPaperSourceLabel {
  if (raw == null || raw === "") return null;
  const source = String(raw).trim();
  return source || null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function projectPosition(row: unknown): BriefPackPosition {
  const o = asRecord(row);
  return {
    id: numberField(o.id),
    symbol: textField(o.symbol),
    side: textField(o.side),
    entryPrice: textField(o.entryPrice),
    stopLoss: textField(o.stopLoss),
    takeProfit: textField(o.takeProfit),
    qty: textField(o.qty),
    leverage: textField(o.leverage),
    riskPct: textField(o.riskPct),
    status: textField(o.status),
    openedTs: numberField(o.openedTs),
  };
}

function projectPendingOrder(row: unknown): BriefPackPendingOrder {
  const o = asRecord(row);
  return {
    id: numberField(o.id),
    symbol: textField(o.symbol),
    side: textField(o.side),
    type: textField(o.type),
    limitPrice: textField(o.limitPrice),
    qty: textField(o.qty),
    stopLoss: textField(o.stopLoss),
    takeProfit: textField(o.takeProfit),
    status: textField(o.status),
    createdTs: numberField(o.createdTs),
  };
}

function projectArmedAlert(row: unknown): BriefPackArmedAlert {
  const o = asRecord(row);
  return {
    id: numberField(o.id),
    symbol: textField(o.symbol),
    op: textField(o.op),
    price: textField(o.price),
    status: textField(o.status),
    createdTs: numberField(o.createdTs),
  };
}

function filterPaperBySymbol(paper: BriefPackPaper, symbol: string | undefined): BriefPackPaper {
  if (!symbol) return paper;
  const match = (row: unknown) => {
    if (!row || typeof row !== "object") return false;
    return String((row as { symbol?: unknown }).symbol ?? "").toUpperCase() === symbol;
  };
  return {
    source: paper.source,
    positions: paper.positions.filter(match),
    pendingOrders: paper.pendingOrders.filter(match),
    armedAlerts: paper.armedAlerts.filter(match),
  };
}

/**
 * One JSON for Minh's 2h MAP loop: tickers + kline lag + open paper desk.
 * Missing data is null / []. Zones stay [] until a store exists.
 */
export function buildBriefPack(
  store: BriefPackStore,
  opts: {
    config: Partial<TrackerConfig> & { dbPath: string };
    symbol?: string | null;
    now?: number;
    paper?: BriefPackPaper;
  },
): SnapshotBriefPack {
  const filter = opts.symbol?.trim() ? normalizeBriefSymbol(opts.symbol) : undefined;
  const now = opts.now ?? Date.now();
  const configured = (opts.config.symbols?.length ? [...opts.config.symbols] : [DEFAULT_BRIEF_SYMBOL])
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  const symbols = filter ? [filter] : configured;
  const klinesDays = opts.config.retention?.klinesDays ?? null;
  const klineLag = tryRead(
    () => buildKlineLag(store, { config: opts.config, now, symbol: filter }),
    {
      ok: true,
      staleMs: 0,
      intervals: [],
      rows: [],
    },
  );
  const tickers = symbols.map((symbol) => readTicker(store, symbol));
  const paper = filterPaperBySymbol(projectBriefPackPaper(opts.paper ?? EMPTY_BRIEF_PACK_PAPER), filter);
  const feedOk = readFeedOk(store, opts.config, now);
  return {
    ts: now,
    symbols,
    tickers,
    klineLag,
    gates: tradingGates({ feedOk, klineLagOk: klineLag.ok }),
    paper,
    zones: readMapZones(),
    meta: {
      db: opts.config.dbPath,
      klinesDays,
      paperSource: paper.source,
    },
  };
}

function readFeedOk(
  store: BriefPackStore,
  config: Partial<TrackerConfig>,
  now: number,
): boolean | null {
  if (typeof store.getHealth !== "function") return null;
  const health = tryRead(
    () => buildFeedHealth(store as FeedHealthStore, config, now),
    null as ReturnType<typeof buildFeedHealth> | null,
  );
  return health ? health.ok : null;
}

function readTicker(store: BriefPackStore, symbol: string): BriefPackTicker {
  return tryRead(() => {
    const rows = store.listTickers(symbol) as Array<Record<string, unknown>> | unknown;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { symbol, ...EMPTY_BRIEF_PACK_TICKER };
    }
    const row = rows[0] ?? {};
    return {
      symbol,
      lastPrice: textField(row.last_price),
      price24hPcnt: textField(row.price_24h_pcnt),
      highPrice24h: textField(row.high_price_24h),
      lowPrice24h: textField(row.low_price_24h),
      volume24h: textField(row.volume_24h),
      turnover24h: textField(row.turnover_24h),
      fundingRate: textField(row.funding_rate),
      nextFundingTime: textField(row.next_funding_time),
      openInterest: textField(row.open_interest),
      openInterestValue: textField(row.open_interest_value),
      recvTs: numberField(row.recv_ts),
    };
  }, { symbol, ...EMPTY_BRIEF_PACK_TICKER });
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

function tryRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function briefPackUsage(): never {
  console.log(`Usage:
  bun run brief-pack [SYMBOL]

Print one local JSON for Minh's 2h loop (tickers + kline lag + gates + open paper + zones).
Default is every configured feed symbol. Missing data is null / [].
gates.tradingAllowed is false when WS/ticker health is down or klineLag.ok is false.
Zones are always [] on this pack — GET /zones is the suggest-only surface; this process does not auto-arm.
Paper comes from the local paper SQLite (same process / PAPER_DB_PATH), not Bybit.
paper.source is http://127.0.0.1:43181 (daemon) or sqlite:<path> (CLI). Missing paper is null.
`);
  process.exit(2);
}
