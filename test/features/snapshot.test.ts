import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/feed/bb/db";
import { startHttp } from "../../src/feed/bb/http";
import { intervalToMs } from "../../src/feed/bb/recovery";
import type { TrackerConfig } from "../../src/feed/bb/types";
import { FEATURES_NOTE, buildFeatures, parseFeaturesAsof } from "../../src/features/snapshot";

const dirs: string[] = [];
const H4 = intervalToMs("240");
const ASOF = 1_700_000_000_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-features-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dbPath, store: openDb(dbPath) };
}

describe("parseFeaturesAsof", () => {
  test("blank is now; epoch and ISO parse; junk is features_asof", () => {
    const now = 5_000;
    expect(parseFeaturesAsof(null, now)).toBe(now);
    expect(parseFeaturesAsof("", now)).toBe(now);
    expect(parseFeaturesAsof(String(ASOF), now)).toBe(ASOF);
    expect(parseFeaturesAsof("2026-08-01T00:00:00.000Z", now)).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
    expect(parseFeaturesAsof("nope", now)).toEqual({ error: "features_asof" });
  });
});

describe("GET /features", () => {
  test("empty store is missing and does not invent tape", () => {
    const { store, dbPath } = tempDb();
    const snap = buildFeatures(store, { symbol: "BTCUSDT", asof: ASOF, dbPath });
    expect(snap.quality).toBe("missing");
    expect(snap.tape).toEqual({
      crowded: null,
      oiReading: null,
      cascade: null,
      flowReading: null,
    });
    expect(snap.meta.note).toBe(FEATURES_NOTE);
    store.close();
  });

  test("asof cuts future funding; GET returns the same tape; /map unchanged", async () => {
    const { store, dbPath } = tempDb();
    const closed = ASOF - H4;
    store.saveKline("BTCUSDT", {
      start: closed - H4,
      end: closed,
      interval: "240",
      open: "100",
      high: "110",
      low: "99",
      close: "100",
      volume: "1",
      turnover: "1",
      confirm: true,
      timestamp: closed,
    }, ASOF);
    store.saveKline("BTCUSDT", {
      start: closed,
      end: ASOF,
      interval: "240",
      open: "100",
      high: "120",
      low: "100",
      close: "110",
      volume: "1",
      turnover: "1",
      confirm: true,
      timestamp: ASOF,
    }, ASOF);
    store.saveOi("BTCUSDT", "240", { startTs: closed - H4, openInterest: "100" }, ASOF);
    store.saveOi("BTCUSDT", "240", { startTs: closed, openInterest: "130" }, ASOF);
    store.saveFunding("BTCUSDT", { fundingTs: ASOF, fundingRate: "0.001" }, ASOF);
    store.saveFunding("BTCUSDT", { fundingTs: ASOF + 1, fundingRate: "0.05" }, ASOF);

    const snap = buildFeatures(store, { symbol: "btcusdt", asof: ASOF, dbPath });
    expect(snap.quality).toBe("asof");
    expect(snap.tape.crowded).toBe("long");
    expect(snap.tape.oiReading).toBe("long_add");
    expect(snap.fields.cascade).toBe("missing");

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const bad = await fetch(`http://127.0.0.1:${server.port}/features?asof=nope`);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "features_asof" });

      const res = await fetch(`http://127.0.0.1:${server.port}/features?symbol=BTCUSDT&asof=${ASOF}`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        quality: string;
        tape: { crowded: string; oiReading: string };
        meta: { note: string };
      };
      expect(body.quality).toBe("asof");
      expect(body.tape.crowded).toBe("long");
      expect(body.tape.oiReading).toBe("long_add");
      expect(body.meta.note).toBe(FEATURES_NOTE);

      const map = await (await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`)).json() as {
        meta: { note: string };
        funding?: { crowded?: string };
      };
      expect(map.meta.note).toBe("htf map — agent draws S/D; no bias");
    } finally {
      server.stop();
      store.close();
    }
  });
});
