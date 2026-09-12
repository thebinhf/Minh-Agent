import { describe, expect, test } from "bun:test";
import { proximityDecision } from "../../src/zones/proximity";
import type { ZoneCard } from "../../src/zones/card";

const SUPPLY: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
  setup: "sd",
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

describe("proximityDecision", () => {
  test("supply: wait above zone, arm in proximal band, wait through entry, deep, invalid", () => {
    expect(proximityDecision(SUPPLY, 80_000)).toBe("invalid");
    expect(proximityDecision(SUPPLY, 79_600)).toBe("wait");
    expect(proximityDecision(SUPPLY, 79_280)).toBe("arm");
    expect(proximityDecision(SUPPLY, 79_350)).toBe("wait");
    expect(proximityDecision(SUPPLY, 79_400)).toBe("deep");
    expect(proximityDecision(SUPPLY, 79_880)).toBe("invalid");
    expect(proximityDecision(SUPPLY, 79_000)).toBe("wait");
  });
});
