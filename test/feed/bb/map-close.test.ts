import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  buildWatchlistMap,
  mapClosePath,
  tickMapClose,
  writeMapSnapshot,
} from "../../../src/feed/bb/map-close";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tickMapClose", () => {
  test("fires once per confirmed 4H bar, coalesces many symbols, ignores 15m", () => {
    const first = tickMapClose(new Set(), [
      { symbol: "BTCUSDT", interval: "240", startTs: 1, confirm: true },
      { symbol: "ETHUSDT", interval: "240", startTs: 1, confirm: true },
      { symbol: "BTCUSDT", interval: "15", startTs: 1, confirm: true },
      { symbol: "BTCUSDT", interval: "60", startTs: 2, confirm: false },
    ]);
    expect(first.interval).toBe("240");
    expect(first.bars).toHaveLength(2);

    const again = tickMapClose(first.next, [
      { symbol: "BTCUSDT", interval: "240", startTs: 1, confirm: true },
      { symbol: "ETHUSDT", interval: "240", startTs: 1, confirm: true },
    ]);
    expect(again.interval).toBeNull();

    const hour = tickMapClose(again.next, [
      { symbol: "BTCUSDT", interval: "240", startTs: 1, confirm: true },
      { symbol: "BTCUSDT", interval: "60", startTs: 3, confirm: true },
    ]);
    expect(hour.interval).toBe("60");
  });

  test("source does not arm paper or hit private Bybit routes", async () => {
    const src = await Bun.file("src/feed/bb/map-close.ts").text();
    expect(src).not.toContain("paper arm");
    expect(src).not.toContain("/v5/order");
    expect(src).not.toContain("BYBIT_API_KEY");
  });
});

describe("map snapshot file + GET /map-latest", () => {
  test("writes watchlist JSON; 404 until the first close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-map-close-"));
    dirs.push(dir);
    const dbPath = join(dir, "market.sqlite");
    const store = openDb(dbPath);
    const config = {
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
      symbols: ["BTCUSDT", "ETHUSDT"],
    } as TrackerConfig;

    const server = startHttp(config, store);
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/map-latest`);
      expect(missing.status).toBe(404);

      const body = buildWatchlistMap(store, config, 9);
      const path = mapClosePath(config);
      await writeMapSnapshot(path, body);
      const res = await fetch(`http://127.0.0.1:${server.port}/map-latest`);
      expect(res.status).toBe(200);
      const json = await res.json() as { maps: { symbol: string }[]; klineLag: { ok: boolean } };
      expect(json.maps.map((row) => row.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
      expect(json.klineLag.ok).toBe(true);
    } finally {
      server.stop();
      store.close();
    }
  });
});
