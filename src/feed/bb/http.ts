import { buildBrief } from "./brief";
import { buildBriefPack, resolvePaperDesk, type BriefPackPaperSource } from "./brief-pack";
import { buildConfirm, parseConfirmInterval } from "./confirm";
import { buildMap, buildMapBatch, MAP_SYMBOL_CAP, parseMapSymbols, resolveMapSymbols } from "./map";
import { buildZones } from "./zones";
import { parseZoneInterval } from "../../zones/detect";
import { buildOi } from "./oi";
import { buildFunding } from "./funding";
import { buildLiqHeatmap } from "./liq";
import { buildLiqModel } from "./liq-model";
import { buildFlow } from "./flow";
import { relayEnabled, type RelayHub } from "./relay";
import type { TrackerDb } from "./db";
import { buildFeedHealth } from "./health";
import { mapClosePath } from "./map-close";
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

export type FeedHttpExtras = {
  /** Injected by the composition root. Feed does not import src/paper. */
  paperDesk?: BriefPackPaperSource;
  /** Local WS hub. GET /ws upgrades when set and BYBIT_RELAY is not 0. */
  relay?: RelayHub;
};

export function startHttp(config: TrackerConfig, store: TrackerDb, extras?: FeedHttpExtras) {
  const server = Bun.serve<{ topics: Set<string> }>({
    hostname: config.httpHost,
    port: config.httpPort,
    async fetch(req, bun) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/ws") {
        if (!extras?.relay || !relayEnabled()) {
          return json({ error: "not found" }, 404);
        }
        if (bun.upgrade(req, { data: { topics: new Set<string>() } })) return;
        return json({ error: "upgrade" }, 400);
      }

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

      if (path === "/health") {
        return json(buildFeedHealth(store, config));
      }

      if (path === "/brief-pack") {
        const paper = await resolvePaperDesk(extras?.paperDesk);
        return json(buildBriefPack(store, {
          config,
          symbol: url.searchParams.get("symbol"),
          paper,
        }));
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

      if (path === "/map-latest") {
        const file = Bun.file(mapClosePath(config, process.env.MAP_CLOSE_PATH));
        if (!(await file.exists())) {
          return json({ error: "map_latest_missing" }, 404);
        }
        return new Response(await file.text(), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          },
        });
      }

      if (path === "/map") {
        const listed = parseMapSymbols(
          url.searchParams.get("symbols") ?? url.searchParams.get("symbol"),
        );
        const symbols = resolveMapSymbols(listed, config.symbols ?? []);
        if (listed.length > MAP_SYMBOL_CAP || symbols.length > MAP_SYMBOL_CAP) {
          return json({ error: "map_symbols", cap: MAP_SYMBOL_CAP }, 400);
        }
        if (symbols.length === 1) {
          return json(buildMap(store, { symbol: symbols[0], dbPath: config.dbPath }));
        }
        return json(buildMapBatch(store, { symbols, dbPath: config.dbPath }));
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

      if (path === "/zones") {
        const listed = parseMapSymbols(
          url.searchParams.get("symbols") ?? url.searchParams.get("symbol"),
        );
        const symbols = resolveMapSymbols(listed, config.symbols ?? []);
        if (listed.length > MAP_SYMBOL_CAP || symbols.length > MAP_SYMBOL_CAP) {
          return json({ error: "map_symbols", cap: MAP_SYMBOL_CAP }, 400);
        }
        const interval = parseZoneInterval(url.searchParams.get("interval"));
        if (interval == null) {
          return json({ error: "zones_interval", allowed: ["240", "60"] }, 400);
        }
        return json(buildZones(store, {
          symbols,
          dbPath: config.dbPath,
          interval,
        }));
      }

      if (path === "/oi") {
        const interval = url.searchParams.get("interval");
        const limitRaw = url.searchParams.get("limit");
        const body = buildOi(store, {
          symbol: url.searchParams.get("symbol"),
          interval,
          dbPath: config.dbPath,
          limit: limitRaw ? Number(limitRaw) : undefined,
        });
        if ("error" in body) {
          return json(body, 400);
        }
        return json(body);
      }

      if (path === "/funding") {
        const limitRaw = url.searchParams.get("limit");
        const symbol = url.searchParams.get("symbol");
        const ticker = store.listTickers(symbol ?? "BTCUSDT")[0] as
          | { funding_rate?: unknown; next_funding_time?: unknown }
          | undefined;
        return json(buildFunding(store, {
          symbol,
          dbPath: config.dbPath,
          limit: limitRaw ? Number(limitRaw) : undefined,
          ticker: ticker
            ? {
              fundingRate: ticker.funding_rate == null ? null : String(ticker.funding_rate),
              nextFundingTime: ticker.next_funding_time == null ? null : String(ticker.next_funding_time),
            }
            : undefined,
        }));
      }

      if (path === "/flow") {
        return json(buildFlow(store, {
          symbol: url.searchParams.get("symbol"),
          dbPath: config.dbPath,
        }));
      }

      if (path === "/liq-heatmap") {
        const symbol = url.searchParams.get("symbol");
        const hoursRaw = url.searchParams.get("hours");
        const bucketRaw = url.searchParams.get("bucket");
        const hours = hoursRaw ? Number(hoursRaw) : undefined;
        const bucket = bucketRaw ? Number(bucketRaw) : Number.NaN;
        const ticker = store.listTickers(symbol ?? "BTCUSDT")[0] as
          | { last_price?: unknown }
          | undefined;
        return json(buildLiqHeatmap(store, {
          symbol,
          dbPath: config.dbPath,
          hours: hours != null && Number.isFinite(hours) ? hours : undefined,
          bucket: Number.isFinite(bucket) && bucket > 0 ? bucket : null,
          lastPrice: ticker?.last_price == null ? null : String(ticker.last_price),
        }));
      }

      if (path === "/liq-model") {
        const symbol = url.searchParams.get("symbol");
        const bucketRaw = url.searchParams.get("bucket");
        const bucket = bucketRaw ? Number(bucketRaw) : Number.NaN;
        return json(buildLiqModel(store, {
          symbol,
          dbPath: config.dbPath,
          bucket: Number.isFinite(bucket) && bucket > 0 ? bucket : null,
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
    websocket: {
      open(ws) {
        extras?.relay?.attach(ws);
      },
      close(ws) {
        extras?.relay?.detach(ws);
      },
      message(ws, message) {
        extras?.relay?.onMessage(ws, message);
      },
    },
  });

  return server;
}
