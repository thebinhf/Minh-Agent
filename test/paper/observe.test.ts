import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parsePaperArgs, runPaperCommand } from "../../src/paper/cli";
import { startPaperHttp } from "../../src/paper/http";
import { createPaperEngine } from "../../src/paper/engine";
import { observerAllowsMutation, observerBlocksCommand, observerMode, paperObserve } from "../../src/paper/observe";
import { OPEN_LONG, mockFeed, paperConfig, tempStore } from "./helpers";

const dirs: string[] = [];
const saved = process.env.PAPER_OBSERVE;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (saved === undefined) delete process.env.PAPER_OBSERVE;
  else process.env.PAPER_OBSERVE = saved;
});

describe("observer lock", () => {
  test("unset is not observer; 1/on is", () => {
    delete process.env.PAPER_OBSERVE;
    expect(observerMode()).toBe(false);
    process.env.PAPER_OBSERVE = "1";
    expect(observerMode()).toBe(true);
    process.env.PAPER_OBSERVE = "on";
    expect(observerMode()).toBe(true);
    process.env.PAPER_OBSERVE = "0";
    expect(observerMode()).toBe(false);
  });

  test("CLI parses observe; PAPER_OBSERVE=1 blocks arm", async () => {
    expect(parsePaperArgs(["observe"])).toEqual({ name: "observe" });
    process.env.PAPER_OBSERVE = "1";
    const ctx = await tempStore();
    dirs.push(ctx.dir);
    const config = await paperConfig(ctx.dir);
    const engine = createPaperEngine({
      store: ctx.store,
      feed: mockFeed(),
      config,
      universe: { symbols: ["BTCUSDT"], intervals: ["15", "60", "240"] },
    });
    const snap = await runPaperCommand(engine, { name: "observe" });
    expect((snap as { mode: string }).mode).toBe("observe");
    await expect(runPaperCommand(engine, {
      name: "arm",
      symbol: "BTCUSDT",
      side: "long",
      limitPrice: "100",
      stopLoss: "90",
      takeProfit: "120",
      timeframes: ["240", "60", "15"],
      postOnly: true,
      oco: true,
    })).rejects.toMatchObject({ error: "observer" });
    ctx.store.close();
  });

  test("HTTP GET /paper/observe; POST 403 when PAPER_OBSERVE=1", async () => {
    process.env.PAPER_OBSERVE = "1";
    const ctx = await tempStore();
    dirs.push(ctx.dir);
    const config = await paperConfig(ctx.dir, { httpPort: 0 });
    const engine = createPaperEngine({
      store: ctx.store,
      feed: mockFeed(),
      config,
      universe: { symbols: ["BTCUSDT", "ETHUSDT"], intervals: ["5", "15", "60", "240"] },
    });
    const server = startPaperHttp(config, engine, mockFeed());
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const body = await (await fetch(`${url}/paper/observe`)).json() as {
        mode: string;
        observer: boolean;
        mutations: string;
      };
      expect(body.mode).toBe("observe");
      expect(body.observer).toBe(true);
      expect(body.mutations).toBe("exits-only");
      const post = await fetch(`${url}/paper/positions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(OPEN_LONG),
      });
      expect(post.status).toBe(403);
      const err = await post.json() as { error: string };
      expect(err.error).toBe("observer");
    } finally {
      server.stop();
      ctx.store.close();
    }
  });

  test("the lock splits exits from entries on both surfaces", async () => {
    process.env.PAPER_OBSERVE = "1";
    for (const path of [
      "/paper/positions/7/close", "/paper/orders/7/cancel", "/paper/alerts/7/cancel", "/paper/mark",
    ]) {
      expect(observerAllowsMutation(path)).toBe(true);
    }
    for (const path of [
      "/paper/positions", "/paper/orders", "/paper/alerts", "/paper/arm", "/paper/zones",
      "/paper/zones/btc-4h-s-1/reject", "/paper/positions/7/not-a-route",
    ]) {
      expect(observerAllowsMutation(path)).toBe(false);
    }
    expect(["close", "cancel", "alert-cancel", "mark"].map(observerBlocksCommand)).toEqual([false, false, false, false]);
    expect(["open", "limit", "arm", "zone-accept", "zone-reject", "alert-set"].map(observerBlocksCommand))
      .toEqual([true, true, true, true, true, true]);

    const ctx = await tempStore();
    dirs.push(ctx.dir);
    const config = await paperConfig(ctx.dir);
    const engine = createPaperEngine({
      store: ctx.store,
      feed: mockFeed(),
      config,
      universe: { symbols: ["BTCUSDT"], intervals: ["15", "60", "240"] },
    });
    // An exit must fail for the boring reason (nothing with that id), never because
    // the operator is locked out of getting flat.
    for (const command of [
      { name: "close", id: 4242 }, { name: "cancel", id: 4242 },
      { name: "alert-cancel", id: 4242 }, { name: "mark" },
    ] as const) {
      const outcome = await runPaperCommand(engine, command as never).catch((error: unknown) => error);
      expect((outcome as { error?: string })?.error).not.toBe("observer");
    }
    ctx.store.close();
  });

  test("HTTP lets the four exit routes through and still 403s an entry", async () => {
    process.env.PAPER_OBSERVE = "1";
    const ctx = await tempStore();
    dirs.push(ctx.dir);
    const config = await paperConfig(ctx.dir, { httpPort: 0 });
    const engine = createPaperEngine({
      store: ctx.store,
      feed: mockFeed(),
      config,
      universe: { symbols: ["BTCUSDT"], intervals: ["15", "60", "240"] },
    });
    const server = startPaperHttp(config, engine, mockFeed());
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const marked = await fetch(`${url}/paper/mark`, { method: "POST" });
      expect(marked.status).not.toBe(403);
      const close = await fetch(`${url}/paper/positions/4242/close`, { method: "POST" });
      expect(close.status).not.toBe(403);
      const arm = await fetch(`${url}/paper/arm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(OPEN_LONG),
      });
      expect(arm.status).toBe(403);
      expect(((await arm.json()) as { message: string }).message).toContain("exits allowed");
    } finally {
      server.stop();
      ctx.store.close();
    }
  });

  test("acceptZone emits zone.accepted", async () => {
    delete process.env.PAPER_OBSERVE;
    const ctx = await tempStore();
    dirs.push(ctx.dir);
    const config = await paperConfig(ctx.dir);
    const engine = createPaperEngine({
      store: ctx.store,
      feed: mockFeed(),
      config,
      universe: { symbols: ["BTCUSDT"], intervals: ["15", "60", "240"] },
    });
    const card = {
      zoneId: "btc-4h-s-20260908-01",
      symbol: "BTCUSDT",
      tf: "240",
      side: "supply",
      setup: "sd",
      baseStartTs: 1_788_801_600_000,
      baseEndTs: 1_788_808_800_000,
      zoneLow: 79_250,
      zoneHigh: 79_472,
      distal: 79_472,
      proximal: 79_250,
      impulseBody: 980,
      atr14: 720,
      impulseAtr: 1.36,
      departureAtr: 0.42,
      freshness: "virgin",
      penetrationPct: 0,
      entry: 79_300,
      sl: 79_880,
      tp: 77_580,
      rr: 2.97,
      hardInvalid: 79_880,
      softInvalid: 79_472,
      expiryBars: 48,
      cancelCodes: [],
    };
    engine.acceptZone(card);
    const kinds = engine.events(10).map((row) => row.kind);
    expect(kinds).toContain("zone.accepted");
    const snap = paperObserve(engine);
    expect(snap.standing.accepted).toBe(1);
    ctx.store.close();
  });
});
