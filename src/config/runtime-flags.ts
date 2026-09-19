/**
 * Fail-fast validation for PAPER_* / AGENT_* / BYBIT_* / LIVE_* / MAP_* runtime flags.
 * Every flag below is read ad-hoc via `process.env` across feed/agent/paper/live.
 * Invalid values used to fall through silently to a default (e.g. PAPER_ARM_MAX=abc → 2,
 * PAPER_TA_FIB=armed → off), turning an operator typo into a silent strategy change.
 * Call `assertValidRuntimeEnv()` once at process boot (index / live / paper / exec).
 * Unset means "default" and is always valid. Unknown vars are ignored.
 */

const ON_OFF = new Set([
  "AGENT_MAP",
  "AGENT_QUANT",
  "MAP_ACCEPT",
  "MAP_CLOSE",
  "BYBIT_OI",
  "BYBIT_FUNDING",
  "BYBIT_FLOW",
  "BYBIT_LIQ",
  "BYBIT_LIQ_MODEL",
  "BYBIT_RELAY",
  "BYBIT_GAP_FILL",
  "BYBIT_GAP_HEAL",
  "PAPER_PROXIMITY_ARM",
  "PAPER_CONFIRM_15",
  "PAPER_ZONE_SCORE",
  "PAPER_SLIPPAGE",
  "LIVE_SHADOW",
]);

function isOnOff(raw: string): boolean {
  return raw === "0" || raw === "1";
}

function isPosInt(raw: string, allowZero = false): boolean {
  if (!/^\d+$/.test(raw)) return false;
  const n = Number(raw);
  return Number.isSafeInteger(n) && (allowZero ? n >= 0 : n >= 1);
}

function isPosNum(raw: string, allowZero = false): boolean {
  if (raw === "") return false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return false;
  return allowZero ? n >= 0 : n > 0;
}

function isHttpUrl(raw: string): boolean {
  return /^https?:\/\/\S+$/.test(raw);
}

const SETUP_ALIASES = new Set([
  "sd", "supply_demand", "supply-demand",
  "breakout", "breakouts", "bo",
  "reversal", "rv",
]);

