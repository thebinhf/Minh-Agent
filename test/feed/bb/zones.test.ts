import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import { MAP_SYMBOL_CAP } from "../../../src/feed/bb/map";
import {
  ZONE_SUGGEST_NOTE,
  buildZones,
  parseZonesArgs,
  type SnapshotZones,
} from "../../../src/feed/bb/zones";
import { ZONE_CARD_KEYS } from "../../../src/zones/card";
import { ZONE_KLINE_LIMITS, intervalMsForTf } from "../../../src/zones/detect";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-zones-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dir, dbPath, store: openDb(dbPath) };
}

function candle(partial: Partial<BybitKline> & Pick<BybitKline, "start" | "interval">): BybitKline {
  return {
    end: partial.start + 60_000,
    open: "100",
    high: "101",
    low: "99",
    close: "100",
    volume: "10",
    turnover: "20",
    confirm: true,
    timestamp: partial.start,
    ...partial,
  };
}

function seedSupply(store: ReturnType<typeof openDb>, symbol = "BTCUSDT") {
  const step = intervalMsForTf("240");
  for (let i = 0; i < 16; i++) {
    store.saveKline(symbol, candle({
      start: i * step,
      interval: "240",
      open: "100",
      high: "101",
      low: "99",
      close: "100",
    }), 50);
  }
  store.saveKline(symbol, candle({
    start: 16 * step,
    interval: "240",
    open: "100",
    high: "101",
    low: "99",
    close: "100.2",
  }), 50);
  store.saveKline(symbol, candle({
    start: 17 * step,
    interval: "240",
    open: "100",
    high: "101",
    low: "80",
    close: "82",
  }), 50);
  store.saveKline(symbol, candle({
    start: 18 * step,
    interval: "240",
    open: "82",
    high: "86",
    low: "80",
    close: "84",
  }), 50);
}

describe("parseZonesArgs / buildZones", () => {
  test("empty args means watchlist; interval defaults to 240", () => {
    expect(parseZonesArgs([])).toEqual({ symbols: [], interval: "240" });
    expect(parseZonesArgs(["ethusdt", "--interval", "60"])).toEqual({
      symbols: ["ETHUSDT"],
      interval: "60",
    });
    expect(MAP_SYMBOL_CAP).toBe(10);
  });

  test("zones CLI/HTTP source never imports paper or arms", async () => {
    const src = await Bun.file("src/feed/bb/zones.ts").text();
    expect(src).not.toContain("src/paper");
    expect(src).not.toContain("paperArm");
    expect(src).not.toContain("engine.limit");
    expect(src).not.toContain("engine.open");
  });

  test("empty database returns the stable suggest-only shape", () => {
    const { store, dbPath } = tempDb();
    try {
      const body = buildZones(store, { symbols: ["BTCUSDT"], dbPath, now: 9 });
      expect(body.zones).toEqual([]);
      expect(body.meta.suggestOnly).toBe(true);
      expect(body.meta.autoArm).toBe(false);
      expect(body.meta.note).toBe(ZONE_SUGGEST_NOTE);
      expect(body.interval).toBe("240");
    } finally {
      store.close();
    }
  });

  test("detects a supply card from local klines and does not arm", () => {
    const { store, dbPath } = tempDb();
    try {
      seedSupply(store);
      const body = buildZones(store, { symbols: ["BTCUSDT"], dbPath, now: 1 });
      expect(body.zones.length).toBeGreaterThan(0);
      const card = body.zones.find((row) => row.side === "supply" && row.setup === "sd") ?? body.zones[0]!;
      expect(Object.keys(card)).toEqual([...ZONE_CARD_KEYS]);
      expect(card.side).toBe("supply");
      expect(card.setup).toBe("sd");
      expect(card.cancelCodes).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("a forming bar cannot change the detected cards", () => {
    const { store, dbPath } = tempDb();
    try {
      seedSupply(store);
      const before = buildZones(store, { symbols: ["BTCUSDT"], dbPath, now: 1 });
      store.saveKline("BTCUSDT", candle({
        start: 19 * intervalMsForTf("240"),
        interval: "240",
        open: "500",
        high: "1000",
        low: "1",
        close: "700",
        confirm: false,
      }), 50);
      const after = buildZones(store, { symbols: ["BTCUSDT"], dbPath, now: 1 });
      expect(after.meta.limits).toEqual({ ...ZONE_KLINE_LIMITS });
      expect(after.zones.map((row) => row.zoneId)).toEqual(before.zones.map((row) => row.zoneId));
      expect(JSON.stringify(after.zones)).toBe(JSON.stringify(before.zones));
    } finally {
      store.close();
    }
  });
});

describe("GET /zones", () => {
  test("matches buildZones, stays GET-only, and does not fill /brief-pack.zones", async () => {
    const { store, dbPath } = tempDb();
    seedSupply(store);
    store.saveTicker({
      symbol: "BTCUSDT",
      type: "snapshot",
      fields: { lastPrice: "84" },
    }, 50, false);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
      symbols: ["BTCUSDT", "ETHUSDT"],
    } as TrackerConfig, store);

    try {
      const expected = buildZones(store, { symbols: ["BTCUSDT"], dbPath });
      const res = await fetch(`http://127.0.0.1:${server.port}/zones?symbol=BTCUSDT`);
      expect(res.status).toBe(200);
      const body = await res.json() as SnapshotZones;
      expect(body.meta.suggestOnly).toBe(true);
      expect(body.meta.autoArm).toBe(false);
      expect(body.zones.map((row) => row.zoneId)).toEqual(expected.zones.map((row) => row.zoneId));
      expect(body.klineLag.intervals).toEqual(["60", "240"]);

      const bad = await fetch(`http://127.0.0.1:${server.port}/zones?interval=15`);
      expect(bad.status).toBe(400);

      const posted = await fetch(`http://127.0.0.1:${server.port}/zones`, { method: "POST" });
      expect(posted.status).toBe(405);

      const pack = await (await fetch(`http://127.0.0.1:${server.port}/brief-pack`)).json() as {
        zones: unknown[];
      };
      expect(pack.zones).toEqual([]);

      const map = await (await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`)).json() as {
        klines: Record<string, unknown>;
        zones?: unknown;
      };
      expect(map.zones).toBeUndefined();
      expect("240" in map.klines).toBe(true);
    } finally {
      server.stop();
      store.close();
    }
  });
});
