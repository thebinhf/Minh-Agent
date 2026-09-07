import { describe, expect, test } from "bun:test";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import {
  alertHit,
  assertInvalidateSide,
  limitFillHit,
  limitInvalidated,
  limitPostOnlyOk,
  parseAlertOp,
  parseOco,
  parsePostOnly,
} from "../../src/paper/watch";

describe("alert / limit helpers", () => {
  test("parses alert op and hits inclusive of the level", () => {
    expect(parseAlertOp("above")).toBe("above");
    expect(parseAlertOp("BELOW")).toBe("below");
    expect(() => parseAlertOp("through")).toThrow(PaperReject);
    expect(alertHit("above", Dec.from("118000"), Dec.from("118000"))).toBe(true);
    expect(alertHit("above", Dec.from("117999"), Dec.from("118000"))).toBe(false);
    expect(alertHit("below", Dec.from("4200"), Dec.from("4200"))).toBe(true);
    expect(alertHit("below", Dec.from("4200.5"), Dec.from("4200"))).toBe(false);
  });

  test("limit fill vs post-only rest on the book", () => {
    expect(limitPostOnlyOk("long", Dec.from("63000"), Dec.from("62000"))).toBe(true);
    expect(limitPostOnlyOk("long", Dec.from("63000"), Dec.from("63000"))).toBe(false);
    expect(limitPostOnlyOk("short", Dec.from("63000"), Dec.from("64000"))).toBe(true);
    expect(limitFillHit("long", Dec.from("62000"), Dec.from("62000"))).toBe(true);
    expect(limitFillHit("long", Dec.from("62001"), Dec.from("62000"))).toBe(false);
    expect(limitFillHit("short", Dec.from("64000"), Dec.from("64000"))).toBe(true);
    expect(parsePostOnly(undefined)).toBe(true);
    expect(parsePostOnly(false)).toBe(false);
  });

  test("OCO invalidation sits on the stop side and hits inclusive of the level", () => {
    expect(parseOco(undefined)).toBe(true);
    expect(parseOco(false)).toBe(false);
    assertInvalidateSide("long", Dec.from("62000"), Dec.from("60000"));
    assertInvalidateSide("short", Dec.from("64000"), Dec.from("66000"));
    expect(() => assertInvalidateSide("long", Dec.from("62000"), Dec.from("62000"))).toThrow(PaperReject);
    expect(limitInvalidated("long", Dec.from("60000"), Dec.from("60000"))).toBe(true);
    expect(limitInvalidated("long", Dec.from("60001"), Dec.from("60000"))).toBe(false);
    expect(limitInvalidated("short", Dec.from("66000"), Dec.from("66000"))).toBe(true);
  });
});
