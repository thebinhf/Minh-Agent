import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEED_KNOBS } from "../../../src/config/registry";
import {
  buildConfigSnapshot,
  loadFeedBoot,
  type FeedConfigBoot,
} from "../../../src/feed/bb/config";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // EBUSY on Windows teardown — leave the temp dir for the OS to clean.
    }
  }
});

const savedEnv: Record<string, string | undefined> = {};

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  for (const [key, value] of Object.entries(env)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** bun test auto-loads the repo .env into process.env — strip it for a clean slate. */
function clearFeedEnv(): Record<string, undefined> {
  return Object.fromEntries(
    Object.keys(process.env).filter((key) => key.startsWith("BYBIT_")).map((key) => [key, undefined]),
  );
}

function makeFixtureDir(config: Record<string, unknown>, dotenv = ""): { configPath: string; dotenvPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "minh-config-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");
  const dotenvPath = join(dir, ".env");
  writeFileSync(configPath, JSON.stringify(config));
  if (dotenv) writeFileSync(dotenvPath, dotenv);
  return { configPath, dotenvPath };
}

function fixtureConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: "wss://stream.bybit.com/v5/public/linear",
    restEndpoint: "https://api.bybit.com",
    restFallbacks: ["https://api.manepa.jp"],
    httpHost: "127.0.0.1",
    httpPort: 43991,
    dbPath: "./data/market.sqlite",
    symbols: ["BTCUSDT", "ETHUSDT"],
    klineIntervals: ["15", "60", "240"],
    orderbook: { depth: 50, symbols: ["BTCUSDT", "ETHUSDT"] },
    pingIntervalMs: 20000,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
    retention: { tickerSnapshotsHours: 24, klinesDays: 180, pruneIntervalMs: 300000 },
    snapshot: { tickerEveryMs: 0, orderbookEveryMs: 5000 },
    recovery: { pongStaleMs: 60000, klineLagMs: 180000, gapFill: true },
    ...overrides,
  };
}

async function bootFrom(config: Record<string, unknown>, dotenv = ""): Promise<FeedConfigBoot> {
  const { configPath, dotenvPath } = makeFixtureDir(config, dotenv);
  return loadFeedBoot(configPath, dotenvPath);
}

describe("feed config through the registry", () => {
  test("loads the file layer; registry defaults fill retention gaps; sources are recorded", async () => {
    await withEnv(clearFeedEnv(), async () => {
      const boot = await bootFrom(fixtureConfig());
      expect(boot.config.httpPort).toBe(43991);
      expect(boot.config.retention.liquidationsHours).toBe(48);
      expect(boot.config.retention.flowHours).toBe(24);
      expect(boot.config.dbPath).toBe(join(process.cwd(), "data", "market.sqlite"));
      expect(boot.sources["httpPort"]).toBe("file");
      expect(boot.sources["retention.liquidationsHours"]).toBe("default");
      expect(boot.sources["retention.flowHours"]).toBe("default");
    });
  });

  test("env overrides win over the file and are recorded as env", async () => {
    await withEnv({ BYBIT_HTTP_PORT: "43992", BYBIT_LIQ_HOURS: "4320" }, async () => {
      const boot = await bootFrom(fixtureConfig());
      expect(boot.config.httpPort).toBe(43992);
      expect(boot.config.retention.liquidationsHours).toBe(4320);
      expect(boot.sources["httpPort"]).toBe("env");
      expect(boot.sources["retention.liquidationsHours"]).toBe("env");
    });
  });

  test("an empty override is unset, except emptyMeansEmpty csv knobs", async () => {
    await withEnv({ BYBIT_LIQ_HOURS: "", BYBIT_REST_FALLBACKS: "" }, async () => {
      const boot = await bootFrom(fixtureConfig());
      expect(boot.config.retention.liquidationsHours).toBe(48);
      expect(boot.config.restFallbacks).toEqual([]);
    });
  });

  test("orderbook.symbols derives from symbols and filters to the watchlist", async () => {
    const noObSymbols = fixtureConfig();
    delete (noObSymbols.orderbook as Record<string, unknown>).symbols;
    const derived = await bootFrom(noObSymbols);
    expect(derived.config.orderbook.symbols).toEqual(derived.config.symbols);
    expect(derived.sources["orderbook.symbols"]).toBe("derived");

    await withEnv({ BYBIT_ORDERBOOK_SYMBOLS: "BTCUSDT,NOPEUSDT" }, async () => {
      const filtered = await bootFrom(fixtureConfig());
      expect(filtered.config.orderbook.symbols).toEqual(["BTCUSDT"]);
      expect(filtered.sources["orderbook.symbols"]).toBe("env");
    });
  });

  test("invalid values fail loudly, listing every offender", async () => {
    await withEnv({ BYBIT_HTTP_PORT: "abc", BYBIT_GAP_FILL: "maybe" }, async () => {
      const { configPath, dotenvPath } = makeFixtureDir(fixtureConfig());
      expect(loadFeedBoot(configPath, dotenvPath)).rejects.toThrow(/BYBIT_HTTP_PORT[\s\S]*BYBIT_GAP_FILL/);
    });
  });

  test("out-of-range values fail with the bound in the message", async () => {
    await withEnv({ BYBIT_HTTP_PORT: "70000" }, async () => {
      const { configPath, dotenvPath } = makeFixtureDir(fixtureConfig());
      expect(loadFeedBoot(configPath, dotenvPath)).rejects.toThrow(/<= 65535/);
    });
  });

  test("a missing required knob fails instead of leaking undefined", async () => {
    const config = fixtureConfig();
    delete config.symbols;
    const { configPath, dotenvPath } = makeFixtureDir(config);
    expect(loadFeedBoot(configPath, dotenvPath)).rejects.toThrow(/symbols/);
  });

  test("gapFill env 1 overrides a false file value (strict bool)", async () => {
    await withEnv({ BYBIT_GAP_FILL: "1" }, async () => {
      const boot = await bootFrom(fixtureConfig({ recovery: { pongStaleMs: 60000, klineLagMs: 180000, gapFill: false } }));
      expect(boot.config.recovery.gapFill).toBe(true);
    });
  });
});

