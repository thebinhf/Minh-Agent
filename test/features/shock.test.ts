import { afterEach, describe, expect, test } from "bun:test";
import type { TrackerDb } from "../../src/feed/bb/db";
import { intervalToMs } from "../../src/feed/bb/recovery";
import { parseFeaturesArgs } from "../../src/features/cli";
import { scanFeatures } from "../../src/features/scan";
import { SHOCK_NOTE, asOfShock } from "../../src/features/shock";
import { buildFeatures } from "../../src/features/snapshot";
import { cleanupMarketDbs, tempMarketDb } from "./helpers";

const H4 = intervalToMs("240");
const ASOF = 1_700_000_000_000;

afterEach(() => {
  cleanupMarketDbs();
});

function tempDb() {
  return tempMarketDb("minh-shock-");
}

function seedBar(
  store: TrackerDb,
  i: number,
  opts: { open: string; high: string; low: string; close: string; volume?: string },
) {
  const start = ASOF - (40 - i) * H4;
  store.saveKline("BTCUSDT", {
    start,
    end: start + H4,
    interval: "240",
    open: opts.open,
    high: opts.high,
    low: opts.low,
    close: opts.close,
    volume: opts.volume ?? "100",
    turnover: "1000",
    confirm: true,
    timestamp: start + H4,
  }, start + H4);
  return start;
}

function seedQuiet(store: TrackerDb, n = 36) {
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    starts.push(seedBar(store, i, {
      open: "100",
      high: "100.3",
      low: "99.7",
      close: "100.1",
      volume: i < 18 ? "90" : "110",
    }));
  }
  return starts;
}

describe("as-of kline shock", () => {
  test("empty store is missing and does not invent ATR or volume", () => {
    const { store } = tempDb();
    const row = asOfShock(store, { symbol: "BTCUSDT", asof: ASOF });
    expect(row.quality).toBe("missing");
    expect(row.reading).toBeNull();
    expect(row.atr14).toBeNull();
    expect(row.volumeZ).toBeNull();
    expect(row.note).toBe(SHOCK_NOTE);
    store.close();
  });

  test("impulse on closed 4H; future bars after asof are ignored", () => {
    const { store, dbPath } = tempDb();
    seedQuiet(store, 36);
    seedBar(store, 36, { open: "100", high: "108", low: "99.5", close: "107", volume: "100" });
    store.saveKline("BTCUSDT", {
      start: ASOF,
      end: ASOF + H4,
      interval: "240",
      open: "107",
      high: "200",
      low: "107",
      close: "199",
      volume: "9999",
      turnover: "1",
      confirm: true,
      timestamp: ASOF + H4,
    }, ASOF + H4);

    const row = asOfShock(store, { symbol: "BTCUSDT", asof: ASOF });
    expect(row.quality).toBe("ok");
    expect(row.reading).toBe("impulse");
    expect(row.flags.impulse).toBe(true);
    expect(row.startTs).toBe(ASOF - 4 * H4);
    expect(Number(row.bodyAtr)).toBeGreaterThanOrEqual(1);

    const snap = buildFeatures(store, { symbol: "BTCUSDT", asof: ASOF, dbPath });
    expect(snap.shock.reading).toBe("impulse");
    expect(snap.tape.cascade).toBeNull();
    store.close();
  });

  test("volume 0 stays missing; flat volume is not a spike", () => {
    const { store } = tempDb();
    for (let i = 0; i < 36; i++) {
      seedBar(store, i, {
        open: "100",
        high: "100.2",
        low: "99.8",
        close: "100.1",
        volume: "0",
      });
    }
    const row = asOfShock(store, { symbol: "BTCUSDT", asof: ASOF });
    expect(row.volumeZ).toBeNull();
    expect(row.flags.volSpike).toBe(false);
    store.close();
  });

  test("scan emits impulse only; no invented cascade", () => {
    const { store, dbPath } = tempDb();
    seedQuiet(store, 36);
    seedBar(store, 36, { open: "100", high: "108", low: "99.5", close: "107", volume: "100" });
    const body = scanFeatures(store, {
      symbols: ["BTCUSDT"],
      dbPath,
      fromTs: ASOF - 10 * H4,
      toTs: ASOF,
      days: 2,
    });
    expect(body.scan).toBe(true);
    expect(body.meta.autoArm).toBe(false);
    expect(body.counts.cascade).toBe(0);
    expect(body.counts.impulse).toBe(1);
    expect(body.points).toHaveLength(1);
    expect(body.points[0]?.kinds).toEqual(["impulse"]);
    expect(body.points[0]?.fields.cascade).toBe("missing");
    store.close();
  });
});

describe("features CLI", () => {
  test("snapshot vs scan args", () => {
    expect(parseFeaturesArgs([])).toEqual({ name: "snapshot", symbol: null, asofRaw: null });
    expect(parseFeaturesArgs(["ethusdt", "--asof", "1700000000000"])).toEqual({
      name: "snapshot",
      symbol: "ethusdt",
      asofRaw: "1700000000000",
    });
    expect(parseFeaturesArgs(["scan", "--days", "7"])).toMatchObject({ name: "scan", days: 7, symbols: [] });
  });
});
