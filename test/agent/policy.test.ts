import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  agentMapEnabled,
  decideMapAccept,
  onMapCloseAccept,
} from "../../src/agent/policy";
import { readMapBias } from "../../src/agent/bias";
import { mockFeed, paperEngine } from "../paper/helpers";
import type { ZoneCard } from "../../src/zones/card";

const dirs: string[] = [];
const savedAccept = process.env.MAP_ACCEPT;
const savedAgent = process.env.AGENT_MAP;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedAccept === undefined) delete process.env.MAP_ACCEPT;
  else process.env.MAP_ACCEPT = savedAccept;
  if (savedAgent === undefined) delete process.env.AGENT_MAP;
  else process.env.AGENT_MAP = savedAgent;
});

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
  hardInvalid: 79_100,
  softInvalid: 79_250,
};

function kline(startTs: number, open: number, high: number, low: number, close: number) {
  return {
    start_ts: startTs,
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "1",
    turnover: "1",
    confirm: true,
  };
}

function risingKlines(count = 8) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const close = 110 + i;
    out.push(kline(1_000 + i, close - 1, 120, 100, close));
  }
  return out;
}

function fallingKlines(count = 8) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const close = 110 - i;
    out.push(kline(1_000 + i, close + 1, 120, 100, close));
  }
  return out;
}

function mapPayload(opts: {
  direction: "bull" | "bear";
  lastPrice: string;
  lagOk?: boolean;
}) {
  const series = opts.direction === "bull" ? risingKlines() : fallingKlines();
  return {
    maps: [{
      symbol: "BTCUSDT",
      ticker: { lastPrice: opts.lastPrice },
      klines: { "240": series, "60": series, D: [] },
      klineLag: {
        ok: opts.lagOk !== false,
        rows: opts.lagOk === false
          ? [{ symbol: "BTCUSDT", interval: "240", stale: true }]
          : [],
      },
    }],
  };
}

describe("MAP policy", () => {
  test("AGENT_MAP follows MAP_ACCEPT kill pattern (default on, 0 off)", () => {
    delete process.env.AGENT_MAP;
    expect(agentMapEnabled()).toBe(true);
    process.env.AGENT_MAP = "0";
    expect(agentMapEnabled()).toBe(false);
  });

  test("allows demand on bull HTF and supply on bear; rejects fade / aside / lag", () => {
    delete process.env.AGENT_MAP;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: "79600" })).get("BTCUSDT");
    const bear = readMapBias(mapPayload({ direction: "bear", lastPrice: "79000" })).get("BTCUSDT");
    expect(decideMapAccept({ card: DEMAND, bias: bull, last: 79_600 })).toEqual({ allow: true, reason: "ok" });
    expect(decideMapAccept({ card: SUPPLY, bias: bear, last: 79_000 })).toEqual({ allow: true, reason: "ok" });
    expect(decideMapAccept({ card: SUPPLY, bias: bull, last: 79_600 }).reason).toBe("bias_mismatch");
    expect(decideMapAccept({ card: DEMAND, bias: undefined, last: 79_600 }).reason).toBe("bias_aside");
    const lagged = readMapBias(mapPayload({ direction: "bull", lastPrice: "79600", lagOk: false })).get("BTCUSDT");
    expect(decideMapAccept({ card: DEMAND, bias: lagged, last: 79_600 }).reason).toBe("kline_lag");
    expect(decideMapAccept({ card: { ...DEMAND, tf: "60" }, bias: bull, last: 79_600 }).reason).toBe("playbook_tf");
    expect(decideMapAccept({ card: { ...DEMAND, freshness: "deep", penetrationPct: 80 }, bias: bull, last: 79_600 }).reason).toBe("playbook_freshness");
    expect(decideMapAccept({ card: { ...DEMAND, rr: 1.2 }, bias: bull, last: 79_600 }).reason).toBe("playbook_rr");
  });

  test("reuses proximity: deep/invalid block; away wait is allowed", () => {
    delete process.env.AGENT_MAP;
    const bear = readMapBias(mapPayload({ direction: "bear", lastPrice: "79400" })).get("BTCUSDT");
    expect(decideMapAccept({ card: SUPPLY, bias: bear, last: 79_400 }).reason).toBe("proximity_deep");
    expect(decideMapAccept({ card: SUPPLY, bias: bear, last: 80_000 }).reason).toBe("proximity_invalid");
    expect(decideMapAccept({ card: SUPPLY, bias: bear, last: 79_000 }).reason).toBe("ok");
  });

  test("AGENT_MAP=0 does not run policy allow", () => {
    process.env.AGENT_MAP = "0";
    expect(decideMapAccept({ card: DEMAND, bias: undefined, last: 79_600 })).toEqual({
      allow: false,
      reason: "agent_map_off",
    });
  });
});

