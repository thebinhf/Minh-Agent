import { assertNoApiKeys } from "../paper/config";
import { PaperSafetyError } from "../paper/errors";
import { httpFeed } from "../paper/feed";
import { gatesFromFeedHealth } from "../paper/gates";
import type { PaperKlineSnap } from "../paper/types";
import type { QuantTape } from "../agent/quant";
import { taArmFlagsOn, taOscMode, taShockMode, type TaArmTape } from "../agent/ta-gate";
import { taArmFromBars, taBarsFromSnaps, taOscFromMap } from "../ta/arm-tape";
import { liveEnabled, loadLiveConfig, type LiveConfig } from "./config";
import { openLiveDb, type LiveDb } from "./db";
import { startLiveHttp } from "./http";
import {
  fetchFeedHealth,
  map240Fingerprint,
  planArm,
  planMapClose,
  type ShadowMapPlan,
} from "./plan";

export type LiveTape = {
  health: () => Promise<{ ok: boolean; url?: string; klineLagOk?: boolean }>;
  tickers: () => Promise<Array<{ symbol: string; lastPrice: string | null }>>;
  lastKline: (symbol: string, interval: string) => Promise<PaperKlineSnap | null>;
  recentKlines?: (symbol: string, interval: string, limit: number) => Promise<PaperKlineSnap[]>;
  quant?: (symbol: string) => Promise<QuantTape | null>;
  shock?: (symbol: string) => Promise<string | null>;
  mapLatest?: () => Promise<unknown | null>;
};

export type LiveFeature = {
  stop: () => void;
  url: string;
  store: LiveDb;
  tick: () => Promise<void>;
  planMap: (info: { interval: string; map: unknown }) => Promise<ShadowMapPlan | null>;
};

