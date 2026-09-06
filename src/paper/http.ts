import { PaperReject } from "./errors";
import type { PaperEngine } from "./engine";
import type { PaperConfig, PaperFeed } from "./types";

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

function rejectStatus(error: PaperReject): number {
  if (error.error === "already_closed") return 409;
  if (error.error === "not_found") return 404;
  return 400;
}

function positionId(path: string): number | null {
  const match = /^\/paper\/positions\/(\d+)\/close$/.exec(path);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) ? id : null;
}

export function startPaperHttp(config: PaperConfig, engine: PaperEngine, feed: PaperFeed) {
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

      try {
        if (path === "/paper/health") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          const feedHealth = await feed.health();
          let accountName = "minh-paper";
          let dbOk = true;
          try {
            accountName = engine.account().name;
          } catch {
            dbOk = false;
          }
          return json({
            ok: dbOk && feedHealth.ok,
            mode: "paper",
            feed: { url: feedHealth.url, ok: feedHealth.ok },
            account: accountName,
          });
        }

        if (path === "/paper/account") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          return json(engine.account());
        }

        if (path === "/paper/positions") {
          if (req.method === "GET") {
            const statusRaw = url.searchParams.get("status") ?? "open";
            const status = statusRaw === "closed" || statusRaw === "all" || statusRaw === "open"
              ? statusRaw
              : "open";
            return json({ mode: "paper", positions: engine.positions(status) });
          }
          if (req.method === "POST") {
            const body = (await req.json()) as Record<string, unknown>;
            const timeframes = Array.isArray(body.timeframes) ? body.timeframes.map(String) : [];
            const opened = await engine.open({
              symbol: String(body.symbol ?? ""),
              side: String(body.side ?? ""),
              stopLoss: String(body.stopLoss ?? ""),
              takeProfit: String(body.takeProfit ?? ""),
              timeframes,
              riskPct: body.riskPct == null || body.riskPct === "" ? undefined : String(body.riskPct),
              note: body.note == null ? undefined : String(body.note),
            });
            return json(opened, 201);
          }
          return json({ error: "method not allowed" }, 405);
        }

        const closeId = positionId(path);
        if (closeId != null) {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          return json(await engine.close(closeId));
        }

        if (path === "/paper/mark") {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          return json(await engine.mark());
        }

        return json({ error: "not found" }, 404);
      } catch (error) {
        if (error instanceof PaperReject) {
          return json(error.toJSON(), rejectStatus(error));
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ mode: "paper", error: "internal", message }, 500);
      }
    },
  });

  return server;
}
