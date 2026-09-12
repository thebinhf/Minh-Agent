import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { agentMapEnabled, biasChopEnabled, biasChopMode, decideMapAccept, emptySkipReasons, onMapCloseAccept } from "../../src/agent/policy";
import { readMapBias } from "../../src/agent/bias";
import { mockFeed, OPEN_LONG, paperEngine } from "../paper/helpers";
import type { ZoneCard } from "../../src/zones/card";
import { HEALTH_OK, mapPayload } from "./htf";

const dirs: string[] = [];
const savedAccept = process.env.MAP_ACCEPT;
const savedAgent = process.env.AGENT_MAP;
const savedQuant = process.env.AGENT_QUANT;
const savedScore = process.env.PAPER_ZONE_SCORE;
const savedSkip = process.env.PAPER_MAP_SKIP;
const savedChop = process.env.AGENT_BIAS_CHOP;
const savedOsc = process.env.AGENT_TA_OSC;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedAccept === undefined) delete process.env.MAP_ACCEPT;
  else process.env.MAP_ACCEPT = savedAccept;
  if (savedAgent === undefined) delete process.env.AGENT_MAP;
  else process.env.AGENT_MAP = savedAgent;
  if (savedQuant === undefined) delete process.env.AGENT_QUANT;
  else process.env.AGENT_QUANT = savedQuant;
  if (savedScore === undefined) delete process.env.PAPER_ZONE_SCORE;
  else process.env.PAPER_ZONE_SCORE = savedScore;
  if (savedSkip === undefined) delete process.env.PAPER_MAP_SKIP;
  else process.env.PAPER_MAP_SKIP = savedSkip;
  if (savedChop === undefined) delete process.env.AGENT_BIAS_CHOP;
  else process.env.AGENT_BIAS_CHOP = savedChop;
  if (savedOsc === undefined) delete process.env.AGENT_TA_OSC;
  else process.env.AGENT_TA_OSC = savedOsc;
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

const ARM_DEMAND_LAST = 79_450;
const MIDRANGE_WAIT_LAST = 79_600;
const SUPPLY_ARM_LAST = 79_270;

