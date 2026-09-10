import { PaperReject } from "./errors";
import { gatesFromFeedHealth, parseZoneId } from "./gates";
import type { PaperEngine } from "./engine";
import { parseMetricsDays, paperMetrics } from "./metrics";
import { paperArm, paperDay, paperStatus } from "./ops";
import { resolveAcceptPayload } from "./zone-accept";
import type { AlertStatus, OrderStatus, PaperConfig, PaperFeed, TakeProfitPlan } from "./types";

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

function matchId(path: string, pattern: RegExp): number | null {
  const match = pattern.exec(path);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) ? id : null;
}

function takeProfitPlans(body: Record<string, unknown>): TakeProfitPlan[] | undefined {
  if (!Array.isArray(body.takeProfits)) return undefined;
  return body.takeProfits.map((plan: unknown, i: number) => {
    if (!plan || typeof plan !== "object") {
      throw new PaperReject("invalid_take_profits", "tp", { index: i });
    }
    const row = plan as Record<string, unknown>;
    return {
      price: String(row.price ?? ""),
      qtyPct: String(row.qtyPct ?? ""),
    };
  });
}

function openBody(body: Record<string, unknown>) {
  const timeframes = Array.isArray(body.timeframes) ? body.timeframes.map(String) : [];
  return {
    symbol: String(body.symbol ?? ""),
    side: String(body.side ?? ""),
    stopLoss: String(body.stopLoss ?? ""),
    takeProfit: body.takeProfit == null ? undefined : String(body.takeProfit),
    takeProfits: takeProfitPlans(body),
    timeframes,
    riskPct: body.riskPct == null || body.riskPct === "" ? undefined : String(body.riskPct),
    leverage: body.leverage == null || body.leverage === "" ? undefined : String(body.leverage),
    note: body.note == null ? undefined : String(body.note),
    zoneId: parseZoneId(body.zoneId),
  };
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
          const gates = gatesFromFeedHealth(feedHealth);
          return json({
            ok: dbOk && feedHealth.ok,
            mode: "paper",
            feed: { url: feedHealth.url, ok: feedHealth.ok, klineLagOk: feedHealth.klineLagOk !== false },
            account: accountName,
            gates,
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
            const opened = await engine.open(openBody(body));
            return json(opened, 201);
          }
          return json({ error: "method not allowed" }, 405);
        }

        const closeId = matchId(path, /^\/paper\/positions\/(\d+)\/close$/);
        if (closeId != null) {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          return json(await engine.close(closeId));
        }

        if (path === "/paper/mark") {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          return json(await engine.mark());
        }

        if (path === "/paper/alerts") {
          if (req.method === "GET") {
            const statusRaw = url.searchParams.get("status") ?? "armed";
            const status: AlertStatus | "all" =
              statusRaw === "fired" || statusRaw === "cancelled" || statusRaw === "all" || statusRaw === "armed"
                ? statusRaw
                : "armed";
            return json({ mode: "paper", alerts: engine.alerts(status) });
          }
          if (req.method === "POST") {
            const body = (await req.json()) as Record<string, unknown>;
            const created = await engine.setAlert({
              symbol: String(body.symbol ?? ""),
              op: String(body.op ?? ""),
              price: String(body.price ?? ""),
              note: body.note == null ? undefined : String(body.note),
            });
            return json(created, 201);
          }
          return json({ error: "method not allowed" }, 405);
        }

        const alertCancelId = matchId(path, /^\/paper\/alerts\/(\d+)\/cancel$/);
        if (alertCancelId != null) {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          return json(engine.cancelAlert(alertCancelId));
        }

        if (path === "/paper/orders") {
          if (req.method === "GET") {
            const statusRaw = url.searchParams.get("status") ?? "pending";
            const status: OrderStatus | "all" =
              statusRaw === "filled" || statusRaw === "cancelled" || statusRaw === "rejected"
                || statusRaw === "invalidated" || statusRaw === "all" || statusRaw === "pending"
                ? statusRaw
                : "pending";
            return json({ mode: "paper", orders: engine.orders(status) });
          }
          if (req.method === "POST") {
            const body = (await req.json()) as Record<string, unknown>;
            const created = await engine.limit({
              ...openBody(body),
              limitPrice: String(body.limitPrice ?? ""),
              postOnly: body.postOnly !== false && body.postOnly !== "false" && body.postOnly !== 0,
              oco: body.oco !== false && body.oco !== "false" && body.oco !== 0,
              invalidatePrice: body.invalidatePrice == null || body.invalidatePrice === ""
                ? undefined
                : String(body.invalidatePrice),
            });
            return json(created, 201);
          }
          return json({ error: "method not allowed" }, 405);
        }

        const orderCancelId = matchId(path, /^\/paper\/orders\/(\d+)\/cancel$/);
        if (orderCancelId != null) {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          return json(engine.cancelOrder(orderCancelId));
        }

        if (path === "/paper/events") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw ? Number(limitRaw) : 50;
          return json({ mode: "paper", events: engine.events(Number.isFinite(limit) ? limit : 50) });
        }

        if (path === "/paper/status") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          return json(paperStatus(engine));
        }

        if (path === "/paper/day") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          return json(paperDay(engine, url.searchParams.get("day") ?? undefined));
        }

        if (path === "/paper/metrics") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          const days = parseMetricsDays(url.searchParams.get("days"));
          return json(paperMetrics(engine, days));
        }

        if (path === "/paper/zones") {
          if (req.method === "GET") {
            const statusRaw = url.searchParams.get("status") ?? "accepted";
            const status = statusRaw === "rejected" || statusRaw === "expired" || statusRaw === "all" || statusRaw === "accepted"
              ? statusRaw
              : "accepted";
            return json({ mode: "paper", zones: engine.zones(status) });
          }
          if (req.method === "POST") {
            const body = (await req.json()) as unknown;
            const card = await resolveAcceptPayload(body, config.feedUrl);
            return json({ mode: "paper", zone: engine.acceptZone(card) }, 201);
          }
          return json({ error: "method not allowed" }, 405);
        }

        const zoneReject = /^\/paper\/zones\/([^/]+)\/reject$/.exec(path);
        if (zoneReject) {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          let code: unknown = "ops_cancel";
          try {
            const body = (await req.json()) as Record<string, unknown>;
            if (body.code != null) code = body.code;
          } catch {
            // empty body is ops_cancel
          }
          return json({
            mode: "paper",
            zone: engine.rejectZone(decodeURIComponent(zoneReject[1] ?? ""), code),
          });
        }

        if (path === "/paper/arm") {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          const body = (await req.json()) as Record<string, unknown>;
          const armed = await paperArm(engine, {
            ...openBody(body),
            limitPrice: String(body.limitPrice ?? ""),
            postOnly: body.postOnly !== false && body.postOnly !== "false" && body.postOnly !== 0,
            oco: body.oco !== false && body.oco !== "false" && body.oco !== 0,
            invalidatePrice: body.invalidatePrice == null || body.invalidatePrice === ""
              ? undefined
              : String(body.invalidatePrice),
            alertPrice: body.alertPrice == null || body.alertPrice === ""
              ? undefined
              : String(body.alertPrice),
            alertOp: body.alertOp == null || body.alertOp === "" ? undefined : String(body.alertOp),
          });
          return json(armed, 201);
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
