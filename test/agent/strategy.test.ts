import { afterEach, describe, expect, test } from "bun:test";
import {
  METHOD_USE,
  armGateApplies,
  armGatesForSetup,
  eventBeR,
  eventManageApplies,
  eventManagesForSetup,
} from "../../src/agent/strategy";

const savedBe = process.env.PAPER_BE_R;

afterEach(() => {
  if (savedBe === undefined) delete process.env.PAPER_BE_R;
  else process.env.PAPER_BE_R = savedBe;
});

describe("strategy map", () => {
  test("setups emit; ICT confirms; discretionary never; BE is event manage", () => {
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
    expect(METHOD_USE.break_even).toBe("event_manage");
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

  test("P9 BE applies to every setup; PAPER_BE_R default off", () => {
    expect(eventManagesForSetup("sd")).toEqual(["be"]);
    expect(eventManagesForSetup("breakout")).toEqual(["be"]);
    expect(eventManagesForSetup("reversal")).toEqual(["be"]);
    expect(eventManageApplies("be", "reversal")).toBe(true);
    delete process.env.PAPER_BE_R;
    expect(eventBeR()).toBeNull();
    process.env.PAPER_BE_R = "0";
    expect(eventBeR()).toBeNull();
    process.env.PAPER_BE_R = "0.5";
    expect(eventBeR()).toBe(0.5);
  });
});
