import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertExecMode, ExecSafetyError } from "../../src/exec-mode";
import { assertSeparateDb } from "../../src/paper/config";
import { PaperSafetyError } from "../../src/paper/errors";

const SRC_ROOT = resolve(import.meta.dir, "../../src");
const ORDER_TOKENS = ["/v5/order", "X-BAPI", "createHmac"] as const;
// paper/config.ts holds KEY_ENV_NAMES, the guard that scans process.env for
// key names — the one file outside src/exec/ allowed to spell a key env name.
const KEY_TOKEN_ALLOWLIST = new Set(["paper/config.ts"]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("exec boundary", () => {
  test("order routes, signing and key literals exist only in src/exec/", async () => {
    for (const file of tsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      if (rel === "exec" || rel.startsWith("exec/")) continue;
      const src = await Bun.file(file).text();
      for (const token of ORDER_TOKENS) {
        expect(src, `${rel} must not contain ${token}`).not.toContain(token);
      }
      if (!KEY_TOKEN_ALLOWLIST.has(rel)) {
        expect(src, `${rel} must not contain BYBIT_API_KEY`).not.toContain("BYBIT_API_KEY");
      }
    }
  });

  test("the key-name allowlist stays real", async () => {
    const src = await Bun.file(join(SRC_ROOT, "paper/config.ts")).text();
    expect(src).toContain("BYBIT_API_KEY");
  });

  test("assertSeparateDb rejects a db path shared by any two processes", () => {
    expect(() =>
      assertSeparateDb(
        "/tmp/feed.sqlite",
        "/tmp/paper.sqlite",
        "/tmp/live.sqlite",
        "/tmp/exec.sqlite",
      ),
    ).not.toThrow();
    expect(() =>
      assertSeparateDb(
        "/tmp/feed.sqlite",
        "/tmp/paper.sqlite",
        "/tmp/live.sqlite",
        "/tmp/paper.sqlite",
      ),
    ).toThrow(PaperSafetyError);
    expect(() => assertSeparateDb("/tmp/same.sqlite", "/tmp/same.sqlite")).toThrow(PaperSafetyError);
  });

  test("assertExecMode refuses implicit or ambiguous start", () => {
    expect(() => assertExecMode({})).toThrow(ExecSafetyError);
    expect(() => assertExecMode({ EXEC_MODE: "" })).toThrow(ExecSafetyError);
    expect(() => assertExecMode({ EXEC_MODE: "off" })).toThrow(/EXEC_MODE/);
    expect(() => assertExecMode({ EXEC_MODE: "mainnet" })).toThrow(/EXEC_MAINNET_CONFIRM/);
    expect(assertExecMode({ EXEC_MODE: "testnet" })).toBe("testnet");
    expect(assertExecMode({ EXEC_MODE: "mainnet", EXEC_MAINNET_CONFIRM: "1" })).toBe("mainnet");
  });
});
