import { describe, expect, test } from "bun:test";
import { PaperReject } from "../../src/paper/errors";
import {
  acceptTokenKind,
  isZoneCardBody,
  pickZoneCard,
  resolveAcceptPayload,
} from "../../src/paper/zone-accept";
import type { ZoneCard } from "../../src/zones/card";

const CARD: ZoneCard = {
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

describe("zone accept lookup", () => {
  test("id vs file token; pick from /zones payload", () => {
    expect(acceptTokenKind("btc-4h-s-20260908-01")).toBe("zoneId");
    expect(acceptTokenKind("card.json")).toBe("file");
    expect(acceptTokenKind("./zones/card.json")).toBe("file");
    expect(isZoneCardBody(CARD)).toBe(true);
    expect(isZoneCardBody({ zoneId: CARD.zoneId })).toBe(false);
    expect(pickZoneCard({ zones: [CARD] }, CARD.zoneId)?.entry).toBe(79_300);
    expect(pickZoneCard({ zones: [] }, CARD.zoneId)).toBeNull();
  });

  test("resolveAcceptPayload accepts a full card or looks up zoneId", async () => {
    const got = await resolveAcceptPayload(CARD, "http://127.0.0.1:43180");
    expect(got.zoneId).toBe(CARD.zoneId);
    const looked = await resolveAcceptPayload(
      { zoneId: CARD.zoneId },
      "http://127.0.0.1:43180",
      async (url) => {
        expect(url).toContain("/zones?interval=240");
        return { zones: [CARD] };
      },
    );
    expect(looked.symbol).toBe("BTCUSDT");
    await expect(resolveAcceptPayload(
      { zoneId: "missing" },
      "http://127.0.0.1:43180",
      async () => ({ zones: [] }),
    )).rejects.toBeInstanceOf(PaperReject);
  });
});
