import { buildBrief } from "./brief";
import { buildConfirm, parseConfirmInterval } from "./confirm";
import { buildMap } from "./map";
import type { TrackerDb } from "./db";
import type { TrackerConfig } from "./types";
import { buildChart, buildDepth, buildHeatmap, buildMarket } from "./view";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

function parseBool(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function mapTicker(row: Record<string, unknown>) {
  return {
    symbol: row.symbol,
    lastPrice: row.last_price,
    markPrice: row.mark_price,
    indexPrice: row.index_price,
    bid1Price: row.bid1_price,
    bid1Size: row.bid1_size,
    ask1Price: row.ask1_price,
    ask1Size: row.ask1_size,
    volume24h: row.volume_24h,
    turnover24h: row.turnover_24h,
    price24hPcnt: row.price_24h_pcnt,
    highPrice24h: row.high_price_24h,
    lowPrice24h: row.low_price_24h,
    fundingRate: row.funding_rate,
    nextFundingTime: row.next_funding_time,
    openInterest: row.open_interest,
    openInterestValue: row.open_interest_value,
    recvTs: row.recv_ts,
    exchTs: row.exch_ts,
    cs: row.cs,
    type: row.type,
    payload: JSON.parse(String(row.payload_json)),
  };
}

function mapBook(row: Record<string, unknown>) {
  return {
    symbol: row.symbol,
    depth: row.depth,
    bids: JSON.parse(String(row.bids_json)),
    asks: JSON.parse(String(row.asks_json)),
    updateId: row.update_id,
    seq: row.seq,
    recvTs: row.recv_ts,
    exchTs: row.exch_ts,
    type: row.type,
  };
}

export function startHttp(config: TrackerConfig, store: TrackerDb) {
  const server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
          },
        });
      }
      if (req.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
      }

      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") {
        const health = store.getHealth() ?? {};
        const now = Date.now();
        const lastMessageTs = Number(health.last_message_ts ?? 0);
        const lastPongTs = Number(health.last_pong_ts ?? 0);
        const connected = Boolean(health.connected);
        const lastMessageAgeMs = lastMessageTs ? now - lastMessageTs : null;
        const tickers = (store.listTickers() as Record<string, unknown>[]).map((row) => ({
          symbol: row.symbol,
          lastPrice: row.last_price,
          ageMs: now - Number(row.recv_ts),
        }));
        return json({
          ok: connected && lastMessageAgeMs !== null && lastMessageAgeMs < 15_000,
          connected,
          endpoint: health.endpoint,
          subscribedTopics: health.subscribed_topics,
          lastMessageAgeMs,
          lastPongAgeMs: lastPongTs ? now - lastPongTs : null,
          reconnectCount: health.reconnect_count,
          lastError: health.last_error,
          tickers,
        });
      }

      if (path === "/tickers") {
        const symbol = url.searchParams.get("symbol") ?? undefined;
        return json({ tickers: (store.listTickers(symbol) as Record<string, unknown>[]).map(mapTicker) });
      }

      if (path === "/orderbooks") {
        const symbol = url.searchParams.get("symbol") ?? undefined;
        return json({ orderbooks: (store.listOrderbooks(symbol) as Record<string, unknown>[]).map(mapBook) });
      }

      if (path === "/klines") {
        const startRaw = url.searchParams.get("start");
        const endRaw = url.searchParams.get("end");
        const start = startRaw ? Number(startRaw) : Number.NaN;
        const end = endRaw ? Number(endRaw) : Number.NaN;
        return json({
          klines: store.listKlines({
            symbol: url.searchParams.get("symbol") ?? undefined,
            interval: url.searchParams.get("interval") ?? undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
            confirm: parseBool(url.searchParams.get("confirm")),
            startTs: Number.isFinite(start) ? start : undefined,
            endTs: Number.isFinite(end) ? end : undefined,
          }),
        });
      }

      if (path === "/kline-stats") {
        return json({
          stats: store.klineStats(
            url.searchParams.get("symbol") ?? undefined,
            url.searchParams.get("interval") ?? undefined,
          ),
        });
      }

      if (path === "/meta") {
        return json({ meta: store.getMeta() });
      }

      if (path === "/brief") {
        return json(buildBrief(store, {
          symbol: url.searchParams.get("symbol"),
          dbPath: config.dbPath,
        }));
      }

      if (path === "/map") {
        return json(buildMap(store, {
          symbol: url.searchParams.get("symbol"),
          dbPath: config.dbPath,
        }));
      }

      if (path === "/confirm") {
        const interval = parseConfirmInterval(url.searchParams.get("interval"));
        if (interval == null) {
          return json({ error: "confirm_interval", allowed: ["15", "5"] }, 400);
        }
        return json(buildConfirm(store, {
          symbol: url.searchParams.get("symbol"),
          interval,
          dbPath: config.dbPath,
        }));
      }

      if (path === "/chart") {
        const startRaw = url.searchParams.get("start");
        const endRaw = url.searchParams.get("end");
        const start = startRaw ? Number(startRaw) : Number.NaN;
        const end = endRaw ? Number(endRaw) : Number.NaN;
        const limitRaw = url.searchParams.get("limit");
        return json(buildChart(store, {
          symbol: url.searchParams.get("symbol"),
          interval: url.searchParams.get("interval"),
          limit: limitRaw ? Number(limitRaw) : undefined,
          startTs: Number.isFinite(start) ? start : undefined,
          endTs: Number.isFinite(end) ? end : undefined,
        }));
      }

      if (path === "/depth") {
        return json(buildDepth(store, { symbol: url.searchParams.get("symbol") }));
      }

      if (path === "/market") {
        const limitRaw = url.searchParams.get("limit");
        const heatLimitRaw = url.searchParams.get("heatmapLimit");
        const bucketRaw = url.searchParams.get("bucket");
        const bucket = bucketRaw ? Number(bucketRaw) : Number.NaN;
        return json(buildMarket(store, {
          symbol: url.searchParams.get("symbol"),
          interval: url.searchParams.get("interval"),
          limit: limitRaw ? Number(limitRaw) : undefined,
          heatmapLimit: heatLimitRaw ? Number(heatLimitRaw) : undefined,
          bucket: Number.isFinite(bucket) && bucket > 0 ? bucket : null,
        }));
      }

      if (path === "/heatmap") {
        const startRaw = url.searchParams.get("start");
        const endRaw = url.searchParams.get("end");
        const start = startRaw ? Number(startRaw) : Number.NaN;
        const end = endRaw ? Number(endRaw) : Number.NaN;
        const limitRaw = url.searchParams.get("limit");
        const bucketRaw = url.searchParams.get("bucket");
        const bucket = bucketRaw ? Number(bucketRaw) : Number.NaN;
        return json(buildHeatmap(store, {
          symbol: url.searchParams.get("symbol"),
          limit: limitRaw ? Number(limitRaw) : undefined,
          startTs: Number.isFinite(start) ? start : undefined,
          endTs: Number.isFinite(end) ? end : undefined,
          bucket: Number.isFinite(bucket) && bucket > 0 ? bucket : null,
        }));
      }

      return json({ error: "not found" }, 404);
    },
  });

  return server;
}
