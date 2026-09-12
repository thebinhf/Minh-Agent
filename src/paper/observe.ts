import type { PaperEngine } from "./engine";
import { paperEvent } from "./event";

/**
 * Host observer lock. PAPER_OBSERVE=1 (systemd) refuses POST mutations.
 * Unset = tests/CLI may still POST. MAP/ARM/EVENT still run in-process.
 */
export const OBSERVE_NOTE = "observer — MAP/ARM/EVENT autonomous; GET only";

export function observerMode(): boolean {
  const raw = process.env.PAPER_OBSERVE?.trim().toLowerCase();
  return raw === "1" || raw === "on";
}

export function paperObserve(engine: PaperEngine, now = Date.now()) {
  const account = engine.account();
  const event = paperEvent(engine, now);
  return {
    mode: "observe" as const,
    observer: true,
    mutations: observerMode() ? "blocked" : "open",
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
