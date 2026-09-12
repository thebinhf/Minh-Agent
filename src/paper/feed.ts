import type {
  PaperDepth,
  PaperDepthLevel,
  PaperFeed,
  PaperFeedHealth,
  PaperKlineSnap,
  PaperQuantTape,
  PaperTicker,
} from "./types";
import { tapeFromMapItem } from "../agent/quant";

function asText(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function asTs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asConfirm(value: unknown): boolean | null {
  if (value == null || value === "") return null;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return Boolean(value);
}

function mapTicker(row: Record<string, unknown>, fallbackSymbol: string): PaperTicker {
  return {
    symbol: String(row.symbol ?? fallbackSymbol),
    lastPrice: asText(row.lastPrice ?? row.last_price),
    markPrice: asText(row.markPrice ?? row.mark_price),
    recvTs: asTs(row.recvTs ?? row.recv_ts),
    fundingRate: asText(row.fundingRate ?? row.funding_rate),
    nextFundingTime: asTs(row.nextFundingTime ?? row.next_funding_time),
  };
}

/** Read-only client for the local public feed on :43180. Never calls Bybit. */
export function httpFeed(feedUrl: string): PaperFeed {
  const base = feedUrl.replace(/\/$/, "");

  return {
    async health(): Promise<PaperFeedHealth> {
      const url = `${base}/health`;
      try {
        const res = await fetch(url);
        const body = (await res.json()) as {
          ok?: unknown;
          connected?: unknown;
          klineLag?: { ok?: unknown };
        };
        const klineLag = body.klineLag;
        return {
          ok: body.ok === true,
          url,
          connected: body.connected === undefined ? undefined : body.connected === true,
          klineLagOk: klineLag == null ? true : klineLag.ok !== false,
        };
      } catch {
        return { ok: false, url, klineLagOk: true };
      }
    },

    async ticker(symbol: string): Promise<PaperTicker | null> {
      const url = `${base}/tickers?symbol=${encodeURIComponent(symbol)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const body = (await res.json()) as { tickers?: Array<Record<string, unknown>> };
      const row = body.tickers?.[0];
      if (!row) return null;
      return mapTicker(row, symbol);
    },

    async tickers(): Promise<PaperTicker[]> {
      const res = await fetch(`${base}/tickers`);
      if (!res.ok) return [];
      const body = (await res.json()) as { tickers?: Array<Record<string, unknown>> };
      return (body.tickers ?? []).map((row) => mapTicker(row, String(row.symbol ?? "")));
    },

    async lastKline(symbol: string, interval: string): Promise<PaperKlineSnap | null> {
      const params = new URLSearchParams({ symbol, interval, limit: "1", confirm: "true" });
      const res = await fetch(`${base}/klines?${params}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { klines?: Array<Record<string, unknown>> };
      const row = body.klines?.[0];
      if (!row) return null;
      return {
        interval,
        open: asText(row.open),
        high: asText(row.high),
        low: asText(row.low),
        close: asText(row.close),
        volume: asText(row.volume),
        startTs: asTs(row.start_ts),
        confirm: asConfirm(row.confirm),
      };
    },

    async recentKlines(symbol: string, interval: string, limit: number): Promise<PaperKlineSnap[]> {
      const cap = Math.max(1, Math.min(limit, 240));
      const params = new URLSearchParams({
        symbol,
        interval,
        limit: String(cap),
        confirm: "true",
      });
      const res = await fetch(`${base}/klines?${params}`);
      if (!res.ok) return [];
      const body = (await res.json()) as { klines?: Array<Record<string, unknown>> };
      const rows = body.klines ?? [];
      return rows.slice().reverse().map((row) => ({
        interval,
        open: asText(row.open),
        high: asText(row.high),
        low: asText(row.low),
        close: asText(row.close),
        volume: asText(row.volume),
        startTs: asTs(row.start_ts),
        confirm: asConfirm(row.confirm),
      }));
    },

    async quant(symbol: string): Promise<PaperQuantTape | null> {
      const params = new URLSearchParams({ symbol });
      try {
        const res = await fetch(`${base}/map?${params}`);
        if (!res.ok) return null;
        const body = await res.json() as { maps?: unknown[] };
        const item = body.maps?.[0] ?? body;
        return tapeFromMapItem(item);
      } catch {
        return null;
      }
    },

    async shock(symbol: string): Promise<string | null> {
      const params = new URLSearchParams({ symbol });
      try {
        const res = await fetch(`${base}/features?${params}`);
        if (!res.ok) return null;
        const body = await res.json() as { shock?: { reading?: unknown } };
        const reading = body.shock?.reading;
        return typeof reading === "string" && reading.length > 0 ? reading : null;
      } catch {
        return null;
      }
    },

    async depth(symbol: string): Promise<PaperDepth | null> {
      try {
        const res = await fetch(`${base}/depth?symbol=${encodeURIComponent(symbol)}`);
        if (!res.ok) return null;
        const body = await res.json() as {
          symbol?: unknown;
          recvTs?: unknown;
          bestBid?: unknown;
          bestAsk?: unknown;
          bids?: unknown;
          asks?: unknown;
        };
        const bids = mapDepthLevels(body.bids);
        const asks = mapDepthLevels(body.asks);
        if (!bids || !asks) return null;
        return {
          symbol: String(body.symbol ?? symbol),
          recvTs: asTs(body.recvTs),
          bestBid: asText(body.bestBid),
          bestAsk: asText(body.bestAsk),
          bids,
          asks,
        };
      } catch {
        return null;
      }
    },
  };
}

function mapDepthLevels(raw: unknown): PaperDepthLevel[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PaperDepthLevel[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { price?: unknown; size?: unknown };
    const price = asText(rec.price);
    const size = asText(rec.size);
    if (price == null || size == null) continue;
    out.push({ price, size });
  }
  return out;
}
