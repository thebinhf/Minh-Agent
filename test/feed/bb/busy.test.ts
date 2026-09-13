import { describe, expect, spyOn, test } from "bun:test";
import { busyTolerant } from "../../../src/feed/bb/db";

function busyError(): Error {
  return new Error("SQLiteError: database is locked");
}

describe("feed busy tolerance", () => {
  test("retries a busy write and succeeds on a later attempt", () => {
    let calls = 0;
    const out = busyTolerant("test-retry", () => {
      calls += 1;
      if (calls < 3) throw busyError();
      return "saved";
    });
    expect(out).toBe("saved");
    expect(calls).toBe(3);
  });

  test("rethrows errors that are not busy-class", () => {
    expect(() =>
      busyTolerant("test-rethrow", () => {
        throw new Error("NOT NULL constraint failed");
      }),
    ).toThrow(/constraint failed/);
  });

  test("drops the batch after exhausting attempts instead of crashing", () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      let calls = 0;
      const out = busyTolerant(
        "test-drop",
        () => {
          calls += 1;
          throw busyError();
        },
        3,
      );
      expect(out).toBeUndefined();
      expect(calls).toBe(3);
      expect(logs.join("\n")).toContain("test-drop write dropped after 3 busy retries");
    } finally {
      spy.mockRestore();
    }
  });

  test("drop logging is throttled per label", () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      for (let i = 0; i < 2; i++) {
        busyTolerant(
          "test-throttle",
          () => {
            throw busyError();
          },
          1,
        );
      }
      expect(logs.filter((line) => line.includes("test-throttle")).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