export function validateRuntimeEnv(env: Record<string, string | undefined> = process.env): string[] {
  const errors: string[] = [];
  const get = (name: string): string | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    return raw.trim();
  };

  for (const name of ON_OFF) {
    const raw = get(name);
    if (raw !== undefined && !isOnOff(raw)) {
      errors.push(`${name}=${raw}: expected "0" or "1" (unset = default on)`);
    }
  }

  const chop = get("AGENT_BIAS_CHOP");
  if (chop !== undefined && !["deny", "off", "0", "proximal"].includes(chop.toLowerCase())) {
    errors.push(`AGENT_BIAS_CHOP=${chop}: expected deny|off|0|proximal`);
  }

  const allocate = get("PAPER_MAP_ALLOCATE");
  if (allocate !== undefined && !["feed", "rank", "off", "0"].includes(allocate.toLowerCase())) {
    errors.push(`PAPER_MAP_ALLOCATE=${allocate}: expected feed|rank (unset = feed)`);
  }

  const fib = get("PAPER_TA_FIB");
  if (fib !== undefined && !["off", "0", "arm", "1"].includes(fib.toLowerCase())) {
    errors.push(`PAPER_TA_FIB=${fib}: expected arm|1|off|0`);
  }
  const osc = get("AGENT_TA_OSC");
  if (osc !== undefined && !["off", "0", "accept", "1"].includes(osc.toLowerCase())) {
    errors.push(`AGENT_TA_OSC=${osc}: expected accept|1|off|0`);
  }
  for (const name of ["PAPER_TA_VOL", "PAPER_TA_SHOCK", "PAPER_TA_REV"] as const) {
    const raw = get(name);
    if (raw !== undefined && !["off", "0", "arm", "1"].includes(raw.toLowerCase())) {
      errors.push(`${name}=${raw}: expected arm|1|off|0`);
    }
  }

  const setups = get("PAPER_SETUPS");
  if (setups !== undefined && setups !== "0") {
    const tokens = setups.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) {
      errors.push(`PAPER_SETUPS=${setups}: empty list resolves to sd-only; use "0" explicitly`);
    } else {
      for (const token of tokens) {
        if (!SETUP_ALIASES.has(token)) errors.push(`PAPER_SETUPS=${setups}: unknown setup "${token}"`);
      }
    }
  }

  const skip = get("PAPER_MAP_SKIP");
  if (skip !== undefined && skip !== "0") {
    for (const token of skip.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)) {
      if (!/^[A-Z0-9]+USDT$/.test(token)) errors.push(`PAPER_MAP_SKIP=${skip}: "${token}" is not a *USDT symbol`);
    }
  }

  const tape = get("BYBIT_TAPE_SYMBOLS");
  if (tape !== undefined && tape !== "0" && tape.toLowerCase() !== "watchlist" && tape !== "*") {
    for (const token of tape.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)) {
      if (!/^[A-Z0-9]+USDT$/.test(token) && token !== "*" && token.toLowerCase() !== "watchlist") {
        errors.push(`BYBIT_TAPE_SYMBOLS=${tape}: "${token}" is not watchlist|*|0|*USDT list`);
      }
    }
  }

  const observe = get("PAPER_OBSERVE");
  if (observe !== undefined && !["0", "1", "on", "off"].includes(observe.toLowerCase())) {
    errors.push(`PAPER_OBSERVE=${observe}: expected 1|on|0|off`);
  }

  const armMax = get("PAPER_ARM_MAX");
  if (armMax !== undefined && !isPosInt(armMax, true)) {
    errors.push(`PAPER_ARM_MAX=${armMax}: expected integer >= 0 (0 = unlimited)`);
  }

  const scoreMin = get("PAPER_FAMILY_SCORE_MIN");
  if (scoreMin !== undefined && (!isPosNum(scoreMin, true) || Number(scoreMin) > 1)) {
    errors.push(`PAPER_FAMILY_SCORE_MIN=${scoreMin}: expected number 0..1`);
  }
  const floorTrades = get("PAPER_FAMILY_FLOOR_MIN_TRADES");
  if (floorTrades !== undefined && !isPosInt(floorTrades)) {
    errors.push(`PAPER_FAMILY_FLOOR_MIN_TRADES=${floorTrades}: expected integer >= 1`);
  }
  for (const name of ["PAPER_ZONE_SCORE_RR", "AGENT_ZONE_FRESH", "MINH_DECISION_LOG"] as const) {
    const raw = get(name);
    if (raw !== undefined && raw !== "0" && raw !== "1") {
      errors.push(`${name}=${raw}: expected "1" or "0" (unset = off)`);
    }
  }
  const impulse = get("AGENT_ZONE_IMPULSE_MIN");
  if (impulse !== undefined && !isPosNum(impulse)) {
    errors.push(`AGENT_ZONE_IMPULSE_MIN=${impulse}: expected float > 0 (unset = off)`);
  }
  const be = get("PAPER_BE_R");
  if (be !== undefined && !isPosNum(be)) {
    errors.push(`PAPER_BE_R=${be}: expected float > 0 (unset = off)`);
  }
  const zoneMin = get("ZONE_MIN_RR");
  if (zoneMin !== undefined && !isPosNum(zoneMin)) {
    errors.push(`ZONE_MIN_RR=${zoneMin}: expected float > 0 (unset = 2, the RR floor detection draws cards at)`);
  }
  for (const name of ["BYBIT_OI_EXTREME", "BYBIT_FLOW_EXTREME", "BYBIT_FUNDING_EXTREME", "BYBIT_LIQ_BAND"] as const) {
    const raw = get(name);
    if (raw !== undefined && !isPosNum(raw)) {
      errors.push(`${name}=${raw}: expected number > 0`);
    }
  }
  for (const name of ["BYBIT_RELAY_TICKER_MS", "BYBIT_RELAY_LIQ_MS"] as const) {
    const raw = get(name);
    if (raw !== undefined && !isPosInt(raw, true)) {
      errors.push(`${name}=${raw}: expected integer >= 0`);
    }
  }
  for (const name of ["PAPER_STALE_MS", "PAPER_TICK_MS", "PAPER_HTTP_PORT", "BYBIT_HTTP_PORT", "LIVE_HTTP_PORT", "EXEC_HTTP_PORT"] as const) {
    const raw = get(name);
    if (raw !== undefined && !isPosInt(raw, name.endsWith("PORT") ? false : true)) {
      errors.push(`${name}=${raw}: expected integer port/ms`);
    }
  }
  const webhook = get("MAP_CLOSE_WEBHOOK");
  if (webhook !== undefined && !isHttpUrl(webhook)) {
    errors.push(`MAP_CLOSE_WEBHOOK=${webhook}: expected http(s):// URL`);
  }
  const shadowUrl = get("LIVE_SHADOW_URL");
  if (shadowUrl !== undefined && !isHttpUrl(shadowUrl)) {
    errors.push(`LIVE_SHADOW_URL=${shadowUrl}: expected http(s):// URL`);
  }

  return errors;
}

export function assertValidRuntimeEnv(env: Record<string, string | undefined> = process.env): void {
  const errors = validateRuntimeEnv(env);
  if (errors.length > 0) {
    throw new Error(`Invalid runtime env:\n- ${errors.join("\n- ")}`);
  }
}
