import { describe, expect, test } from "bun:test";
import { loadPaperConfig } from "../../src/paper/config";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import {
  assertOptionalMinRr,
  assertSlTpSide,
  normalizeTimeframes,
  parseSide,
  pnlAt,
  requireBandPct,
  sizeFromRisk,
  slHit,
  tpHit,
} from "../../src/paper/risk";
import type { PaperAccountRow } from "../../src/paper/types";

function account(partial: Partial<PaperAccountRow> = {}): PaperAccountRow {
  return {
    id: 1,
    name: "minh-paper",
    quote: "USDT",
    cash: "10000",
    equity: "10000",
    starting_cash: "10000",
    risk_pct_min: "0.01",
    risk_pct_max: "0.10",
    default_risk_pct: "0.02",
    min_rr: null,
    fee_rate: "0",
    maker_fee_rate: "0",
    leverage_min: "1",
    leverage_max: "25",
    default_leverage: "1",
    mm_rate: "0.005",
    margin_mode: "isolated",
    created_ts: 0,
    updated_ts: 0,
    ...partial,
  };
}

describe("risk engine", () => {
  test("3% open sizes qty from equity and stop distance", () => {
    const sized = sizeFromRisk({
      equity: Dec.from("10000"),
      riskPct: Dec.from("0.03"),
      side: "long",
      entry: Dec.from("63000"),
      stopLoss: Dec.from("60000"),
      takeProfit: Dec.from("66000"),
    });
    expect(sized.qty.toText()).toBe("0.1");
    expect(sized.riskQuote.toText()).toBe("300");
    expect(sized.rewardQuote.toText()).toBe("300");
    expect(sized.rr.toText()).toBe("1");
  });

  test("reads the 1–10% band from the account — 15% rejected, 1% and 10% allowed", () => {
    expect(requireBandPct(account(), "0.01").toText()).toBe("0.01");
    expect(requireBandPct(account(), "0.08").toText()).toBe("0.08");
    expect(requireBandPct(account(), "0.10").toText()).toBe("0.1");
    expect(() => requireBandPct(account(), "0.15")).toThrow(PaperReject);
    expect(() => requireBandPct(account(), "0.005")).toThrow(PaperReject);
    try {
      requireBandPct(account(), "0.15");
    } catch (error) {
      expect(error).toBeInstanceOf(PaperReject);
      expect((error as PaperReject).error).toBe("risk_pct_out_of_band");
      expect((error as PaperReject).gate).toBe("risk_pct");
    }
    expect(requireBandPct(account(), undefined).toText()).toBe("0.02");
  });

  test("min_rr unset allows rr < 2; configured floor rejects", () => {
    const rr = Dec.from("1");
    expect(() => assertOptionalMinRr(account({ min_rr: null }), rr)).not.toThrow();
    expect(() => assertOptionalMinRr(account({ min_rr: "1.5" }), rr)).toThrow(PaperReject);
    try {
      assertOptionalMinRr(account({ min_rr: "1.5" }), rr);
    } catch (error) {
      expect((error as PaperReject).error).toBe("rr_below_min");
      expect((error as PaperReject).gate).toBe("rr");
    }
  });

  test("SL/TP must sit on the correct side of entry", () => {
    expect(() => assertSlTpSide("long", Dec.from("10"), Dec.from("11"), Dec.from("12"))).toThrow(PaperReject);
    expect(() => assertSlTpSide("long", Dec.from("10"), Dec.from("9"), Dec.from("8"))).toThrow(PaperReject);
    expect(() => assertSlTpSide("short", Dec.from("10"), Dec.from("9"), Dec.from("8"))).toThrow(PaperReject);
    expect(() => assertSlTpSide("short", Dec.from("10"), Dec.from("11"), Dec.from("12"))).toThrow(PaperReject);
    expect(() => assertSlTpSide("long", Dec.from("10"), Dec.from("9"), Dec.from("12"))).not.toThrow();
  });

  test("source file has no hardcoded RISK_PCT / MIN_RR policy constants", async () => {
    const src = await Bun.file(new URL("../../src/paper/risk.ts", import.meta.url)).text();
    expect(src).not.toMatch(/RISK_PCT\s*=/);
    expect(src).not.toMatch(/MIN_RR\s*=/);
    expect(src).not.toMatch(/const\s+RISK_PCT/);
    expect(src).not.toMatch(/0\.02/);
    expect(src).not.toMatch(/MIN_RR/);
  });

  test("operator config seeds minRr 2 — engine still has no MIN_RR constant", async () => {
    const cfg = await loadPaperConfig();
    expect(cfg.account.minRr).toBe("2");
    expect(cfg.account.defaultRiskPct).toBe("0.02");
    expect(cfg.account.leverageMax).toBe("150");
    expect(cfg.account.defaultLeverage).toBe("10");
  });

  test("MTF normalizes unique intervals and keeps HTF→LTF order", () => {
    expect(normalizeTimeframes(["240", "60", "60", "15"])).toEqual(["240", "60", "15"]);
    expect(parseSide("LONG")).toBe("long");
    expect(() => parseSide("flat")).toThrow(PaperReject);
  });

  test("SL wins the evaluation order when both levels could fire", () => {
    expect(slHit("long", Dec.from("90"), Dec.from("100"))).toBe(true);
    expect(tpHit("long", Dec.from("210"), Dec.from("200"))).toBe(true);
    expect(pnlAt("long", Dec.from("100"), Dec.from("110"), Dec.from("2")).toText()).toBe("20");
    expect(pnlAt("short", Dec.from("100"), Dec.from("90"), Dec.from("2")).toText()).toBe("20");
  });
});