describe("MAP policy", () => {
  test("AGENT_MAP follows MAP_ACCEPT kill pattern (default on, 0 off)", () => {
    delete process.env.AGENT_MAP;
    expect(agentMapEnabled()).toBe(true);
    process.env.AGENT_MAP = "0";
    expect(agentMapEnabled()).toBe(false);
  });

  test("bull → demand only; bear → supply only; chop / fade / gates / rr / codes drop", () => {
    delete process.env.AGENT_MAP;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) })).get("BTCUSDT");
    const bear = readMapBias(mapPayload({ direction: "bear", lastPrice: String(SUPPLY_ARM_LAST) })).get("BTCUSDT");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
    })).toEqual({ allow: true, reason: "ok" });
    expect(decideMapAccept({
      card: SUPPLY, bias: bear, last: SUPPLY_ARM_LAST, tradingAllowed: true,
    })).toEqual({ allow: true, reason: "ok" });
    expect(decideMapAccept({
      card: SUPPLY, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("bias_mismatch");
    expect(decideMapAccept({
      card: DEMAND, bias: undefined, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("bias_chop");
    process.env.AGENT_BIAS_CHOP = "0";
    expect(biasChopEnabled()).toBe(false);
    expect(decideMapAccept({
      card: DEMAND, bias: undefined, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).not.toBe("bias_chop");
    delete process.env.AGENT_BIAS_CHOP;
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: false,
    }).reason).toBe("gates_block");

    const lagged = readMapBias(mapPayload({
      direction: "bull", lastPrice: String(ARM_DEMAND_LAST), lagOk: false,
    })).get("BTCUSDT");
    expect(decideMapAccept({
      card: DEMAND, bias: lagged, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("gates_block");
    expect(decideMapAccept({
      card: { ...DEMAND, rr: 1.2 }, bias: bull, last: ARM_DEMAND_LAST, minRr: "2", tradingAllowed: true,
    }).reason).toBe("rr_fail");
    expect(decideMapAccept({
      card: { ...DEMAND, cancelCodes: ["expired"] }, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("expired");
    expect(decideMapAccept({
      card: { ...DEMAND, freshness: "deep", penetrationPct: 80 }, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("deep_mitigate");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, acceptedForSymbol: 2, tradingAllowed: true,
    }).reason).toBe("ledger_cap");
  });

  test("AGENT_TA_OSC=accept denies opposing RSI/div; missing osc is not a veto", () => {
    delete process.env.AGENT_MAP;
    delete process.env.AGENT_TA_OSC;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) })).get("BTCUSDT");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
      osc: { rsi14: 82, divergence: null },
    }).reason).toBe("ok");
    process.env.AGENT_TA_OSC = "accept";
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
      osc: { rsi14: 82, divergence: null },
    }).reason).toBe("ta_osc");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("ok");
  });

  test("1H chop keeps 4H; 4H chop proximal only when last is in-band", () => {
    delete process.env.AGENT_MAP;
    delete process.env.AGENT_BIAS_CHOP;
    expect(biasChopMode()).toBe("deny");
    const hourChop = readMapBias(mapPayload({
      direction: "bull", hour: "chop", lastPrice: String(ARM_DEMAND_LAST),
    })).get("BTCUSDT");
    expect(hourChop?.htf).toBe("bull");
    expect(decideMapAccept({
      card: DEMAND, bias: hourChop, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("ok");
    expect(decideMapAccept({
      card: DEMAND, bias: hourChop, last: MIDRANGE_WAIT_LAST, tradingAllowed: true,
    }).reason).toBe("stand_aside");
    process.env.AGENT_BIAS_CHOP = "off";
    expect(biasChopMode()).toBe("off");
    delete process.env.AGENT_BIAS_CHOP;
    const chop4h = readMapBias(mapPayload({
      direction: "chop", lastPrice: String(ARM_DEMAND_LAST),
    })).get("BTCUSDT");
    expect(chop4h?.htf).toBe("chop");
    expect(decideMapAccept({
      card: DEMAND, bias: chop4h, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("bias_chop");
    process.env.AGENT_BIAS_CHOP = "proximal";
    expect(biasChopMode()).toBe("proximal");
    expect(biasChopEnabled()).toBe(true);
    expect(decideMapAccept({
      card: DEMAND, bias: chop4h, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("ok");
    expect(decideMapAccept({
      card: DEMAND, bias: chop4h, last: MIDRANGE_WAIT_LAST, tradingAllowed: true,
    }).reason).toBe("bias_chop");
    delete process.env.AGENT_BIAS_CHOP;
  });

  test("mid-range + not proximal→entry → stand aside; in-band same-direction still allows", () => {
    delete process.env.AGENT_MAP;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: String(MIDRANGE_WAIT_LAST) })).get("BTCUSDT");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: MIDRANGE_WAIT_LAST, tradingAllowed: true,
    }).reason).toBe("stand_aside");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
    }).reason).toBe("ok");
  });

  test("reuses proximity: deep_mitigate / htf_break", () => {
    delete process.env.AGENT_MAP;
    const bear = readMapBias(mapPayload({ direction: "bear", lastPrice: "79400" })).get("BTCUSDT");
    expect(decideMapAccept({
      card: SUPPLY, bias: bear, last: 79_400, tradingAllowed: true,
    }).reason).toBe("deep_mitigate");
    expect(decideMapAccept({
      card: SUPPLY, bias: bear, last: 80_000, tradingAllowed: true,
    }).reason).toBe("htf_break");
  });

  test("quant cascade on demand is a veto; AGENT_QUANT=0 skips it", () => {
    delete process.env.AGENT_MAP;
    delete process.env.AGENT_QUANT;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) })).get("BTCUSDT");
    const tape = {
      crowded: null,
      oiReading: null,
      cascade: { active: true, side: "long" as const, fuel: "9" },
      flowReading: null,
    };
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true, tape,
    }).reason).toBe("quant_cascade");
    process.env.AGENT_QUANT = "0";
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true, tape,
    }).reason).toBe("ok");
  });

  test("sell_dom vs demand is quant_flow; same tape still allows supply", () => {
    delete process.env.AGENT_MAP;
    delete process.env.AGENT_QUANT;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) })).get("BTCUSDT");
    const bear = readMapBias(mapPayload({ direction: "bear", lastPrice: String(SUPPLY_ARM_LAST) })).get("BTCUSDT");
    const tape = {
      crowded: null,
      oiReading: null,
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: "sell_dom" as const,
    };
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true, tape,
    }).reason).toBe("quant_flow");
    expect(decideMapAccept({
      card: SUPPLY, bias: bear, last: SUPPLY_ARM_LAST, tradingAllowed: true, tape,
    }).reason).toBe("ok");
  });

  test("PAPER_MAP_SKIP=HYPEUSDT skips; unset allows HYPE", () => {
    delete process.env.AGENT_MAP;
    delete process.env.PAPER_MAP_SKIP;
    const bear = readMapBias(mapPayload({ direction: "bear", lastPrice: String(SUPPLY_ARM_LAST) })).get("BTCUSDT");
    const hype = { ...SUPPLY, symbol: "HYPEUSDT", zoneId: "hype-4h-s-20260908-01" };
    expect(decideMapAccept({
      card: hype, bias: bear, last: SUPPLY_ARM_LAST, tradingAllowed: true,
    }).reason).toBe("ok");
    process.env.PAPER_MAP_SKIP = "HYPEUSDT";
    expect(decideMapAccept({
      card: hype, bias: bear, last: SUPPLY_ARM_LAST, tradingAllowed: true,
    }).reason).toBe("map_skip");
    process.env.PAPER_MAP_SKIP = "0";
    expect(decideMapAccept({
      card: hype, bias: bear, last: SUPPLY_ARM_LAST, tradingAllowed: true,
    }).reason).toBe("ok");
  });

  test("family_floor vetoes sampled losers; cold history is not a veto", () => {
    delete process.env.AGENT_MAP;
    delete process.env.PAPER_ZONE_SCORE;
    const bull = readMapBias(mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) })).get("BTCUSDT");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
      family: { score: "0.3", trades: 4, avgRealizedRr: "-0.4" },
    }).reason).toBe("family_floor");
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
      family: { score: null, trades: 0, avgRealizedRr: null },
    }).reason).toBe("ok");
    process.env.PAPER_ZONE_SCORE = "0";
    expect(decideMapAccept({
      card: DEMAND, bias: bull, last: ARM_DEMAND_LAST, tradingAllowed: true,
      family: { score: "0.1", trades: 9, avgRealizedRr: "-1" },
    }).reason).toBe("ok");
  });
});

