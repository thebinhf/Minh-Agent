import { describe, expect, test } from "bun:test";
import { Dec } from "../../src/paper/decimal";
import { PaperReject } from "../../src/paper/errors";
import {
  alertHit,
  limitFillHit,
  limitPostOnlyOk,
  parseAlertOp,
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
});
