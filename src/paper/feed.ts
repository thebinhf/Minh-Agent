import type { PaperFeed, PaperFeedHealth, PaperKlineSnap, PaperTicker } from "./types";

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
        const body = (await res.json()) as { ok?: unknown };
        return { ok: body.ok === true, url };
      } catch {
        return { ok: false, url };
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
      const params = new URLSearchParams({ symbol, interval, limit: "1" });
      const res = await fetch(`${base}/klines?${params}`);
      if (!res.ok) return null;
      const body = (await res.json()) as { klines?: Array<Record<string, unknown>> };
      const row = body.klines?.[0];
      if (!row) return null;
      return {
        interval,
        close: asText(row.close),
        startTs: asTs(row.start_ts),
        confirm: asConfirm(row.confirm),
      };
    },
  };
}
