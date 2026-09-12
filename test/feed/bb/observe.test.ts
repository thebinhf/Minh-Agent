import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RECOVERY } from "../../../src/feed/bb/config";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import { mapClosePath, writeMapSnapshot } from "../../../src/feed/bb/map-close";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
  test("includes feed gates and last MAP symbols; paper inject nests under paper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-observe-"));
    dirs.push(dir);
    const dbPath = join(dir, "market.sqlite");
    const store = openDb(dbPath);
    const config = feedConfig(dbPath);
    await writeMapSnapshot(mapClosePath(config), {
      maps: [{ symbol: "BTCUSDT" }, { symbol: "ETHUSDT" }],
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
        paper: { standing: { accepted: number } };
      };
      expect(body.mode).toBe("observe");
      expect(body.map.quality).toBe("ok");
      expect(body.map.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
      expect(body.paper.standing.accepted).toBe(2);
      expect(body.gates.reasons).toContain("feed_unhealthy");
    } finally {
      server.stop();
      store.close();
    }
  });

  test("source does not import paper or arm", async () => {
    const src = await Bun.file("src/feed/bb/observe.ts").text();
    expect(src).not.toContain("src/paper");
    expect(src).not.toContain("paperArm");
    expect(src).not.toContain("/v5/order");
  });
});