describe("GET /config snapshot", () => {
  test("with unchanged disk state, no knob is pending", async () => {
    await withEnv(clearFeedEnv(), async () => {
      const boot = await bootFrom(fixtureConfig());
      const snapshot = await buildConfigSnapshot(boot);
      expect(snapshot.ok).toBe(true);
      expect(snapshot.pending).toEqual({ hot: [], restart: [], "next-run": [] });
      for (const knob of snapshot.knobs) {
        expect(knob.pending).toBeNull();
        expect(knob.value).toEqual(boot.values[knob.key]);
      }
      expect(snapshot.knobs).toHaveLength(FEED_KNOBS.length);
    });
  });

  test("an edited .env shows up as a pending restart change", async () => {
    await withEnv(clearFeedEnv(), async () => {
      const { configPath, dotenvPath } = makeFixtureDir(fixtureConfig());
      const boot = await loadFeedBoot(configPath, dotenvPath);
      writeFileSync(dotenvPath, "BYBIT_LIQ_HOURS=100\n");
      const snapshot = await buildConfigSnapshot(boot);
      const knob = snapshot.knobs.find((row) => row.key === "retention.liquidationsHours")!;
      expect(knob.pending).toEqual({ value: 100, source: "dotenv" });
      expect(knob.value).toBe(48);
      expect(snapshot.pending.restart).toContain("retention.liquidationsHours");
      expect(snapshot.pending.hot).toEqual([]);
      const untouched = snapshot.knobs.find((row) => row.key === "httpPort")!;
      expect(untouched.pending).toBeNull();
    });
  });

  test("a real env var still wins over an edited .env", async () => {
    await withEnv({ BYBIT_LIQ_HOURS: "90" }, async () => {
      const { configPath, dotenvPath } = makeFixtureDir(fixtureConfig(), "BYBIT_LIQ_HOURS=72\n");
      const boot = await loadFeedBoot(configPath, dotenvPath);
      expect(boot.config.retention.liquidationsHours).toBe(90);
      writeFileSync(dotenvPath, "BYBIT_LIQ_HOURS=100\n");
      const snapshot = await buildConfigSnapshot(boot);
      const knob = snapshot.knobs.find((row) => row.key === "retention.liquidationsHours")!;
      expect(knob.pending).toBeNull();
      expect(knob.value).toBe(90);
    });
  });

  test("an invalid pending edit is flagged as an error, not a value", async () => {
    await withEnv(clearFeedEnv(), async () => {
      const { configPath, dotenvPath } = makeFixtureDir(fixtureConfig());
      const boot = await loadFeedBoot(configPath, dotenvPath);
      writeFileSync(dotenvPath, "BYBIT_HTTP_PORT=abc\n");
      const snapshot = await buildConfigSnapshot(boot);
      const knob = snapshot.knobs.find((row) => row.key === "httpPort")!;
      expect(knob.pending).toMatchObject({ error: expect.stringContaining("dotenv") });
    });
  });

  test("a pending change on a hot-effect knob groups under hot", async () => {
    await withEnv(clearFeedEnv(), async () => {
      const { configPath, dotenvPath } = makeFixtureDir(fixtureConfig());
      const boot = await loadFeedBoot(configPath, dotenvPath);
      const hotDefs = FEED_KNOBS.map((knob) =>
        knob.key === "retention.liquidationsHours" ? { ...knob, effect: "hot" as const } : knob,
      );
      writeFileSync(dotenvPath, "BYBIT_LIQ_HOURS=100\n");
      const snapshot = await buildConfigSnapshot(boot, hotDefs);
      expect(snapshot.pending.hot).toContain("retention.liquidationsHours");
      expect(snapshot.pending.restart).not.toContain("retention.liquidationsHours");
    });
  });
});
