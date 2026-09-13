import type { ExecClient } from "./client";
import type { ExecConfig } from "./config";
import type { ExecDb } from "./db";
import { specAgeHours, specStale } from "./instruments";

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

export type ExecHttpOpts = {
  specMaxAgeHours: number;
};

/**
 * GET-only surface. There is no POST route: order placement, operator
 * controls and the webhook seam are later stages. Non-GET is a 405 before
 * any handler runs.
 */
export function startExecHttp(config: ExecConfig, store: ExecDb, client: ExecClient, opts: ExecHttpOpts) {
  const server = Bun.serve({
    hostname: config.httpHost,
    port: config.httpPort,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

      if (path === "/exec/health") {
        const spec = store.loadSpec() as { asOfTs: number; payload?: { asOf?: string; symbols?: Record<string, unknown> } } | null;
        const auth = client.authState();
        const stale = specStale(spec, Date.now(), opts.specMaxAgeHours);
        return json({
          ok: auth === "ok" && !stale,
          mode: "exec",
          execMode: config.mode,
          authenticated: auth === "ok",
          auth,
          baseUrl: config.baseUrl,
          accountType: config.accountType,
          db: config.dbPath,
          spec: {
            asOf: spec?.payload?.asOf ?? null,
            ageHours: specAgeHours(spec, Date.now()),
            stale,
            symbols: spec?.payload?.symbols ? Object.keys(spec.payload.symbols).length : 0,
          },
          orders: false,
        });
      }

      if (path === "/exec/wallet") {
        try {
          return json(await client.walletBalance(url.searchParams.get("coin") ?? undefined));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 503);
        }
      }

      if (path === "/exec/positions") {
        try {
          return json(await client.positions());
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 503);
        }
      }

      if (path === "/exec/orders") {
        try {
          return json(await client.openOrders());
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 503);
        }
      }

      if (path === "/exec/fees") {
        try {
          return json(await client.feeRate(url.searchParams.get("symbol") ?? undefined));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 503);
        }
      }

      if (path === "/exec/instruments") {
        const spec = store.loadSpec();
        if (!spec) return json({ error: "spec_missing" }, 404);
        const payload = (spec.payload ?? {}) as Record<string, unknown>;
        return json({
          ...payload,
          ageHours: specAgeHours(spec, Date.now()),
          stale: specStale(spec, Date.now(), opts.specMaxAgeHours),
        });
      }

      if (path === "/exec/events") {
        return json({ events: store.events(100) });
      }

      return json({ error: "not found" }, 404);
    },
  });

  return server;
}
