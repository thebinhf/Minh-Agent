import { describe, expect, test } from "bun:test";
import { FEED_KNOBS, type KnobDef } from "../../src/config/registry";
import {
  defaultLayer,
  flattenConfig,
  parseDotenv,
  pickRealEnv,
  resolveKnobs,
  type ConfigLayer,
} from "../../src/config/resolve";

const defs: KnobDef[] = [
  { key: "a", env: "A_VAR", type: "int", scope: "feed", effect: "restart", desc: "a", min: 1, max: 10, default: 5 },
  { key: "b", env: "B_VAR", type: "bool", scope: "feed", effect: "hot", desc: "b", default: true },
  { key: "c", env: "C_VAR", type: "csv", scope: "feed", effect: "restart", desc: "c" },
  { key: "d", env: "D_VAR", type: "csv", scope: "feed", effect: "restart", desc: "d", emptyMeansEmpty: true },
  { key: "e", env: "E_VAR", type: "enum", scope: "feed", effect: "restart", desc: "e", choices: ["x", "y"] },
  { key: "f", env: "F_VAR", type: "str", scope: "feed", effect: "restart", desc: "f", fallbackKey: "a" },
  { key: "g", env: "G_VAR", type: "int", scope: "feed", effect: "restart", desc: "g" },
];

function layer(name: string, values: Record<string, string>): ConfigLayer {
  return { name, get: (knob) => values[knob.key] };
}

function envLayer(name: string, values: Record<string, string>): ConfigLayer {
  return { name, get: (knob) => values[knob.env] };
}

describe("resolveKnobs", () => {
  test("higher layers win: env over dotenv over file over default", () => {
    const stack = (file: Record<string, string>, dotenv: Record<string, string>, env: Record<string, string>) => [
      defaultLayer(),
      layer("file", file),
      envLayer("dotenv", dotenv),
      envLayer("env", env),
    ];
    expect(resolveKnobs(defs, stack({ a: "6" }, { A_VAR: "7" }, { A_VAR: "8" })).byKey.a)
      .toMatchObject({ value: 8, source: "env" });
    expect(resolveKnobs(defs, stack({ a: "6" }, { A_VAR: "7" }, {})).byKey.a)
      .toMatchObject({ value: 7, source: "dotenv" });
    expect(resolveKnobs(defs, stack({ a: "6" }, {}, {})).byKey.a)
      .toMatchObject({ value: 6, source: "file" });
    expect(resolveKnobs(defs, stack({}, {}, {})).byKey.a)
      .toMatchObject({ value: 5, source: "default" });
  });

  test("an invalid value stops the scan and is reported, not silently fallen through", () => {
    const r = resolveKnobs(defs, [defaultLayer(), layer("file", { a: "4" }), envLayer("env", { A_VAR: "abc" })]);
    expect(r.byKey.a).toBeUndefined();
    const diag = r.diagnostics.filter((d) => d.key === "a");
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ layer: "env", raw: "abc" });
  });

  test("range checks apply to int and num", () => {
    const low = resolveKnobs(defs, [defaultLayer(), envLayer("env", { A_VAR: "0" })]);
    expect(low.diagnostics.find((d) => d.key === "a")!.reason).toContain(">= 1");
    const high = resolveKnobs(defs, [defaultLayer(), envLayer("env", { A_VAR: "11" })]);
    expect(high.diagnostics.find((d) => d.key === "a")!.reason).toContain("<= 10");
  });

  test("bool is strict", () => {
    expect(resolveKnobs(defs, [defaultLayer(), envLayer("env", { B_VAR: "1" })]).byKey.b.value).toBe(true);
    expect(resolveKnobs(defs, [defaultLayer(), envLayer("env", { B_VAR: "false" })]).byKey.b.value).toBe(false);
    const junk = resolveKnobs(defs, [defaultLayer(), envLayer("env", { B_VAR: "yes" })]);
    expect(junk.diagnostics.find((d) => d.key === "b")!.reason).toContain("1/0/true/false");
  });

  test("csv trims and filters; empty means unset unless emptyMeansEmpty", () => {
    const items = resolveKnobs(defs, [defaultLayer(), envLayer("env", { C_VAR: " a , b ,, " })]);
    expect(items.byKey.c.value).toEqual(["a", "b"]);
    const unset = resolveKnobs(defs, [defaultLayer(), envLayer("env", { C_VAR: " , " })]);
    expect(unset.byKey.c).toBeUndefined();
    const diag = unset.diagnostics.find((d) => d.key === "c")!;
    expect(diag.reason).toContain("unresolved");
    const disabled = resolveKnobs(defs, [defaultLayer(), layer("file", { d: "keep" }), envLayer("env", { D_VAR: "" })]);
    expect(disabled.byKey.d.value).toEqual([]);
  });

  test("enum enforces choices", () => {
    expect(resolveKnobs(defs, [defaultLayer(), envLayer("env", { E_VAR: "x" })]).byKey.e.value).toBe("x");
    const bad = resolveKnobs(defs, [defaultLayer(), envLayer("env", { E_VAR: "z" })]);
    expect(bad.diagnostics.find((d) => d.key === "e")!.reason).toContain("x, y");
  });

  test("fallbackKey derives from another resolved knob", () => {
    const r = resolveKnobs(defs, [defaultLayer(), layer("file", { a: "3" })]);
    expect(r.byKey.f).toMatchObject({ value: 3, source: "derived" });
  });

  test("a required knob with no provider is an unresolved diagnostic", () => {
    const r = resolveKnobs(defs, [defaultLayer()]);
    expect(r.byKey.g).toBeUndefined();
    expect(r.diagnostics.some((d) => d.key === "g" && d.reason.includes("unresolved"))).toBe(true);
  });
});