describe("onMapCloseAccept wiring", () => {
  test("4H close: policy before acceptZone; demand on bull lands; fade skipped; no arm", async () => {
    delete process.env.AGENT_MAP;
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed({ lastPrice: String(ARM_DEMAND_LAST), markPrice: String(ARM_DEMAND_LAST) }));
    dirs.push(ctx.dir);
    const map = mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) });
    const result = await onMapCloseAccept(
      { interval: "240", map },
      ctx.engine,
      { fetchCards: async () => [DEMAND, SUPPLY], health: HEALTH_OK },
    );
    expect(result?.accepted).toEqual([DEMAND.zoneId]);
    expect(ctx.engine.zones("accepted").map((row) => row.zoneId)).toEqual([DEMAND.zoneId]);
    expect(ctx.engine.zones("accepted").some((row) => row.zoneId === SUPPLY.zoneId)).toBe(false);
    expect(ctx.engine.orders("pending")).toEqual([]);

    const fade = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bull", lastPrice: String(MIDRANGE_WAIT_LAST) }) },
      ctx.engine,
      { fetchCards: async () => [{ ...SUPPLY, zoneId: "btc-4h-s-20260908-02" }], health: HEALTH_OK },
    );
    expect(fade?.accepted).toEqual([]);
    expect(fade?.skipped).toBe(1);
  });

  test("AGENT_MAP=0 is policy no-op: old MAP_ACCEPT path still copies", async () => {
    process.env.AGENT_MAP = "0";
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed({ lastPrice: String(MIDRANGE_WAIT_LAST), markPrice: String(MIDRANGE_WAIT_LAST) }));
    dirs.push(ctx.dir);
    const result = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bull", lastPrice: String(MIDRANGE_WAIT_LAST) }) },
      ctx.engine,
      { fetchCards: async () => [DEMAND, SUPPLY], health: HEALTH_OK },
    );
    expect(result?.accepted.sort()).toEqual([DEMAND.zoneId, SUPPLY.zoneId].sort());
    expect(ctx.engine.zones("accepted")).toHaveLength(2);
    expect(ctx.engine.orders("pending")).toEqual([]);
  });

  test("MAP_ACCEPT=0 skips the old accept path; 1H close is a no-op", async () => {
    delete process.env.AGENT_MAP;
    process.env.MAP_ACCEPT = "0";
    const ctx = await paperEngine(mockFeed());
    dirs.push(ctx.dir);
    let fetched = 0;
    const off = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) }) },
      ctx.engine,
      {
        health: HEALTH_OK,
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
      { interval: "60", map: mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) }) },
      ctx.engine,
      {
        health: HEALTH_OK,
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

  test("stale gates: no accept, does not close open positions", async () => {
    delete process.env.AGENT_MAP;
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed({ lastPrice: "63000", markPrice: "63000" }));
    dirs.push(ctx.dir);
    const opened = await ctx.engine.open(OPEN_LONG);
    expect(opened.position.status).toBe("open");
    let fetched = 0;
    const result = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bull", lastPrice: String(ARM_DEMAND_LAST) }) },
      ctx.engine,
      {
        health: { ok: true, url: "http://127.0.0.1:43180/health", klineLagOk: false },
        fetchCards: async () => {
          fetched += 1;
          return [DEMAND];
        },
      },
    );
    expect(result).toEqual({ accepted: [], skipped: 0, skipReasons: emptySkipReasons() });
    expect(fetched).toBe(0);
    expect(ctx.engine.zones("accepted")).toEqual([]);
    expect(ctx.engine.positions("open")).toHaveLength(1);
    expect(ctx.engine.positions("open")[0]?.id).toBe(opened.position.id);
    expect(ctx.engine.orders("pending")).toEqual([]);
  });

  test("MAP_ACCEPT pick still drops deep last before policy/accept", async () => {
    delete process.env.AGENT_MAP;
    delete process.env.MAP_ACCEPT;
    const ctx = await paperEngine(mockFeed({ lastPrice: "79400", markPrice: "79400" }));
    dirs.push(ctx.dir);
    const result = await onMapCloseAccept(
      { interval: "240", map: mapPayload({ direction: "bear", lastPrice: "79400" }) },
      ctx.engine,
      {
        fetchCards: async () => [
          SUPPLY,
          { ...SUPPLY, symbol: "HYPEUSDT", zoneId: "hype-4h-s-20260908-01" },
        ],
        health: HEALTH_OK,
      },
    );
    expect(result?.accepted).toEqual([]);
    expect(result?.skipReasons?.deep_mitigate).toBeGreaterThan(0);
    expect(result?.skipReasons?.map_skip ?? 0).toBe(0);
    expect(ctx.engine.zones("accepted")).toEqual([]);
  });

  test("source is paper-only: no arm, no private Bybit, no ICT/FVG, no OAuth", async () => {
    for (const file of ["src/agent/bias.ts", "src/agent/policy.ts", "src/agent/index.ts", "src/index.ts"]) {
      const src = await Bun.file(file).text();
      expect(src).not.toContain("paperArm");
      expect(src).not.toContain("paper arm");
      expect(src).not.toContain("/v5/order");
      expect(src).not.toContain("BYBIT_API_KEY");
      expect(src).not.toContain("OAuth");
      expect(src).not.toContain("ICT");
      expect(src).not.toContain("FVG");
    }
  });
});
