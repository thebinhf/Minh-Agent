import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import { mapClosePath, writeMapSnapshot } from "../../../src/feed/bb/map-close";
import {
  liveShadowObserveUrl,
  observeTapeFromMap,
  readObserveShadow,
} from "../../../src/feed/bb/observe";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];
const savedShadow = {
  LIVE_SHADOW: process.env.LIVE_SHADOW,
  LIVE_SHADOW_URL: process.env.LIVE_SHADOW_URL,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedShadow)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function feedConfig(dbPath: string): TrackerConfig {
  return {
    httpHost: "127.0.0.1",
    httpPort: 0,
    dbPath,
    symbols: ["BTCUSDT", "ETHUSDT"],
    klineIntervals: ["1", "5", "15", "60", "240", "D"],
    retention: {
      tickerSnapshotsHours: 24,
      orderbookSnapshotsHours: 6,
      klinesDays: 14,
      pruneIntervalMs: 300_000,
    },
    rest: { category: "linear", timeoutMs: 1, retries: 0 },
    recovery: { ...DEFAULT_RECOVERY },
  } as unknown as TrackerConfig;
}

describe("GET /observe machine snapshot", () => {
  test("includes feed gates, tape honesty, and last MAP symbols; paper inject nests under paper", async () => {
    delete process.env.LIVE_SHADOW_URL;
    const dir = mkdtempSync(join(tmpdir(), "minh-observe-"));
    dirs.push(dir);
    const dbPath = join(dir, "market.sqlite");
    const store = openDb(dbPath);
    const config = feedConfig(dbPath);
    await writeMapSnapshot(mapClosePath(config), {
      maps: [
        {
          symbol: "BTCUSDT",
          oi: { deltaPct: "1.2", reading: "long_add" },
          funding: { crowded: "long" },
          flow: { delta: null, reading: null },
          liq: { count: 0, cascade: { active: false } },
        },
        { symbol: "ETHUSDT" },
      ],
    });
    const server = startHttp(config, store, {
      observe: () => ({ standing: { accepted: 2, pending: 0, open: 0, alerts: 0 } }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/observe`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        mode: string;
        feed: { ok: boolean; klineLagOk: boolean };
        gates: { tradingAllowed: boolean; reasons: string[] };
        map: { quality: string; symbols: string[] };
        tape: { flow: { ok: number; missing: number }; oi: { ok: number; missing: number } };
        shadow: { quality: string };
        paper: { standing: { accepted: number } };
      };
      expect(body.mode).toBe("observe");
      expect(body.map.quality).toBe("ok");
      expect(body.map.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
      expect(body.tape.oi.ok).toBe(1);
      expect(body.tape.oi.missing).toBe(1);
      expect(body.tape.flow.missing).toBe(2);
      expect(body.tape.flow.ok).toBe(0);
      expect(body.shadow.quality).toBe("missing");
      expect(body.paper.standing.accepted).toBe(2);
      expect(body.gates.reasons).toContain("feed_unhealthy");
    } finally {
      server.stop();
      store.close();
    }
  });

  test("tape treats empty CVD/liq windows as missing, not 0", () => {
    const tape = observeTapeFromMap({
      maps: [
        { symbol: "BTCUSDT", flow: { delta: "12.5", reading: "buy_dom" }, liq: { count: 4, cascade: { active: true } } },
        { symbol: "ETHUSDT", flow: { delta: null }, liq: { count: 0, cascade: { active: false } } },
      ],
    });
    expect(tape.quality).toBe("ok");
    expect(tape.flow).toEqual({ ok: 1, missing: 1 });
    expect(tape.liq).toEqual({ ok: 1, missing: 1 });
  });

  test("shadow URL unset is missing; LIVE_SHADOW=0 skips; HTTP fail is down; 200 is ok", async () => {
    delete process.env.LIVE_SHADOW_URL;
    delete process.env.LIVE_SHADOW;
    expect(liveShadowObserveUrl()).toBeNull();
    expect(await readObserveShadow()).toEqual({ quality: "missing", accepted: 0, wouldArm: 0 });

    process.env.LIVE_SHADOW_URL = "http://127.0.0.1:9/live/shadow";
    process.env.LIVE_SHADOW = "0";
    expect(liveShadowObserveUrl()).toBeNull();

    process.env.LIVE_SHADOW = "1";
    const down = await readObserveShadow(async () => {
      throw new Error("connect");
    });
    expect(down.quality).toBe("down");

    const ok = await readObserveShadow(async () => new Response(JSON.stringify({
      accepted: [{ zoneId: "a" }, { zoneId: "b" }],
      wouldArm: ["a"],
    }), { status: 200 }));
    expect(ok).toEqual({ quality: "ok", accepted: 2, wouldArm: 1 });
  });

  test("source does not import paper or arm", async () => {
    const src = await Bun.file("src/feed/bb/observe.ts").text();
    expect(src).not.toContain("src/paper");
    expect(src).not.toContain("paperArm");
    expect(src).not.toContain("/v5/order");
    expect(src).not.toContain("src/live");
  });
});
