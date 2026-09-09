import { DEFAULT_BRIEF_SYMBOL, normalizeBriefSymbol } from "./brief";
import { buildKlineLag, type KlineLagSummary } from "./health";
import type { TrackerDb } from "./db";
import type { TrackerConfig } from "./types";

export type BriefPackTicker = {
  symbol: string;
  lastPrice: string | null;
  price24hPcnt: string | null;
  fundingRate: string | null;
  nextFundingTime: string | null;
  openInterest: string | null;
  openInterestValue: string | null;
  recvTs: number | null;
};

export type BriefPackPaper = {
  source: "local" | "http" | null;
  positions: unknown[];
  pendingOrders: unknown[];
  armedAlerts: unknown[];
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
  fundingRate: null,
  nextFundingTime: null,
  openInterest: null,
  openInterestValue: null,
  recvTs: null,
};

/**
 * Agent-drawn MAP zones. No zones store exists in this repo — always [].
 * Do not invent an auto S/D detector here.
 */
export function readMapZones(): unknown[] {
  return [];
}

export type SnapshotBriefPack = {
  ts: number;
  symbols: string[];
  tickers: BriefPackTicker[];
  klineLag: KlineLagSummary;
  paper: BriefPackPaper;
  zones: unknown[];
  meta: {
    db: string;
    klinesDays: number | null;
    paperSource: "local" | "http" | null;
  };
};

export type BriefPackStore = Pick<TrackerDb, "listTickers" | "latestKlines">;

export type BriefPackPaperSource = () => BriefPackPaper | Promise<BriefPackPaper | null | undefined> | null | undefined;

export function emptyBriefPack(
  opts: {
    dbPath: string;
    symbols?: string[];
    now?: number;
    klinesDays?: number | null;
    paper?: BriefPackPaper;
    klineLag?: KlineLagSummary;
  },
): SnapshotBriefPack {
  const symbols = opts.symbols?.length ? opts.symbols : [DEFAULT_BRIEF_SYMBOL];
  const paper = opts.paper ?? EMPTY_BRIEF_PACK_PAPER;
  return {
    ts: opts.now ?? Date.now(),
    symbols,
    tickers: symbols.map((symbol) => ({ symbol, ...EMPTY_BRIEF_PACK_TICKER })),
    klineLag: opts.klineLag ?? {
      ok: true,
      staleMs: 0,
      intervals: [],
      rows: [],
    },
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
  if (!source) return { ...EMPTY_BRIEF_PACK_PAPER, positions: [], pendingOrders: [], armedAlerts: [] };
  try {
    const snap = await source();
    if (!snap) return { ...EMPTY_BRIEF_PACK_PAPER };
    return {
      source: snap.source ?? null,
      positions: Array.isArray(snap.positions) ? snap.positions : [],
      pendingOrders: Array.isArray(snap.pendingOrders) ? snap.pendingOrders : [],
      armedAlerts: Array.isArray(snap.armedAlerts) ? snap.armedAlerts : [],
    };
  } catch {
    return { ...EMPTY_BRIEF_PACK_PAPER };
  }
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
  const paper = filterPaperBySymbol(opts.paper ?? EMPTY_BRIEF_PACK_PAPER, filter);
  return {
    ts: now,
    symbols,
    tickers,
    klineLag,
    paper,
    zones: readMapZones(),
    meta: {
      db: opts.config.dbPath,
      klinesDays,
      paperSource: paper.source,
    },
  };
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

Print one local JSON for Minh's 2h loop (tickers + kline lag + open paper + zones).
Default is every configured feed symbol. Missing data is null / [].
Zones are always [] — MAP draws them; this process does not store S/D.
Paper comes from the local paper SQLite (same process / PAPER_DB_PATH), not Bybit.
`);
  process.exit(2);
}
