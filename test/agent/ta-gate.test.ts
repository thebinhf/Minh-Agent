import { afterEach, describe, expect, test } from "bun:test";
import {
  fibArmOk,
  oscAcceptVeto,
  revArmOk,
  shockArmOk,
  taArmWait,
  taFibMode,
  taOscMode,
  volArmOk,
} from "../../src/agent/ta-gate";

const saved = {
  fib: process.env.PAPER_TA_FIB,
  osc: process.env.AGENT_TA_OSC,
  vol: process.env.PAPER_TA_VOL,
  shock: process.env.PAPER_TA_SHOCK,
  rev: process.env.PAPER_TA_REV,
};

afterEach(() => {
  restore("PAPER_TA_FIB", saved.fib);
  restore("AGENT_TA_OSC", saved.osc);
  restore("PAPER_TA_VOL", saved.vol);
  restore("PAPER_TA_SHOCK", saved.shock);
  restore("PAPER_TA_REV", saved.rev);
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("P7 TA gates", () => {
  test("all flags default off", () => {
    delete process.env.PAPER_TA_FIB;
    delete process.env.AGENT_TA_OSC;
    delete process.env.PAPER_TA_VOL;
    delete process.env.PAPER_TA_SHOCK;
    delete process.env.PAPER_TA_REV;
    expect(taFibMode()).toBe("off");
    expect(taOscMode()).toBe("off");
    expect(fibArmOk(0.236)).toBe(true);
    expect(oscAcceptVeto("demand", { rsi14: 82, divergence: "bearish_div" })).toBe(null);
    expect(volArmOk(3)).toBe(true);
    expect(shockArmOk("impulse")).toBe(true);
    expect(revArmOk("demand", "bear_reversal")).toBe(true);
  });

  test("PAPER_TA_FIB=arm waits unless 0.5/0.618; missing passes", () => {
    process.env.PAPER_TA_FIB = "arm";
    expect(fibArmOk(null)).toBe(true);
    expect(fibArmOk(0.5)).toBe(true);
    expect(fibArmOk(0.618)).toBe(true);
    expect(fibArmOk(0.382)).toBe(false);
    expect(fibArmOk(0.786)).toBe(false);
    expect(taArmWait("demand", { fibNearest: 0.236, volumeRel: null, reversal: null, shock: null })).toBe(true);
    expect(taArmWait("demand", { fibNearest: 0.618, volumeRel: null, reversal: null, shock: null })).toBe(false);
  });

  test("AGENT_TA_OSC=accept is MAP deny when oscillator opposes; missing passes", () => {
    process.env.AGENT_TA_OSC = "accept";
    expect(oscAcceptVeto("demand", null)).toBe(null);
    expect(oscAcceptVeto("demand", { rsi14: null, divergence: null })).toBe(null);
    expect(oscAcceptVeto("demand", { rsi14: 71, divergence: null })).toBe("ta_osc");
    expect(oscAcceptVeto("demand", { rsi14: 40, divergence: "bearish_div" })).toBe("ta_osc");
    expect(oscAcceptVeto("supply", { rsi14: 28, divergence: null })).toBe("ta_osc");
    expect(oscAcceptVeto("supply", { rsi14: 60, divergence: "bullish_div" })).toBe("ta_osc");
    expect(oscAcceptVeto("demand", { rsi14: 40, divergence: "bullish_div" })).toBe(null);
  });

  test("PAPER_TA_VOL=arm waits on climax; 0/missing is not climax", () => {
    process.env.PAPER_TA_VOL = "arm";
    expect(volArmOk(null)).toBe(true);
    expect(volArmOk(1.2)).toBe(true);
    expect(volArmOk(2)).toBe(false);
  });

  test("PAPER_TA_SHOCK=arm waits impulse/vol_spike; quiet passes", () => {
    process.env.PAPER_TA_SHOCK = "arm";
    expect(shockArmOk(null)).toBe(true);
    expect(shockArmOk("quiet")).toBe(true);
    expect(shockArmOk("range_expand")).toBe(true);
    expect(shockArmOk("impulse")).toBe(false);
    expect(shockArmOk("vol_spike")).toBe(false);
  });

  test("PAPER_TA_REV=arm waits unless matching reversal; missing passes", () => {
    process.env.PAPER_TA_REV = "arm";
    expect(revArmOk("demand", null)).toBe(true);
    expect(revArmOk("demand", "bull_reversal")).toBe(true);
    expect(revArmOk("demand", "bear_reversal")).toBe(false);
    expect(revArmOk("supply", "bear_reversal")).toBe(true);
  });
});
