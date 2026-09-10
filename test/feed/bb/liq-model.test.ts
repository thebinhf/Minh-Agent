import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  LIQ_MODEL_MIX,
  LIQ_MODEL_NOTE,
  buildLiqModel,
  isolatedLiq,
  liqModelLongShare,
} from "../../../src/feed/bb/liq-model";
import { parseRestRiskLimit, resetRiskLimitCache } from "../../../src/feed/bb/rest";
import type { BybitKline, TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  resetRiskLimitCache();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-liq-model-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dbPath, store: openDb(dbPath) };
}

function candle(partial: Partial<BybitKline> & Pick<BybitKline, "start">): BybitKline {
  return {
    end: partial.start + 15 * 60_000,
    interval: "15",
    open: "100000",
    close: "100000",
    high: "100100",
    low: "99900",
    volume: "1",
    turnover: "100000",
    confirm: true,
    timestamp: partial.start,
    ...partial,
  };
}

describe("liq model math", () => {
  test("isolated formula matches Bybit IM/MM long and short", () => {
    expect(isolatedLiq("long", 100_000, 10, 0.005)).toBeCloseTo(90_452.2613, 3);
    expect(isolatedLiq("short", 100_000, 10, 0.005)).toBeCloseTo(109_452.7363, 3);
  });

  test("public mix weights sum to 1", () => {
    const sum = LIQ_MODEL_MIX.reduce((acc, row) => acc + row.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  test("crowded funding tilts longShare; fair stays 0.5", () => {
    expect(liqModelLongShare(null)).toBe(0.5);
    expect(liqModelLongShare("0.0001")).toBe(0.5);
    expect(liqModelLongShare("0.001")).toBe(0.65);
    expect(liqModelLongShare("-0.001")).toBe(0.35);
  });

  test("parseRestRiskLimit prefers isLowestRisk", () => {
    expect(parseRestRiskLimit([
      { maintenanceMargin: 0.02, maxLeverage: "25", isLowestRisk: 0 },
      { maintenanceMargin: 0.005, maxLeverage: "100", isLowestRisk: 1 },
    ])).toEqual({ mmRate: "0.005", maxLeverage: "100" });
  });
});

describe("buildLiqModel", () => {
  test("missing last or OI is broken, not painted", () => {
    const { store, dbPath } = tempDb();
    try {
      const empty = buildLiqModel(store, { dbPath, mmRate: "0.005" });
      expect(empty.ok).toBe(false);
      expect(empty.broken).toBe("missing_last");
      expect(empty.meta.note).toBe(LIQ_MODEL_NOTE);
      expect(empty.bins).toEqual([]);

      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: { lastPrice: "100000" },
      }, 1, false);
      const noOi = buildLiqModel(store, { dbPath, mmRate: "0.005" });
      expect(noOi.broken).toBe("missing_oi");
    } finally {
      store.close();
    }
  });

  test("inventory-caps each side at OI/2 and labels the model", () => {
    const { store, dbPath } = tempDb();
    try {
      store.saveTicker({
        symbol: "BTCUSDT",
        type: "snapshot",
        fields: {
          lastPrice: "100000",
          openInterestValue: "1000",
          openInterest: "0.01",
          fundingRate: "0.001",
        },
      }, 1, false);
      store.saveKline("BTCUSDT", candle({ start: 15 * 60_000, close: "100000", turnover: "100000" }), 1);
      store.saveKline("BTCUSDT", candle({ start: 30 * 60_000, close: "100200", turnover: "100000" }), 1);

      const model = buildLiqModel(store, { dbPath, mmRate: "0.005", bucket: 50 });
      expect(model.ok).toBe(true);
      expect(model.broken).toBeNull();
      expect(model.meta.note).toBe(LIQ_MODEL_NOTE);
      expect(model.mmSource).toBe("default");
      expect(model.longShare).toBe("0.65");
      expect(model.scaled).toBe(true);
      expect(Number(model.longSize)).toBeCloseTo(500, 6);
      expect(Number(model.shortSize)).toBeCloseTo(350, 6);
      expect(model.bins.length).toBeGreaterThan(0);
      expect(model.bins.some((bin) => Number(bin.longSize) > 0)).toBe(true);
      expect(model.bins.some((bin) => Number(bin.shortSize) > 0)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("GET /liq-model is separate from /liq-heatmap", async () => {
    const { store, dbPath } = tempDb();
    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const model = await (await fetch(`http://127.0.0.1:${server.port}/liq-model`)).json() as {
        ok: boolean;
        meta: { note: string };
      };
      const heat = await (await fetch(`http://127.0.0.1:${server.port}/liq-heatmap`)).json() as {
        cascade?: { active?: boolean };
        meta: { note: string };
      };
      expect(model.meta.note).toBe(LIQ_MODEL_NOTE);
      expect(model.ok).toBe(false);
      expect(heat.meta.note).toBe("quant veto — not a signal");
      expect(typeof heat.cascade?.active).toBe("boolean");
    } finally {
      server.stop();
      store.close();
    }
  });
});
