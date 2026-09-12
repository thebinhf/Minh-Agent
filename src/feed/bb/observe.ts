import { buildFeedHealth, tradingGates } from "./health";
import { mapClosePath } from "./map-close";
import type { TrackerConfig } from "./types";
import type { TrackerDb } from "./db";

export const FEED_OBSERVE_NOTE = "observer — one GET: feed + last MAP + paper desk";

export type ObserveMap = {
  quality: "ok" | "missing";
  interval: string | null;
  ts: number | null;
  symbols: string[];
};

function asSymbols(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const root = body as { maps?: unknown; symbol?: unknown };
  if (Array.isArray(root.maps)) {
    const out: string[] = [];
    for (const item of root.maps) {
      if (!item || typeof item !== "object") continue;
      const symbol = String((item as { symbol?: unknown }).symbol ?? "").trim().toUpperCase();
      if (symbol) out.push(symbol);
    }
    return out;
  }
  const symbol = String(root.symbol ?? "").trim().toUpperCase();
  return symbol ? [symbol] : [];
}

function asInterval(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const interval = (body as { interval?: unknown }).interval;
  return interval === "60" || interval === "240" ? interval : null;
}

function asTs(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const ts = Number((body as { ts?: unknown }).ts);
  return Number.isFinite(ts) ? ts : null;
}

export async function readObserveMap(
  config: Pick<TrackerConfig, "dbPath">,
): Promise<ObserveMap> {
  const file = Bun.file(mapClosePath(config, process.env.MAP_CLOSE_PATH));
  if (!(await file.exists())) {
    return { quality: "missing", interval: null, ts: null, symbols: [] };
  }
  try {
    const body = await file.json();
    const modified = Number(file.lastModified);
    return {
      quality: "ok",
      interval: asInterval(body),
      ts: asTs(body) ?? (Number.isFinite(modified) && modified > 0 ? modified : null),
      symbols: asSymbols(body),
    };
  } catch {
    return { quality: "missing", interval: null, ts: null, symbols: [] };
  }
}

export async function buildObserve(
  store: TrackerDb,
  config: TrackerConfig,
  paper: unknown = null,
  now = Date.now(),
) {
  const health = buildFeedHealth(store, config, now);
  const gates = tradingGates({
    feedOk: health.ok,
    klineLagOk: health.klineLag.ok,
  });
  return {
    mode: "observe" as const,
    observer: true,
    ts: now,
    note: FEED_OBSERVE_NOTE,
    feed: {
      ok: health.ok,
      connected: health.connected,
      klineLagOk: health.klineLag.ok,
      lastMessageAgeMs: health.lastMessageAgeMs,
    },
    gates,
    map: await readObserveMap(config),
    paper: paper ?? null,
  };
}
