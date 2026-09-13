import { resolve } from "node:path";
import {
  FEED_KNOBS,
  type KnobDef,
  type KnobEffect,
  type KnobScope,
  type KnobType,
  type KnobValue,
} from "../../config/registry";
import {
  defaultLayer,
  flattenConfig,
  parseDotenv,
  pickRealEnv,
  resolveKnobs,
  type ConfigLayer,
  type KnobResolution,
} from "../../config/resolve";
import type { RecoveryConfig, TrackerConfig } from "./types";

/** Documented Japan public REST host. Verified to serve /v5/market/kline from a US cloud VM. */
export const DEFAULT_REST_FALLBACKS = ["https://api.manepa.jp"];

export const DEFAULT_RECOVERY: RecoveryConfig = {
  pongStaleMs: 60_000,
  watchdogIntervalMs: 10_000,
  watchdogGraceMs: 30_000,
  subscribeChunkSize: 10,
  subscribeRetries: 3,
  subscribeRetryDelayMs: 1_000,
  subscribeAckTimeoutMs: 5_000,
  restRetries: 3,
  restRetryDelayMs: 400,
  restTimeoutMs: 10_000,
  gapFill: true,
  klineLagMs: 180_000,
};

const DEFAULT_CONFIG_PATH = resolve(import.meta.dir, "config.json");

export type FeedConfigBoot = {
  configPath: string;
  dotenvPath: string;
  /** .env parsed at load time — separates real env vars from .env-sourced ones in the fresh resolution. */
  bootDotenv: Record<string, string>;
  config: TrackerConfig;
  /** Assembled knob values keyed by knob key — what this process runs with. */
  values: Record<string, KnobValue>;
  /** Layer that provided each knob: "default" | "file" | "env" | "derived". */
  sources: Record<string, string>;
};

/**
 * Resolve the feed boot config through the knob registry.
 * Layers: registry default < config.json < env (process.env, which Bun has
 * already merged .env into, real env winning).
 */
export async function loadFeedBoot(
  configPath = process.env.BYBIT_CONFIG ?? DEFAULT_CONFIG_PATH,
  dotenvPath = resolve(process.cwd(), ".env"),
): Promise<FeedConfigBoot> {
  const bootDotenv = await Bun.file(dotenvPath)
    .text()
    .then(parseDotenv)
    .catch(() => ({}) as Record<string, string>);
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(`Missing config file: ${configPath}`);
  }
  const base = (await file.json()) as TrackerConfig;
  const resolution = resolveKnobs(FEED_KNOBS, bootLayers(base));
  throwOnDiagnostics(resolution, configPath);
  const config = assembleTracker(base, resolution.byKey);
  const values = configValues(config);
  const sources = Object.fromEntries(
    Object.entries(resolution.byKey).map(([key, row]) => [key, row.source]),
  );
  return { configPath, dotenvPath, bootDotenv, config, values, sources };
}

export async function loadConfig(
  configPath = process.env.BYBIT_CONFIG ?? DEFAULT_CONFIG_PATH,
): Promise<TrackerConfig> {
  return (await loadFeedBoot(configPath)).config;
}

function bootLayers(base: TrackerConfig): ConfigLayer[] {
  const file = flattenConfig(base);
  return [
    defaultLayer(),
    { name: "file", get: (knob) => file[knob.key] },
    { name: "env", get: (knob) => process.env[knob.env] },
  ];
}

function throwOnDiagnostics(resolution: KnobResolution, configPath: string): void {
  if (!resolution.diagnostics.length) return;
  const lines = resolution.diagnostics.map((d) => {
    const where = d.layer === "-" ? d.key : `${d.env} [${d.layer}]`;
    const raw = d.raw === "" ? "(empty)" : d.raw;
    return `  ${where} = ${raw}: ${d.reason}`;
  });
  throw new Error(`Invalid config (${configPath}):\n${lines.join("\n")}`);
}

function assembleTracker(base: TrackerConfig, resolved: KnobResolution["byKey"]): TrackerConfig {
  const v = (key: string): KnobValue => {
    const row = resolved[key];
    if (!row) throw new Error(`config knob ${key} unresolved`);
    return row.value;
  };
  const symbols = v("symbols") as string[];
  const watch = new Set(symbols);
  const bookWanted = v("orderbook.symbols") as string[];
  return {
    ...base,
    endpoint: v("endpoint") as string,
    restEndpoint: v("restEndpoint") as string,
    restFallbacks: v("restFallbacks") as string[],
    httpHost: v("httpHost") as string,
    httpPort: v("httpPort") as number,
    dbPath: resolve(process.cwd(), v("dbPath") as string),
    symbols,
    klineIntervals: v("klineIntervals") as string[],
    orderbook: {
      depth: v("orderbook.depth") as number,
      symbols: bookWanted.filter((symbol) => watch.has(symbol)),
    },
    pingIntervalMs: v("pingIntervalMs") as number,
    retention: {
      ...base.retention,
      klinesDays: v("retention.klinesDays") as number,
      liquidationsHours: v("retention.liquidationsHours") as number,
      flowHours: v("retention.flowHours") as number,
    },
    recovery: {
      ...DEFAULT_RECOVERY,
      ...base.recovery,
      pongStaleMs: v("recovery.pongStaleMs") as number,
      klineLagMs: v("recovery.klineLagMs") as number,
      gapFill: v("recovery.gapFill") as boolean,
    },
  };
}

