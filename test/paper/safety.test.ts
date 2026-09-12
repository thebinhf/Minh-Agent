import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { assertNoApiKeys, assertSeparateDb, forbiddenKeyEnvNames } from "../../src/paper/config";
import { PaperSafetyError } from "../../src/paper/errors";
import { startPaper } from "../../src/paper/index";

const KEYS = ["BYBIT_API_KEY", "BYBIT_API_SECRET", "BYBIT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const name of KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
    delete saved[name];
  }
});

describe("paper safety", () => {
  test("refuses to start when Bybit key env vars are set", async () => {
    saved.BYBIT_API_KEY = process.env.BYBIT_API_KEY;
    process.env.BYBIT_API_KEY = "not-a-real-key";
    expect(forbiddenKeyEnvNames()).toContain("BYBIT_API_KEY");
    expect(() => assertNoApiKeys()).toThrow(PaperSafetyError);
    expect(() => assertNoApiKeys()).toThrow(/paper never uses API keys/);
    await expect(startPaper()).rejects.toThrow(PaperSafetyError);
  });

  test("paper DB path must not equal the feed DB path", () => {
    expect(() => assertSeparateDb("/tmp/same.sqlite", "/tmp/same.sqlite")).toThrow(PaperSafetyError);
    expect(() => assertSeparateDb("/tmp/paper.sqlite", "/tmp/market.sqlite")).not.toThrow();
  });

  test("paper sources never mention private order routes or live promote", async () => {
    const files = [
      "src/paper/engine.ts",
      "src/paper/feed.ts",
      "src/paper/http.ts",
      "src/paper/cli.ts",
      "src/paper/index.ts",
      "src/paper/risk.ts",
      "src/paper/phase2.ts",
      "src/paper/venue.ts",
      "src/paper/watch.ts",
      "src/paper/notify.ts",
      "src/paper/replay.ts",
      "src/paper/replay-map.ts",
      "src/features/tape.ts",
      "src/features/snapshot.ts",
      "src/features/shock.ts",
      "src/features/scan.ts",
      "src/features/cli.ts",
      "src/paper/ops.ts",
      "src/paper/proximity.ts",
      "src/paper/zone-accept.ts",
      "src/paper/map-accept.ts",
      "src/agent/bias.ts",
      "src/agent/policy.ts",
      "src/agent/quant.ts",
      "src/agent/ta-gate.ts",
      "src/paper/event.ts",
      "src/paper/db.ts",
      "src/live/config.ts",
      "src/live/db.ts",
      "src/live/plan.ts",
      "src/live/http.ts",
      "src/live/index.ts",
      "src/live/cli.ts",
      "src/ta/snapshot.ts",
      "src/ta/pack.ts",
      "src/ta/cli.ts",
      "src/ta/bars.ts",
      "src/ta/catalog.ts",
      "src/ta/structure.ts",
      "src/ta/candle.ts",
      "src/ta/oscillator.ts",
      "src/ta/discretionary.ts",
      "src/ta/index.ts",
      "src/ta/arm-tape.ts",
      "src/zones/card.ts",
      "src/zones/detect.ts",
      "src/zones/setups.ts",
      "src/feed/bb/zones.ts",
    ];
    for (const file of files) {
      const src = await Bun.file(file).text();
      expect(src).not.toContain("api.bybit.com");
      expect(src).not.toContain("/v5/order");
      expect(src).not.toContain("PAPER_LIVE");
      expect(src).not.toContain("promote");
      expect(src).not.toMatch(/private.*websocket/i);
    }
  });

  test("feed tests stay free of paper fixtures", () => {
    const feedTests = readdirSync(join(import.meta.dir, "../feed/bb"));
    expect(feedTests.some((name) => name.includes("paper"))).toBe(false);
    const paperTests = readdirSync(import.meta.dir);
    expect(paperTests.some((name) => name.endsWith(".test.ts"))).toBe(true);
  });
});
