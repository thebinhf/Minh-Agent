import type { KnobDef, KnobValue } from "./registry";

/**
 * A config layer. Lookup is knob-aware so file layers key on the dotted
 * config path while env layers key on the override variable name.
 */
export type ConfigLayer = {
  name: string;
  get: (knob: KnobDef) => string | undefined;
};

export type KnobDiagnostic = {
  key: string;
  env: string;
  layer: string;
  raw: string;
  reason: string;
};

export type ResolvedKnob = {
  key: string;
  env: string;
  value: KnobValue;
  raw: string;
  source: string;
};

export type KnobResolution = {
  byKey: Record<string, ResolvedKnob>;
  diagnostics: KnobDiagnostic[];
};

/** Registry defaults as the lowest layer. */
export function defaultLayer(): ConfigLayer {
  return {
    name: "default",
    get: (knob) => (knob.default === undefined ? undefined : stringifyKnobValue(knob.default)),
  };
}

export function stringifyKnobValue(value: KnobValue): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

type Coerced =
  | { ok: true; value: KnobValue }
  | { ok: true; unset: true }
  | { ok: false; reason: string };

function coerce(knob: KnobDef, raw: string): Coerced {
  if (raw === "") {
    return knob.emptyMeansEmpty ? { ok: true, value: [] } : { ok: true, unset: true };
  }
  switch (knob.type) {
    case "int": {
      const n = Number(raw);
      if (!Number.isInteger(n) || !Number.isFinite(n)) {
        return { ok: false, reason: "expected an integer" };
      }
      return range(knob, n);
    }
    case "num": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: "expected a number" };
      return range(knob, n);
    }
    case "bool": {
      if (raw === "1" || raw === "true") return { ok: true, value: true };
      if (raw === "0" || raw === "false") return { ok: true, value: false };
      return { ok: false, reason: "expected 1/0/true/false" };
    }
    case "enum": {
      const choices = knob.choices ?? [];
      return choices.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, reason: `expected one of: ${choices.join(", ")}` };
    }
    case "csv": {
      const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
      return items.length ? { ok: true, value: items } : { ok: true, unset: true };
    }
    case "str":
      return { ok: true, value: raw };
  }
}

function range(knob: KnobDef, n: number): Coerced {
  if (knob.min !== undefined && n < knob.min) {
    return { ok: false, reason: `must be >= ${knob.min}` };
  }
  if (knob.max !== undefined && n > knob.max) {
    return { ok: false, reason: `must be <= ${knob.max}` };
  }
  return { ok: true, value: n };
}

/**
 * Resolve every knob across layers (highest precedence last). Invalid values
 * never fall through silently — they are reported and stop that knob's scan,
 * so an operator typo fails loudly instead of losing to a lower layer.
 */
export function resolveKnobs(defs: readonly KnobDef[], layers: readonly ConfigLayer[]): KnobResolution {
  const byKey: Record<string, ResolvedKnob> = {};
  const diagnostics: KnobDiagnostic[] = [];
  const ordered = [...layers].reverse();
  for (const knob of defs) {
    let matched: ResolvedKnob | null = null;
    for (const layer of ordered) {
      const raw = layer.get(knob);
      if (raw === undefined) continue;
      const parsed = coerce(knob, raw);
      if (!parsed.ok) {
        diagnostics.push({ key: knob.key, env: knob.env, layer: layer.name, raw, reason: parsed.reason });
        break;
      }
      if ("unset" in parsed) continue;
      matched = { key: knob.key, env: knob.env, value: parsed.value, raw, source: layer.name };
      break;
    }
    if (!matched && knob.fallbackKey && byKey[knob.fallbackKey]) {
      const from = byKey[knob.fallbackKey];
      matched = { key: knob.key, env: knob.env, value: from.value, raw: from.raw, source: "derived" };
    }
    if (matched) {
      byKey[knob.key] = matched;
    } else if (!diagnostics.some((d) => d.key === knob.key)) {
      diagnostics.push({
        key: knob.key,
        env: knob.env,
        layer: "-",
        raw: "",
        reason: "unresolved — no layer provides a value and the knob has no default",
      });
    }
  }
  return { byKey, diagnostics };
}

/** Minimal dotenv parsing: comments, blanks, `export ` prefix, matching quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Real env vars only — the ones a fresh boot would still honor over a new
 * .env. Keys whose process value equals the boot .env value are treated as
 * .env-sourced (Bun merges .env into process.env for keys the real
 * environment did not set).
 */
export function pickRealEnv(
  env: Record<string, string | undefined>,
  bootDotenv: Record<string, string>,
): Record<string, string> {
  const real: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (bootDotenv[key] !== undefined && bootDotenv[key] === value) continue;
    real[key] = value;
  }
  return real;
}

/** Flatten a config object to dotted string paths (arrays join with commas). */
export function flattenConfig(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (value == null || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item == null) continue;
    if (Array.isArray(item)) {
      out[path] = item.map(String).join(",");
    } else if (typeof item === "object") {
      Object.assign(out, flattenConfig(item, path));
    } else if (typeof item === "boolean") {
      out[path] = item ? "true" : "false";
    } else {
      out[path] = String(item);
    }
  }
  return out;
}