function defaultTape(feedUrl: string): LiveTape {
  const feed = httpFeed(feedUrl);
  const base = feedUrl.replace(/\/$/, "");
  return {
    health: () => fetchFeedHealth(feedUrl),
    tickers: () => feed.tickers(),
    lastKline: (symbol, interval) => feed.lastKline(symbol, interval),
    recentKlines: (symbol, interval, limit) => feed.recentKlines?.(symbol, interval, limit) ?? Promise.resolve([]),
    quant: (symbol) => feed.quant?.(symbol) ?? Promise.resolve(null),
    shock: (symbol) => feed.shock?.(symbol) ?? Promise.resolve(null),
    async mapLatest() {
      try {
        const res = await fetch(`${base}/map-latest`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Separate process. Own sqlite. Own bind. Reads the public feed HTTP.
 * Does not start a second Bybit WS. Does not open the paper ledger.
 * Does not rest OCO / send orders.
 */
export async function startLive(opts?: {
  config?: LiveConfig;
  tick?: boolean;
  pollMap?: boolean;
  fetchCards?: (feedUrl: string) => Promise<unknown[]>;
  feed?: LiveTape;
}): Promise<LiveFeature> {
  assertNoApiKeys();
  if (!liveEnabled()) {
    throw new PaperSafetyError("LIVE_SHADOW=0 — live-shadow is off");
  }
  const config = opts?.config ?? await loadLiveConfig();
  const store = openLiveDb(config.dbPath);
  const tape = opts?.feed ?? defaultTape(config.feedUrl);
  let lastFp = "";

  async function planMap(info: { interval: string; map: unknown }): Promise<ShadowMapPlan | null> {
    const health = await tape.health();
    return planMapClose(store, info, {
      feedUrl: config.feedUrl,
      fetchCards: opts?.fetchCards,
      minRr: config.minRr,
      health,
      oscBySymbol: taOscMode() === "accept" ? taOscFromMap(info.map) : undefined,
    });
  }

  const http = startLiveHttp(config, store, {
    health: () => tape.health(),
    onMapClose: planMap,
  });

  async function pollMapClose(): Promise<void> {
    if (opts?.pollMap === false) return;
    const map = await tape.mapLatest?.();
    if (!map) return;
    const fp = map240Fingerprint(map);
    if (!fp || fp === lastFp) return;
    lastFp = fp;
    const result = await planMap({ interval: "240", map });
    if (result?.accepted.length) {
      console.log(`[minh:live] map plan ${result.accepted.join(",")}`);
    }
  }

  async function tick(): Promise<void> {
    const now = Date.now();
    store.expire(now);
    try {
      await pollMapClose();
    } catch (error) {
      console.error("[minh:live] map poll", error instanceof Error ? error.message : error);
    }
    const health = await tape.health();
    const gates = gatesFromFeedHealth({
      ok: health.ok,
      url: health.url ?? config.feedUrl,
      klineLagOk: health.klineLagOk,
    });
    const lastBySymbol = new Map<string, number>();
    try {
      const tickers = await tape.tickers();
      for (const row of tickers) {
        const last = Number(row.lastPrice);
        if (row.symbol && Number.isFinite(last)) lastBySymbol.set(row.symbol.toUpperCase(), last);
      }
    } catch {
      return;
    }
    const kline15BySymbol = new Map<string, PaperKlineSnap>();
    const quantBySymbol = new Map<string, QuantTape>();
    const taBySymbol = new Map<string, TaArmTape>();
    for (const row of store.accepted(now)) {
      if (!lastBySymbol.has(row.symbol)) continue;
      try {
        const bar = await tape.lastKline(row.symbol, "15");
        if (bar) kline15BySymbol.set(row.symbol, bar);
      } catch {
        // missing 15m is wait
      }
      if (tape.quant) {
        try {
          const tapeRow = await tape.quant(row.symbol);
          if (tapeRow) quantBySymbol.set(row.symbol, tapeRow);
        } catch {
          // missing quant is not a veto
        }
      }
      if (taArmFlagsOn()) {
        try {
          const h4 = tape.recentKlines
            ? taBarsFromSnaps(await tape.recentKlines(row.symbol, "240", 120))
            : [];
          const m15 = tape.recentKlines
            ? taBarsFromSnaps(await tape.recentKlines(row.symbol, "15", 40))
            : [];
          let shock: string | null = null;
          if (taShockMode() === "arm" && tape.shock) shock = await tape.shock(row.symbol);
          taBySymbol.set(row.symbol, taArmFromBars(h4, m15, shock));
        } catch {
          // missing TA tape is not a wait
        }
      }
    }
    const arm = planArm(store, lastBySymbol, {
      now,
      kline15BySymbol,
      quantBySymbol,
      tradingAllowed: gates.tradingAllowed,
      taBySymbol: taBySymbol.size > 0 ? taBySymbol : undefined,
    });
    if (arm.wouldArm.length) {
      console.log(`[minh:live] would-arm ${arm.wouldArm.join(",")}`);
    }
    if (arm.dropped.length) {
      console.log(`[minh:live] drop ${arm.dropped.join(",")}`);
    }
  }

  const doTick = opts?.tick !== false;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (doTick && config.tickMs > 0) {
    timer = setInterval(() => {
      tick().catch((error) => {
        console.error("[minh:live] tick", error instanceof Error ? error.message : error);
      });
    }, config.tickMs);
    timer.unref?.();
  }

  console.log(`[minh:live] http://${config.httpHost}:${http.port} db=${config.dbPath}`);
  console.log("[minh:live] shadow only — no API keys, no orders, no paper ledger");

  return {
    store,
    url: `http://${config.httpHost}:${http.port}`,
    tick,
    planMap,
    stop() {
      if (timer) clearInterval(timer);
      http.stop();
      store.close();
    },
  };
}

export { liveEnabled, loadLiveConfig } from "./config";
export { openLiveDb } from "./db";
export { planArm, planMapClose, map240Fingerprint } from "./plan";
