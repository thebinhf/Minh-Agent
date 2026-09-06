import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { startPaperHttp } from "../../src/paper/http";
import { createPaperEngine } from "../../src/paper/engine";
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
      expect(account.feeRate).toBe("0");
      expect(account.defaultLeverage).toBe("1");

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
      expect(body.position.liqPrice).toBe("57015");
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
        body: JSON.stringify({ ...OPEN_LONG, riskPct: "0.08" }),
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
});