/** Boot knob values straight off the assembled config — the process truth. */
function configValues(config: TrackerConfig): Record<string, KnobValue> {
  return {
    endpoint: config.endpoint,
    restEndpoint: config.restEndpoint,
    restFallbacks: [...config.restFallbacks],
    httpHost: config.httpHost,
    httpPort: config.httpPort,
    dbPath: config.dbPath,
    symbols: [...config.symbols],
    klineIntervals: [...config.klineIntervals],
    "orderbook.depth": config.orderbook.depth,
    "orderbook.symbols": [...config.orderbook.symbols],
    pingIntervalMs: config.pingIntervalMs,
    "retention.klinesDays": config.retention.klinesDays,
    "retention.liquidationsHours": config.retention.liquidationsHours,
    "retention.flowHours": config.retention.flowHours,
    "recovery.pongStaleMs": config.recovery.pongStaleMs,
    "recovery.klineLagMs": config.recovery.klineLagMs,
    "recovery.gapFill": config.recovery.gapFill,
  };
}

/** Fresh knob values from a resolution — same assembly rules as the boot path. */
function freshValues(resolved: KnobResolution["byKey"]): Record<string, KnobValue> {
  const out: Record<string, KnobValue> = {};
  for (const [key, row] of Object.entries(resolved)) {
    out[key] = key === "dbPath" ? resolve(process.cwd(), String(row.value)) : row.value;
  }
  return out;
}

export type ConfigKnobSnapshot = {
  key: string;
  env: string;
  type: KnobType;
  scope: KnobScope;
  effect: KnobEffect;
  desc: string;
  unit?: string;
  min?: number;
  max?: number;
  choices?: string[];
  /** What the running process booted with. */
  value: KnobValue;
  source: string;
  /** What a fresh resolution would produce, when it differs from `value`. */
  pending: { value: KnobValue; source: string } | { error: string } | null;
};

export type ConfigSnapshot = {
  ok: true;
  ts: number;
  configPath: string;
  layers: string[];
  note: string;
  pending: Record<KnobEffect, string[]>;
  knobs: ConfigKnobSnapshot[];
};

const SNAPSHOT_NOTE =
  "value = what the running process booted with; pending = what a fresh resolution " +
  "(config.json and .env as they sit on disk now, plus real env vars) would produce. " +
  "effect says when a pending change applies — restart for every knob registered today.";

/**
 * Registry + boot truth + pending diff. The dotenv layer re-reads .env from
 * disk so an edited-but-unrestarted override shows up as pending; real env
 * vars (boot value differing from the boot .env) still win over it, matching
 * Bun's fresh-boot precedence.
 */
export async function buildConfigSnapshot(
  boot: FeedConfigBoot,
  defs: readonly KnobDef[] = FEED_KNOBS,
  now = Date.now(),
): Promise<ConfigSnapshot> {
  const [fileNowRaw, dotenvText] = await Promise.all([
    Bun.file(boot.configPath).json().catch(() => null),
    Bun.file(boot.dotenvPath).text().catch(() => ""),
  ]);
  const fileNow = fileNowRaw ? flattenConfig(fileNowRaw) : {};
  const dotenvNow = parseDotenv(dotenvText);
  const realEnv = pickRealEnv(process.env, boot.bootDotenv);
  const fresh = resolveKnobs(defs, [
    defaultLayer(),
    { name: "file", get: (knob) => fileNow[knob.key] },
    { name: "dotenv", get: (knob) => dotenvNow[knob.env] },
    { name: "env", get: (knob) => realEnv[knob.env] },
  ]);
  const errors = new Map(fresh.diagnostics.map((d) => [d.key, d]));
  const freshByKey = freshValues(fresh.byKey);
  const pending: Record<KnobEffect, string[]> = { hot: [], restart: [], "next-run": [] };
  const knobs = defs.map((def) => {
    const row: ConfigKnobSnapshot = {
      key: def.key,
      env: def.env,
      type: def.type,
      scope: def.scope,
      effect: def.effect,
      desc: def.desc,
      ...(def.unit === undefined ? {} : { unit: def.unit }),
      ...(def.min === undefined ? {} : { min: def.min }),
      ...(def.max === undefined ? {} : { max: def.max }),
      ...(def.choices === undefined ? {} : { choices: [...def.choices] }),
      value: boot.values[def.key],
      source: boot.sources[def.key] ?? "boot",
      pending: null,
    };
    const failed = errors.get(def.key);
    if (failed) {
      const raw = failed.raw === "" ? "(empty)" : failed.raw;
      row.pending = failed.layer === "-"
        ? { error: `fresh resolution unresolved: ${failed.reason}` }
        : { error: `fresh resolution invalid [${failed.layer}] ${raw}: ${failed.reason}` };
    } else if (JSON.stringify(freshByKey[def.key]) !== JSON.stringify(row.value)) {
      row.pending = { value: freshByKey[def.key], source: fresh.byKey[def.key].source };
      pending[def.effect].push(def.key);
    }
    return row;
  });
  return {
    ok: true,
    ts: now,
    configPath: boot.configPath,
    layers: ["default", "file", "dotenv", "env"],
    note: SNAPSHOT_NOTE,
    pending,
    knobs,
  };
}
