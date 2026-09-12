import { buildFeedHealth, tradingGates } from "./health";
import { mapClosePath } from "./map-close";
import type { TrackerConfig } from "./types";
import type { TrackerDb } from "./db";

export const FEED_OBSERVE_NOTE = "observer — one GET: feed + last MAP + tape + paper + shadow";
export const SHADOW_TIMEOUT_MS = 400;

export type ObserveMap = {
  quality: "ok" | "missing";
  interval: string | null;
  ts: number | null;
  symbols: string[];
};

export type ObserveTapeField = { ok: number; missing: number };

export type ObserveTape = {
  quality: "ok" | "missing";
  symbols: number;
  oi: ObserveTapeField;
  funding: ObserveTapeField;
  flow: ObserveTapeField;
  liq: ObserveTapeField;
};

export type ObserveShadow = {
  quality: "ok" | "missing" | "down";
  accepted: number;
  wouldArm: number;
};

function emptyTape(): ObserveTape {
  return {
    quality: "missing",
    symbols: 0,
    oi: { ok: 0, missing: 0 },
    funding: { ok: 0, missing: 0 },
    flow: { ok: 0, missing: 0 },
    liq: { ok: 0, missing: 0 },
  };
}

function mapItems(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") return [];
  const root = body as { maps?: unknown; symbol?: unknown };
  if (Array.isArray(root.maps)) {
    return root.maps.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  return [body as Record<string, unknown>];
}

function asSymbols(body: unknown): string[] {
  const out: string[] = [];
  for (const item of mapItems(body)) {
    const symbol = String(item.symbol ?? "").trim().toUpperCase();
    if (symbol) out.push(symbol);
  }
  return out;
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

function present(value: unknown): boolean {
  return value != null && value !== "";
}

function bump(field: ObserveTapeField, ok: boolean): void {
  if (ok) field.ok += 1;
  else field.missing += 1;
}

/** Empty window / null reading is missing — do not count as 0 coverage. */
export function observeTapeFromMap(body: unknown): ObserveTape {
  const items = mapItems(body);
  if (items.length === 0) return emptyTape();
  const tape: ObserveTape = {
    quality: "ok",
    symbols: items.length,
    oi: { ok: 0, missing: 0 },
    funding: { ok: 0, missing: 0 },
    flow: { ok: 0, missing: 0 },
    liq: { ok: 0, missing: 0 },
  };
  for (const item of items) {
    const oi = item.oi && typeof item.oi === "object" ? item.oi as Record<string, unknown> : null;
    const funding = item.funding && typeof item.funding === "object" ? item.funding as Record<string, unknown> : null;
    const flow = item.flow && typeof item.flow === "object" ? item.flow as Record<string, unknown> : null;
    const liq = item.liq && typeof item.liq === "object" ? item.liq as Record<string, unknown> : null;
    bump(tape.oi, present(oi?.deltaPct) || present(oi?.reading));
    bump(tape.funding, present(funding?.latest) || present(funding?.crowded) || present(funding?.rate));
    bump(tape.flow, present(flow?.delta));
    const liqCount = Number(liq?.count);
    const cascade = liq?.cascade && typeof liq.cascade === "object"
      ? liq.cascade as { active?: unknown }
      : null;
    bump(tape.liq, (Number.isFinite(liqCount) && liqCount > 0) || cascade?.active === true);
  }
  return tape;
}

export function liveShadowObserveUrl(): string | null {
  if (process.env.LIVE_SHADOW === "0") return null;
  const raw = process.env.LIVE_SHADOW_URL?.trim();
  return raw ? raw : null;
}

export type ObserveFetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function readObserveShadow(
  fetchImpl: ObserveFetch = fetch,
  timeoutMs = SHADOW_TIMEOUT_MS,
): Promise<ObserveShadow> {
  const url = liveShadowObserveUrl();
  if (!url) return { quality: "missing", accepted: 0, wouldArm: 0 };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { quality: "down", accepted: 0, wouldArm: 0 };
    const body = await res.json() as {
      accepted?: unknown;
      wouldArm?: unknown;
    };
    const accepted = Array.isArray(body.accepted) ? body.accepted.length : 0;
    const wouldArm = Array.isArray(body.wouldArm) ? body.wouldArm.length : 0;
    return { quality: "ok", accepted, wouldArm };
  } catch {
    return { quality: "down", accepted: 0, wouldArm: 0 };
  }
}

export async function readObserveMap(
  config: Pick<TrackerConfig, "dbPath">,
): Promise<{ map: ObserveMap; tape: ObserveTape; body: unknown }> {
  const file = Bun.file(mapClosePath(config, process.env.MAP_CLOSE_PATH));
  if (!(await file.exists())) {
    return {
      map: { quality: "missing", interval: null, ts: null, symbols: [] },
      tape: emptyTape(),
      body: null,
    };
  }
  try {
    const body = await file.json();
    const modified = Number(file.lastModified);
    return {
      map: {
        quality: "ok",
        interval: asInterval(body),
        ts: asTs(body) ?? (Number.isFinite(modified) && modified > 0 ? modified : null),
        symbols: asSymbols(body),
      },
      tape: observeTapeFromMap(body),
      body,
    };
  } catch {
    return {
      map: { quality: "missing", interval: null, ts: null, symbols: [] },
      tape: emptyTape(),
      body: null,
    };
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
  const { map, tape } = await readObserveMap(config);
  const shadow = await readObserveShadow();
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
    map,
    tape,
    shadow,
    paper: paper ?? null,
  };
}
