import { afterEach, describe, expect, test } from "bun:test";
import {
  compareZoneCards,
  familyFloorVeto,
  familyFromCard,
  familyKey,
  familyScoreMin,
  paperZoneScoreEnabled,
  parseFamilyFromZoneId,
  rankZoneCards,
  zoneScore,
} from "../../src/paper/score";
import type { ZoneCard } from "../../src/zones/card";

const saved = process.env.PAPER_ZONE_SCORE;
const savedFloor = process.env.PAPER_FAMILY_SCORE_MIN;
const savedMinTrades = process.env.PAPER_FAMILY_FLOOR_MIN_TRADES;

afterEach(() => {
  if (saved === undefined) delete process.env.PAPER_ZONE_SCORE;
  else process.env.PAPER_ZONE_SCORE = saved;
  if (savedFloor === undefined) delete process.env.PAPER_FAMILY_SCORE_MIN;
  else process.env.PAPER_FAMILY_SCORE_MIN = savedFloor;
  if (savedMinTrades === undefined) delete process.env.PAPER_FAMILY_FLOOR_MIN_TRADES;
  else process.env.PAPER_FAMILY_FLOOR_MIN_TRADES = savedMinTrades;
});
const SUPPLY: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
  baseStartTs: 1,
  baseEndTs: 2,
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

describe("zone score from paper metrics", () => {
  test("PAPER_ZONE_SCORE follows MAP kill pattern (default on, 0 off)", () => {
    delete process.env.PAPER_ZONE_SCORE;
    expect(paperZoneScoreEnabled()).toBe(true);
    process.env.PAPER_ZONE_SCORE = "0";
    expect(paperZoneScoreEnabled()).toBe(false);
  });

  test("parses detector zoneIds; operator stamps stay null", () => {
    expect(parseFamilyFromZoneId("btc-4h-s-20260908-01")).toEqual({
      symbol: "BTCUSDT",
      tf: "240",
      side: "supply",
    });
    expect(parseFamilyFromZoneId("eth-1h-d-20260908-02")).toEqual({
      symbol: "ETHUSDT",
      tf: "60",
      side: "demand",
    });
    expect(parseFamilyFromZoneId("htf-demand-1")).toBeNull();
    expect(parseFamilyFromZoneId(null)).toBeNull();
    expect(familyKey(familyFromCard(SUPPLY))).toBe("BTCUSDT:240:supply");
  });

  test("cold start is null; fillRate and winRate blend when sampled", () => {
    expect(zoneScore({ trades: 0, wins: 0, filled: 0, invalidated: 0, cancelled: 0 })).toBeNull();
    expect(zoneScore({ trades: 1, wins: 1, filled: 1, invalidated: 0, cancelled: 0 })).toBeNull();
    expect(zoneScore({ trades: 2, wins: 1, filled: 2, invalidated: 0, cancelled: 0 })).toBe("0.8");
    expect(zoneScore({ trades: 0, wins: 0, filled: 1, invalidated: 2, cancelled: 0 })).toBe("0.333333333333333333");
    expect(zoneScore({ trades: 2, wins: 2, filled: 0, invalidated: 0, cancelled: 0 })).toBe("1");
  });

  test("rank keeps input order when every score is null or kill is off", () => {
    const low: ZoneCard = { ...SUPPLY, zoneId: "btc-4h-s-20260908-02", rr: 2.1 };
    const high: ZoneCard = { ...SUPPLY, zoneId: "btc-4h-s-20260908-03", rr: 4 };
    delete process.env.PAPER_ZONE_SCORE;
    expect(rankZoneCards([low, high], () => null)).toEqual([low, high]);
    process.env.PAPER_ZONE_SCORE = "0";
    expect(rankZoneCards([low, high], () => "1")).toEqual([low, high]);
    delete process.env.PAPER_ZONE_SCORE;
    const ranked = rankZoneCards([low, high], (card) => (card.rr > 3 ? "0.9" : "0.2"));
    expect(ranked.map((card) => card.zoneId)).toEqual([high.zoneId, low.zoneId]);
    expect(compareZoneCards(high, low, () => "0.5")).toBeLessThan(0);
  });

  test("familyFloorVeto: cold is not a veto; low score or realized RR ≤ 0 is", () => {
    delete process.env.PAPER_ZONE_SCORE;
    delete process.env.PAPER_FAMILY_SCORE_MIN;
    expect(familyScoreMin().toText()).toBe("0.5");
    expect(familyFloorVeto(null)).toBe(false);
    expect(familyFloorVeto({ score: null, trades: 0, avgRealizedRr: null })).toBe(false);
    expect(familyFloorVeto({ score: "0.3", trades: 5, avgRealizedRr: "0.2" })).toBe(true);
    expect(familyFloorVeto({ score: "0.8", trades: 5, avgRealizedRr: "0" })).toBe(true);
    expect(familyFloorVeto({ score: "0.8", trades: 5, avgRealizedRr: "-0.1" })).toBe(true);
    expect(familyFloorVeto({ score: "0.8", trades: 5, avgRealizedRr: "0.2" })).toBe(false);
    expect(familyFloorVeto({ score: null, trades: 1, avgRealizedRr: "-1" })).toBe(false);
    process.env.PAPER_FAMILY_FLOOR_MIN_TRADES = "1";
    expect(familyFloorVeto({ score: null, trades: 1, avgRealizedRr: "-1" })).toBe(true);
    process.env.PAPER_ZONE_SCORE = "0";

    expect(familyFloorVeto({ score: "0.1", trades: 9, avgRealizedRr: "-1" })).toBe(false);
  });
});
