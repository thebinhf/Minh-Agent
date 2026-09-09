import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { startPaperHttp } from "../../src/paper/http";
import { createPaperEngine } from "../../src/paper/engine";
import { Dec } from "../../src/paper/decimal";
import { liqPrice } from "../../src/paper/phase2";
import { requireInstrument, snapPrice } from "../../src/paper/venue";
import { OPEN_LONG, mockFeed, paperConfig, tempStore } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function serve(feed = mockFeed()) {
  const ctx = await tempStore();
  dirs.push(ctx.dir);
  const config = await paperConfig(ctx.dir, { httpPort: 0 });
  const engine = createPaperEngine({
    store: ctx.store,
    feed,
    config,
    universe: { symbols: ["BTCUSDT", "ETHUSDT"], intervals: ["5", "15", "60", "240"] },
  });
  const server = startPaperHttp(config, engine, feed);
  return {
    engine,
    store: ctx.store,
    feed,
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop();
      ctx.store.close();
    },
  };
}

describe("paper HTTP", () => {
  test("health / account / open / mark / close shapes", async () => {
    const svc = await serve();
    try {
      const health = await (await fetch(`${svc.url}/paper/health`)).json() as Record<string, unknown>;
      expect(health.ok).toBe(true);
      expect(health.mode).toBe("paper");
      expect(health.account).toBe("minh-paper");

      const account = await (await fetch(`${svc.url}/paper/account`)).json() as Record<string, unknown>;
      expect(account.mode).toBe("paper");
      expect(account.cash).toBe("10000");
      expect(account.minRr).toBeNull();
      expect(account.riskPctMin).toBe("0.01");
      expect(account.riskPctMax).toBe("0.10");
      expect(account.feeRate).toBe("0");
      expect(account.defaultLeverage).toBe("1");
      expect(account.marginMode).toBe("isolated");

      const opened = await fetch(`${svc.url}/paper/positions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...OPEN_LONG, qty: "99" }),
      });
      expect(opened.status).toBe(201);
      const openedBody = await opened.json() as { mode: string; position: { id: number; qty: string; rr: string } };
      expect(openedBody.mode).toBe("paper");
      expect(openedBody.position.qty).toBe("0.1");
      expect(openedBody.position.rr).toBe("1");

      const listed = await (await fetch(`${svc.url}/paper/positions?status=open`)).json() as { positions: unknown[] };
      expect(listed.positions).toHaveLength(1);

      const marked = await fetch(`${svc.url}/paper/mark`, { method: "POST" });
      expect(marked.status).toBe(200);
      const markBody = await marked.json() as {
        mode: string;
        positions: unknown[];
        closed: unknown[];
        funding: unknown[];
      };
      expect(markBody.mode).toBe("paper");
      expect(markBody.closed).toEqual([]);
      expect(markBody.funding).toEqual([]);

      const closed = await fetch(`${svc.url}/paper/positions/${openedBody.position.id}/close`, { method: "POST" });
      expect(closed.status).toBe(200);
      const closedBody = await closed.json() as { mode: string; position: { status: string; closeReason: string } };
      expect(closedBody.mode).toBe("paper");
      expect(closedBody.position.status).toBe("closed");
      expect(closedBody.position.closeReason).toBe("manual");

      const again = await fetch(`${svc.url}/paper/positions/${openedBody.position.id}/close`, { method: "POST" });
      expect(again.status).toBe(409);
      const againBody = await again.json() as { error: string };
      expect(againBody.error).toBe("already_closed");
    } finally {
      svc.stop();
    }
  });

  test("accepts leverage and takeProfits on open", async () => {
    const svc = await serve();
    try {
      const opened = await fetch(`${svc.url}/paper/positions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...OPEN_LONG,
          leverage: "10",
          takeProfits: [
            { price: "64500", qtyPct: "0.5" },
            { price: "66000", qtyPct: "0.5" },
          ],
        }),
      });
      expect(opened.status).toBe(201);
      const body = await opened.json() as {
        position: { leverage: string; liqPrice: string; takeProfits: Array<{ price: string }> };
      };
      expect(body.position.leverage).toBe("10");
      expect(body.position.liqPrice).toBe(
        snapPrice(liqPrice("long", Dec.from("63000"), Dec.from("10"), Dec.from("0.005")), requireInstrument("BTCUSDT")).toText(),
      );
      expect(body.position.takeProfits.map((plan) => plan.price)).toEqual(["64500", "66000"]);
    } finally {
      svc.stop();
    }
  });

  test("rejects out-of-band risk and GET on mutating paths", async () => {
    const svc = await serve();
    try {
      const bad = await fetch(`${svc.url}/paper/positions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...OPEN_LONG, riskPct: "0.15" }),
      });
      expect(bad.status).toBe(400);
      const body = await bad.json() as { mode: string; error: string; gate: string };
      expect(body).toMatchObject({ mode: "paper", error: "risk_pct_out_of_band", gate: "risk_pct" });

      const getMark = await fetch(`${svc.url}/paper/mark`);
      expect(getMark.status).toBe(405);

      const missing = await fetch(`${svc.url}/paper/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "not found" });
    } finally {
      svc.stop();
    }
  });

  test("arms and lists alerts over HTTP", async () => {
    const svc = await serve();
    try {
      const created = await fetch(`${svc.url}/paper/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: "BTCUSDT", op: "below", price: "60000" }),
      });
      expect(created.status).toBe(201);
      const body = await created.json() as { mode: string; alert: { status: string; op: string } };
      expect(body.mode).toBe("paper");
      expect(body.alert.status).toBe("armed");
      expect(body.alert.op).toBe("below");
      const listed = await (await fetch(`${svc.url}/paper/alerts`)).json() as { alerts: unknown[] };
      expect(listed.alerts).toHaveLength(1);
      const account = await (await fetch(`${svc.url}/paper/account`)).json() as { makerFeeRate: string; armedAlerts: number };
      expect(account.makerFeeRate).toBe("0");
      expect(account.armedAlerts).toBe(1);
    } finally {
      svc.stop();
    }
  });

  test("status and arm over HTTP", async () => {
    const svc = await serve(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    try {
      const armed = await fetch(`${svc.url}/paper/arm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...OPEN_LONG, limitPrice: "62000" }),
      });
      expect(armed.status).toBe(201);
      const body = await armed.json() as { arm: boolean; order: { status: string }; alert: { op: string } };
      expect(body.arm).toBe(true);
      expect(body.order.status).toBe("pending");
      expect(body.alert.op).toBe("below");
      const status = await (await fetch(`${svc.url}/paper/status`)).json() as {
        pending: unknown[];
        alerts: unknown[];
      };
      expect(status.pending).toHaveLength(1);
      expect(status.alerts).toHaveLength(1);
    } finally {
      svc.stop();
    }
  });

  test("rejects new positions when kline lag is down and exposes metrics shape", async () => {
    const svc = await serve(mockFeed({ klineLagOk: false }));
    try {
      const opened = await fetch(`${svc.url}/paper/positions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(OPEN_LONG),
      });
      expect(opened.status).toBe(400);
      const rejectBody = await opened.json() as {
        mode: string;
        error: string;
        gate: string;
        tradingAllowed: boolean;
        reasons: string[];
      };
      expect(rejectBody).toMatchObject({
        mode: "paper",
        error: "kline_lag",
        gate: "gates",
        tradingAllowed: false,
        reasons: ["kline_lag"],
      });

      const limited = await fetch(`${svc.url}/paper/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...OPEN_LONG, limitPrice: "62000" }),
      });
      expect(limited.status).toBe(400);
      expect((await limited.json() as { error: string }).error).toBe("kline_lag");

      const armed = await fetch(`${svc.url}/paper/arm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...OPEN_LONG, limitPrice: "62000" }),
      });
      expect(armed.status).toBe(400);
      expect((await armed.json() as { error: string }).error).toBe("kline_lag");

      const health = await (await fetch(`${svc.url}/paper/health`)).json() as {
        gates: { tradingAllowed: boolean; reasons: string[] };
      };
      expect(health.gates).toEqual({ tradingAllowed: false, reasons: ["kline_lag"] });
    } finally {
      svc.stop();
    }
  });

  test("GET /paper/metrics?days= returns the stable schema", async () => {
    const svc = await serve();
    try {
      const res = await fetch(`${svc.url}/paper/metrics?days=7`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.mode).toBe("paper");
      expect(body.days).toBe(7);
      expect(body.winRate).toBeNull();
      expect(body.avgRr).toBeNull();
      expect(body.noFillPct).toBeNull();
      expect(body.trades).toBe(0);
      expect(body.byZone).toEqual([]);
      expect(body.closeReasons).toEqual({ sl: 0, tp: 0, liq: 0, manual: 0 });

      const bad = await fetch(`${svc.url}/paper/metrics?days=0`);
      expect(bad.status).toBe(400);
      const badBody = await bad.json() as { error: string; gate: string };
      expect(badBody.error).toBe("invalid_days");
    } finally {
      svc.stop();
    }
  });
});
