import { describe, expect, test } from "bun:test";
import { Dec, REL_TOL } from "../../src/paper/decimal";

describe("Dec TEXT math", () => {
  test("parses, adds, and strips trailing zeros", () => {
    expect(Dec.from("10000").add(Dec.from("3.330")).toText()).toBe("10003.33");
    expect(Dec.from("0.0200").toText()).toBe("0.02");
    expect(Dec.from("-1.50").toText()).toBe("-1.5");
  });

  test("sizes qty as risk_budget / stop_dist (3% of 10000, stop 3000)", () => {
    const budget = Dec.from("10000").mul(Dec.from("0.03"));
    const qty = budget.div(Dec.from("3000"));
    expect(budget.toText()).toBe("300");
    expect(qty.toText()).toBe("0.1");
    expect(Dec.from("3000").mul(qty).toText()).toBe("300");
  });

  test("linear long/short pnl", () => {
    const qty = Dec.from("0.1");
    const long = Dec.from("64000").sub(Dec.from("63000")).mul(qty);
    const short = Dec.from("63000").sub(Dec.from("62000")).mul(qty);
    expect(long.toText()).toBe("100");
    expect(short.toText()).toBe("100");
  });

  test("relative slack accepts 1e-8 overage and rejects larger", () => {
    const budget = Dec.from("300");
    const ok = Dec.from("300.000003");
    const bad = Dec.from("300.01");
    expect(ok.lteRel(budget, REL_TOL)).toBe(true);
    expect(bad.lteRel(budget, REL_TOL)).toBe(false);
  });

  test("rejects non-decimal text", () => {
    expect(() => Dec.from("1e3")).toThrow("invalid decimal");
    expect(() => Dec.from("")).toThrow("invalid decimal");
  });
});
