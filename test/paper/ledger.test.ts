import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { parsePaperArgs } from "../../src/paper/cli";
import { paperDesk } from "../../src/paper/ops";
import { mockFeed, paperEngine } from "./helpers";
import type { ZoneCard } from "../../src/zones/card";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("paper zone ledger", () => {
  test("CLI parses zone list / accept / reject", () => {
    expect(parsePaperArgs(["zone", "list"])).toEqual({ name: "zone-list", status: "accepted" });
    expect(parsePaperArgs(["zone", "accept", "card.json"])).toEqual({ name: "zone-accept", token: "card.json" });
    expect(parsePaperArgs(["zone", "accept", "btc-4h-s-01"])).toEqual({ name: "zone-accept", token: "btc-4h-s-01" });
    expect(parsePaperArgs(["zone", "reject", "btc-4h-s-01", "--code", "htf_break"])).toEqual({
      name: "zone-reject",
      zoneId: "btc-4h-s-01",
      code: "htf_break",
    });
  });

  test("accept remembers the card; does not arm; cap 2; expire; reject", async () => {
    const ctx = await paperEngine(mockFeed({ lastPrice: "80000", markPrice: "80000" }));
    dirs.push(ctx.dir);
    const now = Date.now();
    const accepted = ctx.engine.acceptZone(CARD, now);
    expect(accepted.status).toBe("accepted");
    expect(accepted.zoneId).toBe(CARD.zoneId);
    expect(ctx.engine.orders("pending")).toEqual([]);
    expect(ctx.engine.alerts("armed")).toEqual([]);
    expect(paperDesk(ctx.engine).zones).toEqual([CARD]);

    const second = { ...CARD, zoneId: "btc-4h-s-20260908-02", entry: 79_310 };
    ctx.engine.acceptZone(second, now);
    const third = { ...CARD, zoneId: "btc-4h-s-20260908-03", entry: 79_320 };
    expect(() => ctx.engine.acceptZone(third, now)).toThrow(/ledger_cap/);

    const rejected = ctx.engine.rejectZone(CARD.zoneId, "ops_cancel", now + 1);
    expect(rejected.status).toBe("rejected");
    expect(ctx.engine.zones("accepted")).toHaveLength(1);

    const later = now + 48 * 4 * 60 * 60 * 1000;
    const leftover = ctx.engine.zones("accepted", later);
    expect(leftover).toEqual([]);
    expect(ctx.engine.zones("expired", later)[0]?.zoneId).toBe("btc-4h-s-20260908-02");
  });

  test("source does not paper arm or hit private Bybit", async () => {
    const src = await Bun.file("src/zones/ledger.ts").text();
    expect(src).not.toContain("paper arm");
    expect(src).not.toContain("/v5/order");
  });
});
