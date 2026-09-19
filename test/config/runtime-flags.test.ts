import { describe, expect, test } from "bun:test";
import { assertValidRuntimeEnv, validateRuntimeEnv } from "../../src/config/runtime-flags";

describe("runtime env validation", () => {
  test("empty env is valid (all defaults)", () => {
    expect(validateRuntimeEnv({})).toEqual([]);
  });

  test("canonical values pass", () => {
    expect(validateRuntimeEnv({
      AGENT_MAP: "1",
      AGENT_BIAS_CHOP: "deny",
      PAPER_MAP_ALLOCATE: "rank",
      PAPER_ARM_MAX: "2",
      PAPER_BE_R: "0.5",
      PAPER_ZONE_SCORE_RR: "1",
      AGENT_ZONE_FRESH: "1",
      PAPER_SETUPS: "sd,breakout,reversal",
      PAPER_OBSERVE: "1",
      MINH_DECISION_LOG: "1",
      MAP_CLOSE_WEBHOOK: "http://127.0.0.1:43182/live/map-close",
      ZONE_MIN_RR: "1.5",
    })).toEqual([]);
  });

  test("typos fail fast instead of silent default", () => {
    expect(validateRuntimeEnv({ PAPER_ARM_MAX: "abc" }).length).toBe(1);
    expect(validateRuntimeEnv({ PAPER_BE_R: "soon" }).length).toBe(1);
    expect(validateRuntimeEnv({ ZONE_MIN_RR: "abc" }).length).toBe(1);
    expect(validateRuntimeEnv({ ZONE_MIN_RR: "0" }).length).toBe(1);
    expect(validateRuntimeEnv({ AGENT_BIAS_CHOP: "chop" }).length).toBe(1);
    expect(validateRuntimeEnv({ PAPER_MAP_ALLOCATE: "armed" }).length).toBe(1);
    expect(validateRuntimeEnv({ PAPER_TA_FIB: "armed" }).length).toBe(1);
    expect(validateRuntimeEnv({ PAPER_SETUPS: "ict" }).length).toBe(1);
    expect(validateRuntimeEnv({ PAPER_MAP_SKIP: "BTC" }).length).toBe(1);
    expect(validateRuntimeEnv({ MAP_CLOSE_WEBHOOK: "not-a-url" }).length).toBe(1);
    expect(validateRuntimeEnv({ AGENT_MAP: "yes" }).length).toBe(1);
    expect(validateRuntimeEnv({ MINH_DECISION_LOG: "on" }).length).toBe(1);
  });

  test("assert throws with actionable message", () => {
    expect(() => assertValidRuntimeEnv({ PAPER_ARM_MAX: "abc" })).toThrow("PAPER_ARM_MAX");
  });
});
