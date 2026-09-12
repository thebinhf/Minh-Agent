import type { ZoneSetup, ZoneSide } from "../zones/card";
import { armGateApplies } from "./strategy";

/**
 * P7 TA gates. Overlay pack stays off the MAP path.
 * Missing tape is never a veto. Default off.
 * Gates are setup-aware (`src/agent/strategy.ts`): fib/rev are S/D only;
 * shock is S/D + breakout; vol applies to every setup; reversal cards skip rev.
 *
 * PAPER_TA_FIB=arm — ARM wait unless last is nearest 0.5 / 0.618.
 * AGENT_TA_OSC=accept — MAP deny when oscillator opposes the zone.
 * PAPER_TA_VOL=arm — ARM wait on kline volume climax (rel ≥ 2).
 * PAPER_TA_SHOCK=arm — ARM wait on 4H impulse / vol_spike.
 * PAPER_TA_REV=arm — ARM wait unless 15m reversal agrees with the zone.
 */

export type TaFibMode = "off" | "arm";
export type TaOscMode = "off" | "accept";
export type TaVolMode = "off" | "arm";
export type TaShockMode = "off" | "arm";
export type TaRevMode = "off" | "arm";

export type TaOscTape = {
  rsi14: number | null;
  divergence: string | null;
};

export type TaArmTape = {
  fibNearest: number | null;
  volumeRel: number | null;
  reversal: string | null;
  shock: string | null;
};

export function emptyTaArmTape(): TaArmTape {
  return { fibNearest: null, volumeRel: null, reversal: null, shock: null };
}

export function emptyTaOscTape(): TaOscTape {
  return { rsi14: null, divergence: null };
}

function token(raw: string | undefined): string {
  return raw?.trim().toLowerCase() ?? "";
}

export function taFibMode(): TaFibMode {
  const raw = token(process.env.PAPER_TA_FIB);
  if (raw === "arm" || raw === "1") return "arm";
  return "off";
}

export function taOscMode(): TaOscMode {
  const raw = token(process.env.AGENT_TA_OSC);
  if (raw === "accept" || raw === "1") return "accept";
  return "off";
}

export function taVolMode(): TaVolMode {
  const raw = token(process.env.PAPER_TA_VOL);
  if (raw === "arm" || raw === "1") return "arm";
  return "off";
}

export function taShockMode(): TaShockMode {
  const raw = token(process.env.PAPER_TA_SHOCK);
  if (raw === "arm" || raw === "1") return "arm";
  return "off";
}

export function taRevMode(): TaRevMode {
  const raw = token(process.env.PAPER_TA_REV);
  if (raw === "arm" || raw === "1") return "arm";
  return "off";
}

export function taArmFlagsOn(): boolean {
  return taFibMode() === "arm"
    || taVolMode() === "arm"
    || taShockMode() === "arm"
    || taRevMode() === "arm";
}

const FIB_ARM = new Set([0.5, 0.618]);

/** Missing nearest is not a wait. Breakout / reversal skip fib (S/D confluence only). */
export function fibArmOk(nearest: number | null | undefined, setup?: ZoneSetup | null): boolean {
  if (taFibMode() !== "arm") return true;
  if (!armGateApplies("fib", setup)) return true;
  if (nearest == null || !Number.isFinite(nearest)) return true;
  return FIB_ARM.has(nearest);
}

export function oscAcceptVeto(side: ZoneSide, osc: TaOscTape | null | undefined): "ta_osc" | null {
  if (taOscMode() !== "accept") return null;
  if (!osc) return null;
  switch (side) {
    case "demand":
      if (osc.rsi14 != null && osc.rsi14 >= 70) return "ta_osc";
      if (osc.divergence === "bearish_div") return "ta_osc";
      return null;
    case "supply":
      if (osc.rsi14 != null && osc.rsi14 <= 30) return "ta_osc";
      if (osc.divergence === "bullish_div") return "ta_osc";
      return null;
    default: {
      const _exhaustive: never = side;
      return _exhaustive;
    }
  }
}

/** Climax (rel ≥ 2) waits. Null rel is not a wait. */
export function volArmOk(rel: number | null | undefined, setup?: ZoneSetup | null): boolean {
  if (taVolMode() !== "arm") return true;
  if (!armGateApplies("vol", setup)) return true;
  if (rel == null || !Number.isFinite(rel)) return true;
  return rel < 2;
}

/** Impulse / vol_spike wait (chase). Missing / quiet / range_expand pass. Reversal cards skip. */
export function shockArmOk(reading: string | null | undefined, setup?: ZoneSetup | null): boolean {
  if (taShockMode() !== "arm") return true;
  if (!armGateApplies("shock", setup)) return true;
  if (reading == null || reading === "") return true;
  return reading !== "impulse" && reading !== "vol_spike";
}

/** Missing reversal is not a wait. Computed non-agree waits. Reversal setup already is the event. */
export function revArmOk(side: ZoneSide, reading: string | null | undefined, setup?: ZoneSetup | null): boolean {
  if (taRevMode() !== "arm") return true;
  if (!armGateApplies("rev", setup)) return true;
  if (reading == null || reading === "") return true;
  switch (side) {
    case "demand":
      return reading === "bull_reversal";
    case "supply":
      return reading === "bear_reversal";
    default: {
      const _exhaustive: never = side;
      return _exhaustive;
    }
  }
}

export function taArmWait(
  side: ZoneSide,
  tape: TaArmTape | null | undefined,
  setup?: ZoneSetup | null,
): boolean {
  if (!taArmFlagsOn()) return false;
  if (!tape) return false;
  if (!fibArmOk(tape.fibNearest, setup)) return true;
  if (!volArmOk(tape.volumeRel, setup)) return true;
  if (!shockArmOk(tape.shock, setup)) return true;
  if (!revArmOk(side, tape.reversal, setup)) return true;
  return false;
}
