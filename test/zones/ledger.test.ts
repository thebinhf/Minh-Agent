import { describe, expect, test } from "bun:test";
import { LEDGER_CAP_PER_SYMBOL, ledgerDue, zoneExpiresTs } from "../../src/zones/ledger";
import type { ZoneCard } from "../../src/zones/card";

const CARD: ZoneCard = {
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

describe("zone ledger helpers", () => {
  test("expiry is expiryBars * 4h; cap is 2", () => {
    const accepted = 1_700_000_000_000;
    expect(zoneExpiresTs(CARD, accepted)).toBe(accepted + 48 * 4 * 60 * 60 * 1000);
    expect(LEDGER_CAP_PER_SYMBOL).toBe(2);
    expect(ledgerDue({ status: "accepted", expiresTs: accepted }, accepted)).toBe(true);
    expect(ledgerDue({ status: "accepted", expiresTs: accepted + 1 }, accepted)).toBe(false);
    expect(ledgerDue({ status: "rejected", expiresTs: accepted }, accepted)).toBe(false);
  });
});
