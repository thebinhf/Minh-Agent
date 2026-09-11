import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperSafetyError } from "../../src/paper/errors";
import { loadLiveConfig, startLive } from "../../src/live/index";
import { openLiveDb } from "../../src/live/db";
import { map240Fingerprint, planArm, planMapClose } from "../../src/live/plan";
import { mapPayload } from "../agent/htf";
import type { ZoneCard } from "../../src/zones/card";
import { openPaperDb } from "../../src/paper/db";
import { loadPaperConfig } from "../../src/paper/config";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET",
  "LIVE_SHADOW",
  "LIVE_DB_PATH",
  "LIVE_HTTP_PORT",
  "MAP_ACCEPT",
  "PAPER_PROXIMITY_ARM",
  "PAPER_CONFIRM_15",
  "PAPER_ARM_MAX",
  "AGENT_QUANT",
  "AGENT_BIAS_CHOP",
] as const;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const name of ENV_KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
    delete saved[name];
  }
});

function stash(name: (typeof ENV_KEYS)[number]) {
  if (name in saved) return;
  saved[name] = process.env[name];
}

function tempRoot(prefix = "minh-live-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const SUPPLY: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
  baseStartTs: 1_788_801_600_000,
  baseEndTs: 1_788_808_800_000,
  zoneLow: 79_250,
  zoneHigh: 79_472,
  distal: 79_472,
  proximal: 79_250,
  impulseBody: 980,
  atr14: 720,
  impulseAtr: 1.36,
  departureAtr: 0.42,
  freshness: "virgin",
  penetrationPct: 0,
  entry: 79_300,
  sl: 79_880,
  tp: 77_580,
  rr: 2.97,
  hardInvalid: 79_880,
  softInvalid: 79_472,
  expiryBars: 48,
  cancelCodes: [],
};

const DEMAND: ZoneCard = {
  ...SUPPLY,
  zoneId: "btc-4h-d-20260908-01",
  side: "demand",
  distal: 79_250,
  proximal: 79_472,
  entry: 79_400,
  sl: 79_100,
  tp: 80_200,
  rr: 2.1,
  hardInvalid: 79_100,
  softInvalid: 79_250,
};

const ARM_DEMAND_LAST = 79_450;

function liveConfig(dir: string) {
  return {
    httpHost: "127.0.0.1",
    httpPort: 0,
    dbPath: join(dir, "live-shadow.sqlite"),
    feedUrl: "http://127.0.0.1:43180",
    tickMs: 0,
    minRr: null as string | null,
  };
}

describe("live-shadow safety", () => {
  test("refuses to start when Bybit key env vars are set", async () => {
    stash("BYBIT_API_KEY");
    process.env.BYBIT_API_KEY = "not-a-real-key";
    await expect(loadLiveConfig()).rejects.toThrow(PaperSafetyError);
    await expect(startLive()).rejects.toThrow(/never uses API keys/);
  });

  test("LIVE_DB_PATH must be distinct from paper and feed sqlite", async () => {
    const dir = tempRoot();
    const paper = await loadPaperConfig();
    stash("LIVE_DB_PATH");
    process.env.LIVE_DB_PATH = paper.dbPath;
    await expect(loadLiveConfig()).rejects.toThrow(/LIVE_DB_PATH must not equal PAPER_DB_PATH/);
    process.env.LIVE_DB_PATH = join(dir, "live-shadow.sqlite");
    const cfg = await loadLiveConfig();
    expect(cfg.dbPath).toBe(join(dir, "live-shadow.sqlite"));
    expect(cfg.httpPort).toBe(43182);
  });

  test("LIVE_SHADOW=0 refuses to start", async () => {
    stash("LIVE_SHADOW");
    process.env.LIVE_SHADOW = "0";
    const dir = tempRoot();
    await expect(startLive({ config: liveConfig(dir), tick: false, pollMap: false })).rejects.toThrow(
      /LIVE_SHADOW=0/,
    );
  });

  test("src/live never mentions private order routes or live promote", async () => {
    const files = readdirSync(join(import.meta.dir, "../../src/live"));
    expect(files.some((name) => name.endsWith(".ts"))).toBe(true);
    for (const name of files) {
      const src = await Bun.file(join("src/live", name)).text();
      expect(src).not.toContain("api.bybit.com");
      expect(src).not.toContain("/v5/order");
      expect(src).not.toContain("PAPER_LIVE");
      expect(src).not.toContain("promote");
      expect(src).not.toContain("acceptZone(");
      expect(src).not.toContain("paperArm(");
      expect(src).not.toMatch(/private.*websocket/i);
    }
  });
});

