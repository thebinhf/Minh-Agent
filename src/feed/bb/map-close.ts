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

const RENAME_ATTEMPTS = 4;
const RENAME_DELAY_MS = 50;

/** On Windows these mean "someone else has the destination open right now". */
function lockHeld(code: string | undefined): boolean {
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/**
 * Windows `rename` over a file another handle has open (antivirus, the indexer,
 * a concurrent `/map-latest` reader) throws instead of waiting. The lock is
 * momentary, so retry — a single EPERM used to leave the MAP stale for an hour.
 */
export async function writeMapSnapshot(
  path: string,
  body: unknown,
  renameImpl: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(body, null, 2)}\n`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt + 1 >= RENAME_ATTEMPTS || !lockHeld(code)) throw error;
      await Bun.sleep(RENAME_DELAY_MS * (attempt + 1));
    }
  }
}

/**
 * The close is consumed only once its dump is on disk. A failed write used to
 * leave `prev` holding the bar, so nothing retried until the next 1H close.
 */
export function rollbackTick(seen: Set<string>, tick: MapCloseTick): Set<string> {
  const back = new Set(seen);
  for (const bar of tick.bars) back.delete(mapCloseKey(bar));
  return back;
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
): { tick: () => Promise<void>; stop: () => void } {
  if (!mapCloseEnabled()) {
    return { tick: async () => { /* MAP_CLOSE=0 */ }, stop() { /* MAP_CLOSE=0 */ } };
  }
  const path = mapClosePath(config, process.env.MAP_CLOSE_PATH);
  const webhook = process.env.MAP_CLOSE_WEBHOOK?.trim() || "";
  const intervalMs = Math.max(1_000, config.recovery?.watchdogIntervalMs ?? 10_000);
  let prev = new Set<string>();
  let seeded = false;
  let busy = false;
  const write = hooks.write ?? writeMapSnapshot;
  const post = hooks.webhook ?? postMapCloseWebhook;

  const dump = async (tick: MapCloseTick, notify: boolean) => {
    if (busy || tick.interval === null) return;
    busy = true;
    try {
      const body = buildWatchlistMap(store, config);
      await write(path, body);
      console.log(`[minh:bb] map close ${tick.interval} wrote ${path}`);
      if (!notify) return;
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
      // The close is only consumed once its dump exists: a Windows sharing
      // violation used to leave the MAP stale until the next hourly close.
      prev = rollbackTick(prev, tick);
      console.error("[minh:bb] map close", error instanceof Error ? error.message : error);
    } finally {
      busy = false;
    }
  };

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
      // Publish a current file at boot: `/map-latest` was previously as old as the
      // last close before the restart. Notify stays off, because a bar that closed
      // while we were down must not re-trigger the webhook or the accept path.
      await dump(tick, false);
      return;
    }
    await dump(tick, true);
  };

  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref?.();
  return {
    tick: run,
    stop() {
      clearInterval(timer);
    },
  };
}
