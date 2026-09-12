import { dirname, resolve } from "node:path";
import { rename } from "node:fs/promises";
import type { TrackerDb } from "./db";
import { buildMap, buildMapBatch, MAP_SYMBOL_CAP, resolveMapSymbols } from "./map";
import type { TrackerConfig } from "./types";

/** HTF closes that trigger a MAP dump. Not 15m — that is EVENT. */
export const MAP_CLOSE_INTERVALS = ["60", "240"] as const;

export type MapCloseBar = {
  symbol: string;
  interval: string;
  startTs: number;
  confirm: boolean;
};

export type MapCloseTick = {
  next: Set<string>;
  interval: (typeof MAP_CLOSE_INTERVALS)[number] | null;
  bars: MapCloseBar[];
};

export function mapCloseKey(bar: Pick<MapCloseBar, "symbol" | "interval" | "startTs">): string {
  return `${bar.symbol}|${bar.interval}|${bar.startTs}`;
}

export function mapClosePath(config: Pick<TrackerConfig, "dbPath">, override?: string | null): string {
  if (override && override.trim()) return resolve(override.trim());
  return resolve(dirname(config.dbPath), "map-latest.json");
}

export function mapCloseEnabled(): boolean {
  return process.env.MAP_CLOSE !== "0";
}

export function tickMapClose(prev: Set<string>, bars: MapCloseBar[]): MapCloseTick {
  const next = new Set<string>();
  const fresh: MapCloseBar[] = [];
  for (const bar of bars) {
    if (bar.interval !== "60" && bar.interval !== "240") continue;
    if (!bar.confirm) continue;
    const key = mapCloseKey(bar);
    next.add(key);
    if (!prev.has(key)) fresh.push(bar);
  }
  let interval: MapCloseTick["interval"] = null;
  if (fresh.some((bar) => bar.interval === "240")) interval = "240";
  else if (fresh.some((bar) => bar.interval === "60")) interval = "60";
  return { next, interval, bars: fresh };
}

export function buildWatchlistMap(
  store: TrackerDb,
  config: Pick<TrackerConfig, "symbols" | "dbPath">,
  now = Date.now(),
) {
  const symbols = resolveMapSymbols([], config.symbols ?? []).slice(0, MAP_SYMBOL_CAP);
  if (symbols.length <= 1) {
    return buildMap(store, { symbol: symbols[0], dbPath: config.dbPath, now });
  }
  return buildMapBatch(store, { symbols, dbPath: config.dbPath, now });
}

export async function writeMapSnapshot(path: string, body: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(body, null, 2)}\n`);
  await rename(tmp, path);
}

export async function postMapCloseWebhook(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`map-close webhook HTTP ${res.status}`);
  }
}

function readLatestBars(store: TrackerDb): MapCloseBar[] {
  const rows = store.latestConfirmedKlines([...MAP_CLOSE_INTERVALS]) as {
    symbol: string;
    interval: string;
    start_ts: number;
    confirm: number;
  }[];
  return rows.map((row) => ({
    symbol: String(row.symbol ?? "").toUpperCase(),
    interval: String(row.interval ?? ""),
    startTs: Number(row.start_ts),
    confirm: Boolean(row.confirm),
  }));
}

/**
 * On confirmed 1H/4H bars, dump the watchlist MAP to disk (and optional webhook).
 * Does not arm paper. Does not draw S/D. `onClose` is the composition-root hook.
 */
export function startMapCloser(
  config: TrackerConfig,
  store: TrackerDb,
  hooks: {
    write?: (path: string, body: unknown) => Promise<void>;
    webhook?: (url: string, body: unknown) => Promise<void>;
    onClose?: (info: { interval: (typeof MAP_CLOSE_INTERVALS)[number]; path: string; map: unknown }) => Promise<void>;
  } = {},
): { stop: () => void } {
  if (!mapCloseEnabled()) {
    return { stop() { /* MAP_CLOSE=0 */ } };
  }
  const path = mapClosePath(config, process.env.MAP_CLOSE_PATH);
  const webhook = process.env.MAP_CLOSE_WEBHOOK?.trim() || "";
  const intervalMs = Math.max(1_000, config.recovery?.watchdogIntervalMs ?? 10_000);
  let prev = new Set<string>();
  let seeded = false;
  let busy = false;
  const write = hooks.write ?? writeMapSnapshot;
  const post = hooks.webhook ?? postMapCloseWebhook;

  const run = async () => {
    if (busy) return;
    let bars: MapCloseBar[] = [];
    try {
      bars = readLatestBars(store);
    } catch {
      return;
    }
    const tick = tickMapClose(prev, bars);
    prev = tick.next;
    if (!seeded) {
      seeded = true;
      return;
    }
    if (!tick.interval) return;
    busy = true;
    try {
      const body = buildWatchlistMap(store, config);
      await write(path, body);
      console.log(`[minh:bb] map close ${tick.interval} wrote ${path}`);
      if (webhook) {
        try {
          await post(webhook, { kind: "map.close", interval: tick.interval, path, map: body });
        } catch (error) {
          console.error("[minh:bb] map-close webhook", error instanceof Error ? error.message : error);
        }
      }
      if (hooks.onClose) {
        try {
          await hooks.onClose({ interval: tick.interval, path, map: body });
        } catch (error) {
          console.error("[minh:bb] map-close onClose", error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error("[minh:bb] map close", error instanceof Error ? error.message : error);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
