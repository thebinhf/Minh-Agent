import type { LiveConfig } from "./config";
import type { LiveDb } from "./db";
import type { ShadowMapPlan } from "./plan";
import { fetchFeedHealth } from "./plan";
import { gatesFromFeedHealth } from "../paper/gates";

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

export type LiveHttpHooks = {
  onMapClose?: (info: { interval: string; map: unknown }) => Promise<ShadowMapPlan | null>;
  health?: () => Promise<{ ok: boolean; url?: string; klineLagOk?: boolean }>;
};

export function startLiveHttp(config: LiveConfig, store: LiveDb, hooks: LiveHttpHooks = {}) {
  const server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    async fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
          },
        });
      }

      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/live/health") {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        const feedHealth = hooks.health
          ? await hooks.health()
          : await fetchFeedHealth(config.feedUrl);
        const gates = gatesFromFeedHealth({
          ok: feedHealth.ok,
          url: feedHealth.url ?? `${config.feedUrl.replace(/\/$/, "")}/health`,
          klineLagOk: feedHealth.klineLagOk,
        });
        return json({
          ok: feedHealth.ok !== false,
          mode: "live-shadow",
          feed: {
            url: feedHealth.url ?? config.feedUrl,
            ok: feedHealth.ok === true,
            klineLagOk: feedHealth.klineLagOk !== false,
          },
          db: config.dbPath,
          gates,
          orders: false,
        });
      }

      if (path === "/live/shadow") {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        const now = Date.now();
        store.expire(now);
        const accepted = store.accepted(now);
        const counts = store.counts();
        return json({
          mode: "live-shadow",
          accepted: accepted.map((row) => ({
            zoneId: row.zoneId,
            symbol: row.symbol,
            side: row.card.side,
            rr: row.card.rr,
            acceptedTs: row.acceptedTs,
            expiresTs: row.expiresTs,
            armedTs: row.armedTs,
          })),
          wouldArm: accepted.filter((row) => row.armedTs != null).map((row) => row.zoneId),
          events: store.events(50),
          counts,
        });
      }

      if (path === "/live/map-close") {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const interval = String(body.interval ?? "");
        if (!interval) return json({ error: "map_close_interval" }, 400);
        if (!hooks.onMapClose) return json({ error: "map_close_unwired" }, 500);
        const map = body.map ?? body;
        const plan = await hooks.onMapClose({ interval, map });
        return json({ mode: "live-shadow", interval, plan });
      }

      return json({ error: "not found" }, 404);
    },
  });

  return server;
}
