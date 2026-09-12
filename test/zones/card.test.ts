import { describe, expect, test } from "bun:test";
import {
  CANCEL_CODES,
  ZONE_CARD_KEYS,
  ZONE_FRESHNESS,
  ZoneCardError,
  emptyCancelCodeCounts,
  parseCancelCode,
  parseZoneCard,
  parseZoneFreshness,
  type ZoneCard,
} from "../../src/zones/card";

const EXAMPLE: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
  setup: "sd",
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

describe("zone-card v1 schema", () => {
  test("locked enums", () => {
    expect(ZONE_FRESHNESS).toEqual(["virgin", "touched", "deep"]);
    expect(CANCEL_CODES).toEqual([
      "never_touched",
      "ops_cancel",
      "deep_mitigate",
      "htf_break",
      "expired",
      "rr_fail",
      "gates_block",
    ]);
    expect(Object.keys(emptyCancelCodeCounts())).toEqual([...CANCEL_CODES]);
  });

  test("parses the illustrative Minh example", () => {
    const card = parseZoneCard(EXAMPLE);
    expect(card.zoneId).toBe("btc-4h-s-20260908-01");
    expect(card.side).toBe("supply");
    expect(card.setup).toBe("sd");
    expect(card.freshness).toBe("virgin");
    expect(Object.keys(card)).toEqual([...ZONE_CARD_KEYS]);
  });

  test("rejects unknown freshness and cancel codes", () => {
    expect(() => parseZoneFreshness("fresh")).toThrow(ZoneCardError);
    expect(() => parseCancelCode("oops")).toThrow(ZoneCardError);
    expect(() => parseZoneCard({ ...EXAMPLE, freshness: "stale" })).toThrow(ZoneCardError);
    expect(() => parseZoneCard({ ...EXAMPLE, cancelCodes: ["nope"] })).toThrow(ZoneCardError);
    expect(() => parseZoneCard({ ...EXAMPLE, side: "short" })).toThrow(ZoneCardError);
  });

  test("demand geometry: distal is zoneLow", () => {
    const demand = parseZoneCard({
      ...EXAMPLE,
      zoneId: "btc-4h-d-20260908-01",
      side: "demand",
      distal: 79_250,
      proximal: 79_472,
      entry: 79_400,
      sl: 79_100,
      tp: 80_200,
      hardInvalid: 79_100,
      softInvalid: 79_250,
    });
    expect(demand.side).toBe("demand");
    expect(demand.distal).toBe(demand.zoneLow);
  });
});
