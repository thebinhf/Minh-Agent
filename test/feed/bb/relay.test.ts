import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  RELAY_NOTE,
  aggregateLiqPrints,
  createLiqRelayBatch,
  createRelay,
  parseRelayArg,
  topicMatches,
} from "../../../src/feed/bb/relay";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("relay topics", () => {
  test("parses ticker / liq / kline and rejects junk", () => {
    expect(parseRelayArg("ticker.btcusdt")).toBe("ticker.BTCUSDT");
    expect(parseRelayArg("ticker.*")).toBe("ticker.*");
    expect(parseRelayArg("liq.ETHUSDT")).toBe("liq.ETHUSDT");
    expect(parseRelayArg("kline.15.btcusdt")).toBe("kline.15.BTCUSDT");
    expect(parseRelayArg("kline.240.*")).toBe("kline.240.*");
    expect(parseRelayArg("kline.D.BTCUSDT")).toBe("kline.D.BTCUSDT");
    expect(parseRelayArg("orderbook.50.BTCUSDT")).toBeNull();
    expect(parseRelayArg("tickers.BTCUSDT")).toBeNull();
  });

  test("wildcard matches the prefix only", () => {
    expect(topicMatches("liq.*", "liq.BTCUSDT")).toBe(true);
    expect(topicMatches("liq.*", "ticker.BTCUSDT")).toBe(false);
    expect(topicMatches("kline.15.*", "kline.15.ETHUSDT")).toBe(true);
    expect(topicMatches("kline.15.*", "kline.240.ETHUSDT")).toBe(false);
  });
});

describe("local /ws relay", () => {
  test("subscribe then receive matching push; HTTP GET still works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-relay-"));
    dirs.push(dir);
    const dbPath = join(dir, "market.sqlite");
    const store = openDb(dbPath);
    const relay = createRelay();
    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store, { relay });

    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { ok?: boolean };
    expect(health).toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const inbox: Array<{ topic?: string; op?: string; success?: boolean; meta?: { note: string } }> = [];
    ws.addEventListener("message", (ev) => {
      inbox.push(JSON.parse(String(ev.data)) as typeof inbox[number]);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    ws.send(JSON.stringify({ op: "subscribe", args: ["liq.BTCUSDT", "ticker.*"] }));
    await bunSleep(50);
    expect(inbox.some((row) => row.success === true && row.op === "subscribe")).toBe(true);

    relay.publish({ topic: "liq.BTCUSDT", ts: 1, data: { prints: [{ side: "Buy", size: "1" }] } });
    relay.publish({ topic: "liq.ETHUSDT", ts: 2, data: { prints: [] } });
    relay.publish({ topic: "ticker.ETHUSDT", ts: 3, data: { lastPrice: "1" } });
    await bunSleep(50);

    const topics = inbox.map((row) => row.topic).filter(Boolean);
    expect(topics).toContain("liq.BTCUSDT");
    expect(topics).toContain("ticker.ETHUSDT");
    expect(topics).not.toContain("liq.ETHUSDT");
    expect(inbox.some((row) => row.topic === "liq.BTCUSDT" && row.meta?.note === RELAY_NOTE)).toBe(true);

    ws.close();
    server.stop();
    store.close();
  });

  test("GET /ws without relay is 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-relay-off-"));
    dirs.push(dir);
    const dbPath = join(dir, "market.sqlite");
    const store = openDb(dbPath);
    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/ws`);
      expect(res.status).toBe(404);
    } finally {
      server.stop();
      store.close();
    }
  });
});

function bunSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("liq relay batch", () => {
  test("aggregates same-bucket prints and keeps sides", () => {
    const got = aggregateLiqPrints([
      { symbol: "BTCUSDT", side: "Buy", price: "99000", size: "2", exchTs: 1 },
      { symbol: "BTCUSDT", side: "Buy", price: "99020", size: "3", exchTs: 2 },
      { symbol: "BTCUSDT", side: "Sell", price: "101000", size: "4", exchTs: 3 },
    ], 50);
    expect(got.count).toBe(3);
    expect(got.longSize).toBe("5");
    expect(got.shortSize).toBe("4");
    expect(got.bins).toEqual([
      { price: "101000", longSize: "0", shortSize: "4", count: 1 },
      { price: "99000", longSize: "5", shortSize: "0", count: 2 },
    ]);
  });

  test("coalesces until the window, flushes immediately at 8 prints", () => {
    const flushed: Array<{ symbol: string; count: number }> = [];
    const batch = createLiqRelayBatch({
      everyMs: () => 60_000,
      onFlush: (symbol, payload) => flushed.push({ symbol, count: payload.count }),
    });
    const print = { symbol: "BTCUSDT", side: "Buy" as const, price: "100000", size: "1", exchTs: 1 };
    batch.push("BTCUSDT", [print, print, print]);
    expect(flushed).toEqual([]);
    batch.flush("BTCUSDT");
    expect(flushed).toEqual([{ symbol: "BTCUSDT", count: 3 }]);

    const eight = Array.from({ length: 8 }, () => print);
    batch.push("ETHUSDT", eight);
    expect(flushed).toEqual([
      { symbol: "BTCUSDT", count: 3 },
      { symbol: "ETHUSDT", count: 8 },
    ]);
  });

  test("everyMs 0 flushes on the first push", () => {
    const flushed: number[] = [];
    const batch = createLiqRelayBatch({
      everyMs: () => 0,
      onFlush: (_symbol, payload) => flushed.push(payload.count),
    });
    batch.push("BTCUSDT", [
      { symbol: "BTCUSDT", side: "Buy", price: "1", size: "1", exchTs: 1 },
    ]);
    expect(flushed).toEqual([1]);
  });
});