describe("live-shadow plan", () => {
  test("4H policy accepts without writing the paper ledger; 1H is a no-op", async () => {
    const dir = tempRoot();
    const live = openLiveDb(join(dir, "live.sqlite"));
    const paper = openPaperDb(join(dir, "paper.sqlite"), {
      name: "minh-paper",
      quote: "USDT",
      startingCash: "10000",
      riskPctMin: "0.01",
      riskPctMax: "0.10",
      defaultRiskPct: "0.02",
      minRr: null,
      feeRate: "0",
      makerFeeRate: "0",
      leverageMin: "1",
      leverageMax: "25",
      defaultLeverage: "1",
      mmRate: "0.005",
      marginMode: "isolated",
    });
    try {
      const map = mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) });
      const hour = await planMapClose(live, { interval: "60", map }, {
        fetchCards: async () => [DEMAND],
        health: { ok: true, klineLagOk: true },
      });
      expect(hour).toBeNull();

      const planned = await planMapClose(live, { interval: "240", map }, {
        fetchCards: async () => [DEMAND],
        health: { ok: true, klineLagOk: true },
        minRr: null,
      });
      expect(planned?.accepted).toEqual([DEMAND.zoneId]);
      expect(live.accepted().map((row) => row.zoneId)).toEqual([DEMAND.zoneId]);
      expect(paper.listZoneLedger("accepted")).toEqual([]);
    } finally {
      live.close();
      paper.close();
    }
  });

  test("cold family (null) is not a veto; ARM records would-arm once and never paperArm", async () => {
    const dir = tempRoot();
    const live = openLiveDb(join(dir, "live.sqlite"));
    try {
      const map = mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) });
      await planMapClose(live, { interval: "240", map }, {
        fetchCards: async () => [DEMAND],
        health: { ok: true, klineLagOk: true },
        minRr: null,
      });
      const last = new Map([["BTCUSDT", ARM_DEMAND_LAST]]);
      const bar = {
        interval: "15",
        open: "79410",
        close: "79440",
        startTs: 1,
        confirm: true,
      };
      const first = planArm(live, last, { kline15BySymbol: new Map([["BTCUSDT", bar]]) });
      expect(first.wouldArm).toEqual([DEMAND.zoneId]);
      const again = planArm(live, last, { kline15BySymbol: new Map([["BTCUSDT", bar]]) });
      expect(again.wouldArm).toEqual([]);
      expect(live.accepted()[0]?.armedTs).toBeGreaterThan(0);
      const armEvents = live.events().filter((row) => row.kind === "arm_plan" && row.allow);
      expect(armEvents).toHaveLength(1);
    } finally {
      live.close();
    }
  });

  test("ARM cap ranks by rr then zoneId; occupied slots stay", async () => {
    stash("PAPER_ARM_MAX");
    process.env.PAPER_ARM_MAX = "1";
    const dir = tempRoot();
    const live = openLiveDb(join(dir, "live.sqlite"));
    try {
      const eth: ZoneCard = {
        ...DEMAND,
        zoneId: "eth-4h-d-20260908-01",
        symbol: "ETHUSDT",
        rr: 4.2,
      };
      const now = Date.now();
      live.acceptCard(DEMAND, now);
      live.acceptCard(eth, now);
      const last = new Map([
        ["BTCUSDT", ARM_DEMAND_LAST],
        ["ETHUSDT", ARM_DEMAND_LAST],
      ]);
      const bar = {
        interval: "15",
        open: "79410",
        close: "79440",
        startTs: 1,
        confirm: true,
      };
      const kline15 = new Map([
        ["BTCUSDT", bar],
        ["ETHUSDT", bar],
      ]);
      const first = planArm(live, last, { kline15BySymbol: kline15, now });
      expect(first.wouldArm).toEqual([eth.zoneId]);
      const second = planArm(live, last, { kline15BySymbol: kline15, now: now + 1 });
      expect(second.wouldArm).toEqual([]);
    } finally {
      live.close();
    }
  });

  test("map240Fingerprint changes only when a 4H start_ts moves", () => {
    const a = mapPayload({ direction: "bull", lastPrice: "79450" });
    const b = structuredClone(a) as typeof a;
    expect(map240Fingerprint(a)).toBe(map240Fingerprint(b));
    const bars = b.maps[0]!.klines["240"];
    bars[bars.length - 1] = { ...bars[bars.length - 1]!, start_ts: 99 };
    expect(map240Fingerprint(b)).not.toBe(map240Fingerprint(a));
  });
});

describe("live-shadow HTTP", () => {
  test("health / shadow / map-close; no order routes", async () => {
    const dir = tempRoot();
    const map = mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) });
    const svc = await startLive({
      config: liveConfig(dir),
      tick: false,
      pollMap: false,
      fetchCards: async () => [DEMAND],
      feed: {
        health: async () => ({ ok: true, url: "http://127.0.0.1:43180/health", klineLagOk: true }),
        tickers: async () => [{ symbol: "BTCUSDT", lastPrice: String(ARM_DEMAND_LAST) }],
        lastKline: async () => ({
          interval: "15",
          open: "79410",
          close: "79440",
          startTs: 1,
          confirm: true,
        }),
        mapLatest: async () => map,
      },
    });
    try {
      const health = await (await fetch(`${svc.url}/live/health`)).json() as Record<string, unknown>;
      expect(health.mode).toBe("live-shadow");
      expect(health.ok).toBe(true);
      expect(health.orders).toBe(false);

      const posted = await fetch(`${svc.url}/live/map-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "map.close", interval: "240", map }),
      });
      expect(posted.status).toBe(200);
      const body = await posted.json() as { plan: { accepted: string[] } };
      expect(body.plan.accepted).toEqual([DEMAND.zoneId]);

      const hour = await fetch(`${svc.url}/live/map-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interval: "60", map }),
      });
      const hourBody = await hour.json() as { plan: null };
      expect(hourBody.plan).toBeNull();

      await svc.tick();
      const shadow = await (await fetch(`${svc.url}/live/shadow`)).json() as {
        wouldArm: string[];
        accepted: Array<{ zoneId: string; armedTs: number | null }>;
      };
      expect(shadow.wouldArm).toEqual([DEMAND.zoneId]);
      expect(shadow.accepted[0]?.armedTs).not.toBeNull();

      const missing = await fetch(`${svc.url}/v5/order`);
      expect(missing.status).toBe(404);
      const paper = await fetch(`${svc.url}/paper/positions`, { method: "POST" });
      expect(paper.status).toBe(404);
    } finally {
      svc.stop();
    }
  });
});