describe("parseDotenv", () => {
  test("parses comments, export prefixes, quotes, and blanks", () => {
    const env = parseDotenv([
      "# comment",
      "",
      "PLAIN=1",
      "export EXPORTED=2",
      'QUOTED="hello world"',
      "SINGLE='x'",
      "NO_EQUALS_LINE",
      "EMPTY=",
    ].join("\n"));
    expect(env).toEqual({ PLAIN: "1", EXPORTED: "2", QUOTED: "hello world", SINGLE: "x", EMPTY: "" });
  });
});

describe("pickRealEnv", () => {
  test("drops .env-sourced keys, keeps real vars and changed overrides", () => {
    const real = pickRealEnv(
      { ONLY_ENV: "1", SAME: "2", CHANGED: "3", EMPTY: "" },
      { SAME: "2", CHANGED: "9", EMPTY: "" },
    );
    expect(real).toEqual({ ONLY_ENV: "1", CHANGED: "3" });
  });
});

describe("flattenConfig", () => {
  test("dotted paths, joined arrays, stringified booleans, skipped nulls", () => {
    const flat = flattenConfig({
      host: "127.0.0.1",
      port: 43180,
      flag: false,
      list: ["a", "b"],
      nested: { deep: 1, missing: null },
      gone: null,
    });
    expect(flat).toEqual({
      host: "127.0.0.1",
      port: "43180",
      flag: "false",
      list: "a,b",
      "nested.deep": "1",
    });
  });
});

describe("FEED_KNOBS registry shape", () => {
  test("keys and env names are unique", () => {
    const keys = new Set(FEED_KNOBS.map((k) => k.key));
    const envs = new Set(FEED_KNOBS.map((k) => k.env));
    expect(keys.size).toBe(FEED_KNOBS.length);
    expect(envs.size).toBe(FEED_KNOBS.length);
  });

  test("every knob is a feed boot knob with effect restart", () => {
    for (const knob of FEED_KNOBS) {
      expect(knob.scope).toBe("feed");
      expect(knob.effect).toBe("restart");
      expect(knob.desc.length).toBeGreaterThan(0);
    }
  });
});
