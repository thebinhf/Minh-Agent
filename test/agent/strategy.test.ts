import { describe, expect, test } from "bun:test";
import { METHOD_USE, armGateApplies, armGatesForSetup } from "../../src/agent/strategy";

describe("strategy map", () => {
  test("setups emit; ICT confirms; discretionary never", () => {
    expect(METHOD_USE.supply_demand).toBe("setup");
    expect(METHOD_USE.breakouts).toBe("setup");
    expect(METHOD_USE.reversal).toBe("setup");
    expect(METHOD_USE.fvg).toBe("confirm");
    expect(METHOD_USE.bos).toBe("confirm");
    expect(METHOD_USE.choch).toBe("confirm");
    expect(METHOD_USE.elliott).toBe("never");
    expect(METHOD_USE.moon_phases).toBe("never");
    expect(METHOD_USE.harmonic).toBe("never");
    expect(METHOD_USE.gann).toBe("never");
    expect(METHOD_USE.fibonacci).toBe("arm_gate");
    expect(METHOD_USE.oscillators).toBe("accept_gate");
  });

  test("P7 arm gates are setup-aware", () => {
    expect(armGatesForSetup("sd")).toEqual(["fib", "vol", "shock", "rev"]);
    expect(armGatesForSetup("breakout")).toEqual(["vol", "shock"]);
    expect(armGatesForSetup("reversal")).toEqual(["vol"]);
    expect(armGateApplies("fib", "breakout")).toBe(false);
    expect(armGateApplies("rev", "reversal")).toBe(false);
    expect(armGateApplies("shock", "breakout")).toBe(true);
    expect(armGateApplies("vol", "reversal")).toBe(true);
  });
});
