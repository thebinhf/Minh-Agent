/**
 * Operational map: how a method enters MAP / ARM / EVENT.
 * Overlay pack (`GET /ta`) stays signal:false. This module does not import it.
 *
 * setup       — emits a zone-card (src/zones/setups)
 * accept_gate — MAP deny when the flag is on (P7)
 * arm_gate    — ARM wait when the flag is on (P7), setup-aware
 * confirm     — ICT label after HTF + zone already passed
 * context     — read-only tape, no gate
 * never       — discretionary; never policy
 * event_manage — open-position stop management (P9). Not a signal.
 *
 * EVENT knobs default off. One flag / one 180d A/B before systemd on.
 * They never invent tape. They never arm from GET /ta.
 */
import type { ZoneSetup } from "../zones/card";

export const METHOD_USES = [
  "setup",
  "accept_gate",
  "arm_gate",
  "confirm",
  "context",
  "never",
  "event_manage",
] as const;
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
  break_even: "event_manage",
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

/**
 * P9 EVENT management. `be` moves SL to entry after favorable MFE ≥ PAPER_BE_R.
 * Applies to every setup family — it is trade management, not a detector.
 */
export const EVENT_MANAGES = ["be"] as const;
export type EventManage = (typeof EVENT_MANAGES)[number];

const EVENT_MANAGE_BY_SETUP: Record<ZoneSetup, readonly EventManage[]> = {
  sd: ["be"],
  breakout: ["be"],
  reversal: ["be"],
};

export function eventManagesForSetup(setup: ZoneSetup | null | undefined): readonly EventManage[] {
  return EVENT_MANAGE_BY_SETUP[setup ?? "sd"] ?? EVENT_MANAGE_BY_SETUP.sd;
}

export function eventManageApplies(manage: EventManage, setup: ZoneSetup | null | undefined): boolean {
  return eventManagesForSetup(setup).includes(manage);
}

/**
 * PAPER_BE_R=<float>: after favorable excursion ≥ N× original risk, move SL
 * to entry (`position.managed` / `be`). Unset / 0 / invalid = off.
 * Lab (skip-HYPE 180d): 39% of SLs ran ≥0.5R then died; every TP had already
 * cleared 0.5R, so BE does not clip winners. A/B before on.
 */
export function eventBeR(): number | null {
  const raw = process.env.PAPER_BE_R?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
