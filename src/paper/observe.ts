import type { PaperEngine } from "./engine";
import { paperEvent } from "./event";

/**
 * Host observer lock. PAPER_OBSERVE=1 keeps the autonomous loop (MAP/ARM/EVENT)
 * the only thing that can *enter* the market, but an operator must always be able
 * to get out: closing a position, cancelling a resting order or an armed alert,
 * and re-marking are allowed by hand. CLI and HTTP read these lists from here so
 * the two surfaces cannot drift apart.
 */
export const OBSERVE_NOTE = "observer — MAP/ARM/EVENT autonomous; exits by hand, entries not";

/** Commands that still refuse to run under the lock. */
export const OBSERVER_BLOCKED_COMMANDS = [
  "open", "limit", "arm", "zone-accept", "zone-reject", "alert-set",
] as const;

/** Mutations the lock allows, because they only ever reduce exposure. */
export const OBSERVER_EXIT_COMMANDS = ["close", "cancel", "alert-cancel", "mark"] as const;

/** POST bodies are route-shaped, not command-shaped, so the HTTP side matches paths. */
const OBSERVER_EXIT_ROUTES: readonly RegExp[] = [
  /^\/paper\/positions\/\d+\/close$/,
  /^\/paper\/orders\/\d+\/cancel$/,
  /^\/paper\/alerts\/\d+\/cancel$/,
  /^\/paper\/mark$/,
];

export function observerMode(): boolean {
  const raw = process.env.PAPER_OBSERVE?.trim().toLowerCase();
  return raw === "1" || raw === "on";
}

export function observerBlocksCommand(name: string): boolean {
  return observerMode() && (OBSERVER_BLOCKED_COMMANDS as readonly string[]).includes(name);
}

export function observerAllowsMutation(path: string): boolean {
  return OBSERVER_EXIT_ROUTES.some((route) => route.test(path));
}

export function paperObserve(engine: PaperEngine, now = Date.now()) {
  const account = engine.account();
  const event = paperEvent(engine, now);
  return {
    mode: "observe" as const,
    observer: true,
    mutations: observerMode() ? "exits-only" : "open",
    ts: now,
    note: OBSERVE_NOTE,
    account: {
      name: account.name,
      equity: account.equity,
      cash: account.cash,
      startingCash: account.startingCash,
    },
    standing: {
      accepted: event.zones.length,
      pending: event.pending.length,
      open: event.open.length,
      alerts: event.alerts.length,
    },
    event,
    recent: engine.events(20),
  };
}
