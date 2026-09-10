import type { PaperEngine } from "./engine";

/** EVENT is OCO + tick. Agent does not poll /confirm. */
export const EVENT_NOTE = "EVENT is OCO/tick — do not poll /confirm";

export function paperEvent(engine: PaperEngine, now = Date.now()) {
  return {
    mode: "event" as const,
    note: EVENT_NOTE,
    pending: engine.orders("pending"),
    alerts: engine.alerts("armed"),
    open: engine.positions("open"),
    zones: engine.zones("accepted", now).map((row) => row.card),
  };
}