describe("onMapCloseAccept wiring", () => {
  test("4H close: policy runs before acceptZone; matching card lands, fade does not; no arm", async () => {
    delete process.env.AGENT_MAP;
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed({ lastPrice: "79600", markPrice: "79600" }));
    dirs.push(ctx.dir);
    const map = mapPayload({ direction: "bull", lastPrice: "79600" });
    const result = await onMapCloseAccept(
      { interval: "240", map },
      ctx.engine,
      { fetchCards: async () => [DEMAND, SUPPLY] },
    );
    expect(result?.accepted).toEqual([DEMAND.zoneId]);
    expect(result?.skipped).toBe(1);
    expect(ctx.engine.zones("accepted").map((row) => row.zoneId)).toEqual([DEMAND.zoneId]);
    expect(ctx.engine.orders("pending")).toEqual([]);
  });

  test("AGENT_MAP=0 skips agent policy and does not agent-accept (no P5 fallback)", async () => {
    process.env.AGENT_MAP = "0";
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed());
    dirs.push(ctx.dir);
    let fetched = 0;
    const result = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bull", lastPrice: "79600" }) },
      ctx.engine,
      {
        fetchCards: async () => {
          fetched += 1;
          return [DEMAND];
        },
      },
    );
    expect(result).toEqual({ accepted: [], skipped: 0 });
    expect(fetched).toBe(0);
    expect(ctx.engine.zones("accepted")).toEqual([]);
  });

  test("MAP_ACCEPT=0 skips the whole accept path; 1H close is a no-op", async () => {
    delete process.env.AGENT_MAP;
    process.env.MAP_ACCEPT = "0";
    const ctx = await paperEngine(mockFeed());
    dirs.push(ctx.dir);
    let fetched = 0;
    const off = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bull", lastPrice: "79600" }) },
      ctx.engine,
      {
        fetchCards: async () => {
          fetched += 1;
          return [DEMAND];
        },
      },
    );
    expect(off).toBeNull();
    expect(fetched).toBe(0);

    delete process.env.MAP_ACCEPT;
    const hour = await onMapCloseAccept(
      { interval: "60", map: mapPayload({ direction: "bull", lastPrice: "79600" }) },
      ctx.engine,
      {
        fetchCards: async () => {
          fetched += 1;
          return [DEMAND];
        },
      },
    );
    expect(hour).toBeNull();
    expect(fetched).toBe(0);
    expect(ctx.engine.zones("accepted")).toEqual([]);
  });

  test("MAP_ACCEPT pick still drops deep last before policy/accept", async () => {
    delete process.env.AGENT_MAP;
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed({ lastPrice: "79400", markPrice: "79400" }));
    dirs.push(ctx.dir);
    const result = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bear", lastPrice: "79400" }) },
      ctx.engine,
      { fetchCards: async () => [SUPPLY] },
    );
    expect(result?.accepted).toEqual([]);
    expect(ctx.engine.zones("accepted")).toEqual([]);
  });

  test("source is paper-only: no arm, no private Bybit, no ICT detector, no OAuth", async () => {
    for (const file of ["src/agent/bias.ts", "src/agent/policy.ts", "src/agent/index.ts", "src/index.ts"]) {
      const src = await Bun.file(file).text();
      expect(src).not.toContain("paperArm");
      expect(src).not.toContain("paper arm");
      expect(src).not.toContain("/v5/order");
      expect(src).not.toContain("BYBIT_API_KEY");
      expect(src).not.toContain("OAuth");
      expect(src).not.toContain("ICT");
    }
  });
});
