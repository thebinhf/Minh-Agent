import { Dec } from "./decimal";
import type { PaperEngine } from "./engine";
import { PaperReject } from "./errors";
import { parseZoneId } from "./gates";
import { parseSide } from "./risk";
import type { AlertView, LimitRequest, OrderView } from "./types";

const DAY_MS = 86_400_000;

export function utcDayWindow(day: string | undefined, now = Date.now()): {
  day: string;
  fromTs: number;
  toTs: number;
} {
  const iso = day?.trim() || new Date(now).toISOString().slice(0, 10);
  const fromTs = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isFinite(fromTs)) {
    throw new PaperReject("invalid_day", "day", { day: iso });
  }
  return { day: iso, fromTs, toTs: fromTs + DAY_MS };
}

export function paperStatus(engine: PaperEngine, eventLimit = 10) {
  return {
    mode: "paper" as const,
    account: engine.account(),
    pending: engine.orders("pending"),
    open: engine.positions("open"),
    alerts: engine.alerts("armed"),
    events: engine.events(eventLimit),
  };
}

/** Open desk for brief-pack. Local paper store only — no Bybit.
 *  `source` is `http://127.0.0.1:43181` (daemon) or `sqlite:<path>` (CLI). */
export function paperDesk(engine: PaperEngine, source: string | null = null) {
  return {
    source,
    positions: engine.positions("open"),
    pendingOrders: engine.orders("pending"),
    armedAlerts: engine.alerts("armed"),
    zones: engine.zones("accepted").map((row) => row.card),
  };
}

export function paperDay(engine: PaperEngine, day?: string, now = Date.now()) {
  const window = utcDayWindow(day, now);
  const events = engine.eventsBetween(window.fromTs, window.toTs);
  const counts = { filled: 0, invalidated: 0, closed: 0, sl: 0, tp: 0, liq: 0, manual: 0 };
  let realized = Dec.zero();
  for (const event of events) {
    if (event.kind === "order.filled") counts.filled += 1;
    if (event.kind === "order.invalidated") counts.invalidated += 1;
    if (event.kind !== "position.closed") continue;
    counts.closed += 1;
    const reason = String(event.payload.closeReason ?? "");
    if (reason === "sl") counts.sl += 1;
    else if (reason === "tp") counts.tp += 1;
    else if (reason === "liq") counts.liq += 1;
    else if (reason === "manual") counts.manual += 1;
    if (event.payload.realizedPnl) realized = realized.add(Dec.from(String(event.payload.realizedPnl)));
  }
  return {
    mode: "paper" as const,
    day: window.day,
    fromTs: window.fromTs,
    toTs: window.toTs,
    filled: counts.filled,
    invalidated: counts.invalidated,
    closed: counts.closed,
    closeReasons: { sl: counts.sl, tp: counts.tp, liq: counts.liq, manual: counts.manual },
    realizedPnl: realized.toText(),
    events,
  };
}

export type ArmRequest = LimitRequest & {
  alertPrice?: string;
  alertOp?: string;
};

export async function paperArm(
  engine: PaperEngine,
  request: ArmRequest,
  now = Date.now(),
): Promise<{
  mode: "paper";
  arm: true;
  order: OrderView;
  alert: AlertView | null;
  alertSkipped?: string;
}> {
  const placed = await engine.limit(request, now);
  const side = parseSide(request.side);
  const op = request.alertOp ?? (side === "long" ? "below" : "above");
  const price = request.alertPrice ?? request.limitPrice;
  try {
    const alert = await engine.setAlert({
      symbol: request.symbol,
      op,
      price,
      note: request.note,
      zoneId: request.zoneId,
    }, now);
    return { mode: "paper", arm: true, order: placed.order, alert: alert.alert };
  } catch (error) {
    if (error instanceof PaperReject && error.error === "duplicate_alert") {
      const snapped = String(error.extra.price ?? price);
      const symbol = request.symbol.trim().toUpperCase();
      const alertId = typeof error.extra.alertId === "number" ? error.extra.alertId : null;
      const existing = (alertId != null
        ? engine.alerts("armed").find((row) => row.id === alertId)
        : engine.alerts("armed").find((row) => (
          row.symbol === symbol && row.op === op && row.price === snapped
        ))) ?? null;
      const zoneId = parseZoneId(request.zoneId);
      const alert = existing && zoneId
        ? engine.attachAlertZoneId(existing.id, zoneId)
        : existing;
      return {
        mode: "paper",
        arm: true,
        order: placed.order,
        alert,
        alertSkipped: "duplicate_alert",
      };
    }
    throw error;
  }
}
