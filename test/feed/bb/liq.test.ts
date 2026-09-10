import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  LIQ_NOTE,
  buildLiqHeatmap,
  buildMapLiq,
  liqCascade,
  parseLiqPrints,
} from "../../../src/feed/bb/liq";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-liq-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dbPath, store: openDb(dbPath) };
}

describe("liq prints", () => {
  test("parses Buy as long-liq and Sell as short-liq", () => {
    const prints = parseLiqPrints([
      { T: 1_000, s: "BTCUSDT", S: "Buy", v: "2", p: "99000" },
      { T: 2_000, s: "BTCUSDT", S: "Sell", v: "3", p: "101000" },
      { T: 3_000, s: "BTCUSDT", S: "Nope", v: "1", p: "1" },
    ]);
    expect(prints).toEqual([
      { symbol: "BTCUSDT", side: "Buy", price: "99000", size: "2", exchTs: 1_000 },
      { symbol: "BTCUSDT", side: "Sell", price: "101000", size: "3", exchTs: 2_000 },
    ]);
  });

  test("cascade when a 5m burst is 3x the window average", () => {
    const now = 10_000_000;
    expect(liqCascade([
      { exchTs: now - 60_000, size: "30" },
      { exchTs: now - 3_600_000, size: "1" },
    ], now)).toBe(true);
    expect(liqCascade([
      { exchTs: now - 60_000, size: "1" },
      { exchTs: now - 3_600_000, size: "30" },
    ], now)).toBe(false);
  });
});

describe("liq heatmap + MAP", () => {
  test("buckets prints and flags below/above last", async () => {
    const { store, dbPath } = tempDb();
    const now = Date.now();
    store.saveLiquidation({
      symbol: "BTCUSDT", side: "Buy", price: "99000", size: "10", exchTs: now - 60_000,
    }, now);
    store.saveLiquidation({
      symbol: "BTCUSDT", side: "Sell", price: "101000", size: "4", exchTs: now - 120_000,
    }, now);
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "100000" },
    }, now, false);

    const heat = buildLiqHeatmap(store, {
      symbol: "BTCUSDT",
      dbPath,
      now,
      hours: 1,
      bucket: 1000,
      lastPrice: "100000",
    });
    expect(heat.longSize).toBe("10");
    expect(heat.shortSize).toBe("4");
    expect(heat.bins.some((bin) => bin.price === "99000" && bin.longSize === "10")).toBe(true);
    expect(heat.meta.note).toBe(LIQ_NOTE);

    const mapLiq = buildMapLiq(store, "BTCUSDT", "100000", now);
    expect(mapLiq.below).toBe("10");
    expect(mapLiq.above).toBe("4");
    expect(mapLiq.note).toBe(LIQ_NOTE);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/liq-heatmap?symbol=BTCUSDT&bucket=1000`);
      expect(res.status).toBe(200);
      const body = await res.json() as { longSize: string; meta: { note: string } };
      expect(body.longSize).toBe("10");
      expect(body.meta.note).toBe(LIQ_NOTE);
    } finally {
      server.stop();
      store.close();
    }
  });
});
