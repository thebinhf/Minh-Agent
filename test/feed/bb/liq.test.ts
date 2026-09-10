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
  type LiqPrint,
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

function print(partial: Partial<LiqPrint> & { exchTs: number; price: string; size: string }): LiqPrint {
  return {
    symbol: "BTCUSDT",
    side: "Buy",
    ...partial,
  };
}

const now = 10_000_000;

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
});

describe("liq cascade", () => {
  test("mixed sides are not a cascade even when the burst is huge", () => {
    const got = liqCascade({
      now,
      prints: [
        print({ side: "Buy", price: "99000", size: "40", exchTs: now - 30_000 }),
        print({ side: "Sell", price: "101000", size: "40", exchTs: now - 20_000 }),
        print({ side: "Buy", price: "98000", size: "1", exchTs: now - 3_600_000 }),
      ],
    });
    expect(got.side).toBeNull();
    expect(got.active).toBe(false);
    expect(got.walk).toBe(false);
  });

  test("quiet tape + three same-price prints is not a cascade", () => {
    const got = liqCascade({
      now,
      prints: [
        print({ price: "100000", size: "2", exchTs: now - 40_000 }),
        print({ price: "100000", size: "2", exchTs: now - 20_000 }),
        print({ price: "100000", size: "2", exchTs: now - 5_000 }),
      ],
    });
    expect(got.side).toBe("long");
    expect(got.intensity).toBeNull();
    expect(got.walk).toBe(false);
    expect(got.active).toBe(false);
  });

  test("long walk + intensity vs baseline is active; fuel is remaining below last", () => {
    const burst = [0, 1, 2, 3].map((i) => print({
      price: String(100400 - i * 200),
      size: "8",
      exchTs: now - 200_000 + i * 40_000,
    }));
    const got = liqCascade({
      now,
      lastPrice: 100000,
      below: 12,
      above: 0,
      prints: [
        print({ price: "100000", size: "1", exchTs: now - 3_600_000 }),
        ...burst,
      ],
    });
    expect(got.side).toBe("long");
    expect(got.walk).toBe(true);
    expect(Number(got.intensity)).toBeGreaterThanOrEqual(3);
    expect(got.active).toBe(true);
    expect(got.fuel).toBe("12");
  });

  test("same-price burst + OI flush confirms without a walk", () => {
    const burst = [0, 1, 2, 3].map((i) => print({
      price: "100000",
      size: "8",
      exchTs: now - 180_000 + i * 30_000,
    }));
    const noOi = liqCascade({
      now,
      prints: [
        print({ price: "100000", size: "1", exchTs: now - 3_600_000 }),
        ...burst,
      ],
    });
    expect(noOi.walk).toBe(false);
    expect(noOi.active).toBe(false);

    const withOi = liqCascade({
      now,
      oiReading: "flush",
      prints: [
        print({ price: "100000", size: "1", exchTs: now - 3_600_000 }),
        ...burst,
      ],
    });
    expect(withOi.active).toBe(true);
    expect(withOi.side).toBe("long");
  });

  test("cold start needs eight walking prints when there is no baseline", () => {
    const few = [0, 1, 2, 3].map((i) => print({
      price: String(100400 - i * 200),
      size: "2",
      exchTs: now - 200_000 + i * 40_000,
    }));
    expect(liqCascade({ now, prints: few }).active).toBe(false);

    const many = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => print({
      price: String(100700 - i * 100),
      size: "2",
      exchTs: now - 240_000 + i * 25_000,
    }));
    const got = liqCascade({ now, prints: many });
    expect(got.intensity).toBeNull();
    expect(got.walk).toBe(true);
    expect(got.active).toBe(true);
  });
});

describe("liq heatmap + MAP", () => {
  test("buckets prints and flags below/above last", async () => {
    const { store, dbPath } = tempDb();
    const ts = Date.now();
    store.saveLiquidation({
      symbol: "BTCUSDT", side: "Buy", price: "99000", size: "10", exchTs: ts - 60_000,
    }, ts);
    store.saveLiquidation({
      symbol: "BTCUSDT", side: "Sell", price: "101000", size: "4", exchTs: ts - 120_000,
    }, ts);
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "100000" },
    }, ts, false);

    const heat = buildLiqHeatmap(store, {
      symbol: "BTCUSDT",
      dbPath,
      now: ts,
      hours: 1,
      bucket: 1000,
      lastPrice: "100000",
    });
    expect(heat.longSize).toBe("10");
    expect(heat.shortSize).toBe("4");
    expect(heat.bins.some((bin) => bin.price === "99000" && bin.longSize === "10")).toBe(true);
    expect(heat.cascade.active).toBe(false);
    expect(heat.meta.note).toBe(LIQ_NOTE);

    const mapLiq = buildMapLiq(store, "BTCUSDT", "100000", ts);
    expect(mapLiq.below).toBe("10");
    expect(mapLiq.above).toBe("4");
    expect(mapLiq.cascade.active).toBe(false);
    expect(mapLiq.note).toBe(LIQ_NOTE);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/liq-heatmap?symbol=BTCUSDT&bucket=1000`);
      expect(res.status).toBe(200);
      const body = await res.json() as { longSize: string; cascade: { active: boolean }; meta: { note: string } };
      expect(body.longSize).toBe("10");
      expect(body.cascade.active).toBe(false);
      expect(body.meta.note).toBe(LIQ_NOTE);
    } finally {
      server.stop();
      store.close();
    }
  });
});
