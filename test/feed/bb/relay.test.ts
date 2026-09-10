import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  RELAY_NOTE,
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
