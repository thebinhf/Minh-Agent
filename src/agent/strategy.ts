/**
 * Operational map: how a method enters MAP / ARM / EVENT.
 * Overlay pack (`GET /ta`) stays signal:false. This module does not import it.
 *
 * setup     — emits a zone-card (src/zones/setups)
 * accept_gate — MAP deny when the flag is on (P7)
 * arm_gate  — ARM wait when the flag is on (P7), setup-aware
 * confirm   — ICT label after HTF + zone already passed
 * context   — read-only tape, no gate
 * never     — discretionary; never policy
 */
import type { ZoneSetup } from "../zones/card";

export const METHOD_USES = ["setup", "accept_gate", "arm_gate", "confirm", "context", "never"] as const;
export type MethodUse = (typeof METHOD_USES)[number];

export const METHOD_USE = {
  supply_demand: "setup",
  breakouts: "setup",
  reversal: "setup",
  fibonacci: "arm_gate",
  volume: "arm_gate",
  candlesticks: "arm_gate",
  oscillators: "accept_gate",
  divergence: "accept_gate",
  momentum: "context",
  support_resistance: "context",
  dynamic_sr: "context",
  trend_lines: "context",
  market_structure: "context",
  heikin_ashi: "context",
  renko: "context",
  fvg: "confirm",
  bos: "confirm",
  choch: "confirm",
  elliott: "never",
  moon_phases: "never",
  harmonic: "never",
  gann: "never",
} as const satisfies Record<string, MethodUse>;

export type MethodId = keyof typeof METHOD_USE;

/** P7 arm gates that apply to a setup family. Missing tape is still not a wait. */
export type ArmGate = "fib" | "vol" | "shock" | "rev";

const ARM_GATES_BY_SETUP: Record<ZoneSetup, readonly ArmGate[]> = {
  sd: ["fib", "vol", "shock", "rev"],
  breakout: ["vol", "shock"],
  reversal: ["vol"],
};

export function armGatesForSetup(setup: ZoneSetup | null | undefined): readonly ArmGate[] {
  return ARM_GATES_BY_SETUP[setup ?? "sd"] ?? ARM_GATES_BY_SETUP.sd;
}

export function armGateApplies(gate: ArmGate, setup: ZoneSetup | null | undefined): boolean {
  return armGatesForSetup(setup).includes(gate);
}
