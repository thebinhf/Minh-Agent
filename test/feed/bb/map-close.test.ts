import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type TrackerDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  buildWatchlistMap,
  mapClosePath,
  rollbackTick,
  startMapCloser,
  tickMapClose,
  writeMapSnapshot,
} from "../../../src/feed/bb/map-close";
import type { TrackerConfig } from "../../../src/feed/bb/types";

/** The Windows sharing violation that used to burn a close. */
function lockHeld(): NodeJS.ErrnoException {
  return Object.assign(new Error("operation not permitted, rename"), { code: "EPERM" });
}

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

describe("writeMapSnapshot rename retry", () => {
  test("a momentary Windows lock is retried and the file lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-map-rename-"));
    dirs.push(dir);
    const path = join(dir, "map-latest.json");
    let attempts = 0;
    await writeMapSnapshot(path, { ts: 7 }, async (from, to) => {
      attempts += 1;
      if (attempts < 3) throw lockHeld();
      await rename(from, to);
    });
    expect(attempts).toBe(3);
    expect(await Bun.file(path).json()).toEqual({ ts: 7 });
  });

  test("an error a retry cannot fix fails at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-map-rename2-"));
    dirs.push(dir);
    const path = join(dir, "map-latest.json");
    let attempts = 0;
    await expect(writeMapSnapshot(path, { ts: 7 }, async () => {
      attempts += 1;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    })).rejects.toThrow(/no space/);
    expect(attempts).toBe(1);
    expect(await Bun.file(`${path}.tmp`).exists()).toBe(true);
  });

  test("the plain write leaves no tmp behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minh-map-rename3-"));
    dirs.push(dir);
    const path = join(dir, "map-latest.json");
    await writeMapSnapshot(path, { ts: 1 });
    expect(await Bun.file(path).json()).toEqual({ ts: 1 });
    expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
  });
});

describe("rollbackTick", () => {
  test("releases only the bars of the dump that failed", () => {
    const bars = [
      { symbol: "BTCUSDT", interval: "240", startTs: 1, confirm: true },
      { symbol: "ETHUSDT", interval: "240", startTs: 1, confirm: true },
    ];
    const held = tickMapClose(new Set(["BTCUSDT|60|9"]), bars);
    expect(rollbackTick(held.next, held).has("BTCUSDT|60|9")).toBe(false);
    expect(tickMapClose(held.next, bars).interval).toBeNull();
    const back = rollbackTick(held.next, held);
    expect(tickMapClose(back, bars).interval).toBe("240");
    expect(tickMapClose(back, bars).next).toEqual(held.next);
  });
});

describe("startMapCloser tick loop", () => {
  function harness(bars: { symbol: string; interval: string; startTs: number; confirm: boolean }[]) {
    const dir = mkdtempSync(join(tmpdir(), "minh-map-loop-"));
    dirs.push(dir);
    const dbPath = join(dir, "market.sqlite");
    const store = openDb(dbPath);
    const config = {
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
      symbols: ["BTCUSDT"],
      recovery: { watchdogIntervalMs: 60_000 },
    } as unknown as TrackerConfig;
    return {
      closer: (hooks: Parameters<typeof startMapCloser>[2]) => startMapCloser(
        config,
        { ...store, latestConfirmedKlines: () => bars } as unknown as TrackerDb,
        hooks,
      ),
      done: () => store.close(),
    };
  }

  test("boot publishes the file without re-running the accept path", async () => {
    const h = harness([{ symbol: "BTCUSDT", interval: "240", startTs: 1, confirm: true }]);
    let written = 0;
    let closed = 0;
    const closer = h.closer({
      write: async () => { written += 1; },
      onClose: async () => { closed += 1; },
    });
    try {
      await closer.tick();
      expect(written).toBe(1);
      expect(closed).toBe(0);
      await closer.tick();
      expect(written).toBe(1);
      expect(closed).toBe(0);
    } finally {
      closer.stop();
      h.done();
    }
  });

  test("a lock-held dump does not consume the bar; the next tick writes it", async () => {
    const h = harness([{ symbol: "BTCUSDT", interval: "240", startTs: 1, confirm: true }]);
    let attempts = 0;
    let notified = 0;
    const closer = h.closer({
      write: async () => {
        attempts += 1;
        if (attempts === 1) throw lockHeld();
      },
      onClose: async () => { notified += 1; },
    });
    try {
      await closer.tick();
      expect(attempts).toBe(1);
      expect(notified).toBe(0);
      await closer.tick();
      expect(attempts).toBe(2);
      expect(notified).toBe(1);
      await closer.tick();
      expect(attempts).toBe(2);
    } finally {
      closer.stop();
      h.done();
    }
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
