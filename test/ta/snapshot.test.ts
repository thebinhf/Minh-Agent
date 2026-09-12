import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type TrackerDb } from "../../src/feed/bb/db";
import { startHttp } from "../../src/feed/bb/http";
import { intervalToMs } from "../../src/feed/bb/recovery";
import type { TrackerConfig } from "../../src/feed/bb/types";
import { TA_KLINE_LIMIT, TA_METHOD_IDS, TA_NOTE } from "../../src/ta/catalog";
import { buildTa, parseTaAsof } from "../../src/ta/snapshot";
import { parseTaArgs } from "../../src/ta/cli";

const dirs: string[] = [];
const stores: TrackerDb[] = [];
const H4 = intervalToMs("240");
const ASOF = 1_700_000_000_000;

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may keep the sqlite handle until process exit.
    }
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-ta-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  const store = openDb(dbPath);
  stores.push(store);
  return { dbPath, store };
}

function seedTrend(store: ReturnType<typeof openDb>, n = 40) {
  for (let i = 0; i < n; i++) {
    const start = ASOF - (n - i) * H4;
    const cycle = Math.floor(i / 4);
    const phase = i % 4;
    const base = 100 + cycle * 8;
    let open = base + 2;
    let high = base + 3;
    let low = base + 1;
    let close = base + 2;
    if (phase === 1) {
      low = base;
      close = base + 1;
    } else if (phase === 2) {
      high = base + 10;
      low = base + 1;
      close = base + 9;
      open = base + 1;
    } else if (phase === 3) {
      open = base + 9;
      high = base + 12;
      low = base + 8;
      close = base + 10;
    }
    store.saveKline("BTCUSDT", {
      start,
      end: start + H4,
      interval: "240",
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(close),
      volume: "100",
      turnover: "1000",
      confirm: true,
      timestamp: start + H4,
    }, start + H4);
  }
}

describe("parseTaAsof / parseTaArgs", () => {
  test("blank is now; junk is ta_asof; CLI defaults 240", () => {
    const now = 5_000;
    expect(parseTaAsof(null, now)).toBe(now);
    expect(parseTaAsof("nope", now)).toEqual({ error: "ta_asof" });
    expect(parseTaArgs([]).interval).toBe("240");
    expect(parseTaArgs(["ethusdt"]).symbol).toBe("ETHUSDT");
  });
});

describe("GET /ta", () => {
  test("empty store is missing and does not invent price methods", () => {
    const { store, dbPath } = tempDb();
    const snap = buildTa(store, { symbol: "BTCUSDT", asof: ASOF, dbPath });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.quality).toBe("missing");
    expect(snap.last).toBeNull();
    expect(snap.meta.note).toBe(TA_NOTE);
    expect(snap.meta.signal).toBe(false);
    expect(snap.meta.autoArm).toBe(false);
    expect(snap.meta.ictAsSignal).toBe(false);
    expect(Object.keys(snap.methods)).toHaveLength(TA_METHOD_IDS.length);
    expect(snap.methods.fibonacci.quality).toBe("missing");
    expect(snap.methods.moon_phases.quality).toBe("ok");
    store.close();
  });

  test("GET returns the pack; bad interval/asof 400; /map unchanged", async () => {
    const { store, dbPath } = tempDb();
    seedTrend(store);
    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const badAsof = await fetch(`http://127.0.0.1:${server.port}/ta?asof=nope`);
      expect(badAsof.status).toBe(400);
      expect(await badAsof.json()).toEqual({ error: "ta_asof" });

      const badTf = await fetch(`http://127.0.0.1:${server.port}/ta?interval=1`);
      expect(badTf.status).toBe(400);
      expect(await badTf.json()).toEqual({ error: "ta_interval" });

      const res = await fetch(`http://127.0.0.1:${server.port}/ta?symbol=BTCUSDT&interval=240&asof=${ASOF}`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        quality: string;
        methods: Record<string, { signal: boolean; quality: string }>;
        meta: { note: string; autoArm: boolean; ictAsSignal: boolean };
      };
      expect(body.quality).toBe("ok");
      expect(body.meta.note).toBe(TA_NOTE);
      expect(body.meta.autoArm).toBe(false);
      expect(body.meta.ictAsSignal).toBe(false);
      expect(body.methods.market_structure.quality).toBe("ok");
      expect(body.methods.fvg.signal).toBe(false);

      const map = await (await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`)).json() as {
        meta: { note: string };
      };
      expect(map.meta.note).toBe("htf map — agent draws S/D; no bias");
    } finally {
      server.stop();
      store.close();
    }
  });

  test("historical asof reads closed bars at asof, not the latest window", () => {
    const { store, dbPath } = tempDb();
    seedTrend(store, 40);
    for (let i = 0; i < TA_KLINE_LIMIT + 10; i++) {
      const start = ASOF + i * H4;
      store.saveKline("BTCUSDT", {
        start,
        end: start + H4,
        interval: "240",
        open: "900",
        high: "910",
        low: "890",
        close: "905",
        volume: "1",
        turnover: "1",
        confirm: true,
        timestamp: start + H4,
      }, start + H4);
    }
    const snap = buildTa(store, { symbol: "BTCUSDT", asof: ASOF, dbPath });
    expect("error" in snap).toBe(false);
    if ("error" in snap) return;
    expect(snap.quality).toBe("ok");
    expect(snap.last?.startTs).toBe(ASOF - H4);
    expect(snap.last?.close).not.toBe(905);
    store.close();
  });
});
