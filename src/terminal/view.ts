/**
 * Trading Terminal (T3): a read-only view of the mesh.
 *
 * Lock (`docs/ROADMAP.md`): the terminal is a viewer, never a command source.
 * This module holds no engine, no store, no fetch — it turns already-parsed
 * JSON into a model and then into text, so it can be tested without a daemon.
 *
 * Honesty rule carried from the feed: a source that did not answer is `null`
 * and renders as `down`; a tape field that is missing renders as `—`/`0 ok`,
 * never as a zero that looks like coverage.
 */

export type FeedSource = {
  ok: boolean;
  connected: boolean;
  klineLagOk: boolean;
  lastMessageAgeMs: number | null;
};

export type GateSource = {
  tradingAllowed: boolean;
  reasons: string[];
};

export type MapSource = {
  quality: "ok" | "missing";
  interval: string | null;
  ts: number | null;
  symbols: number;
};

export type TapeField = { ok: number; missing: number };

export type TapeSource = {
  quality: "ok" | "missing";
  symbols: number;
  oi: TapeField;
  funding: TapeField;
  flow: TapeField;
  liq: TapeField;
};

export type ShadowSource = {
  quality: "ok" | "missing" | "down";
  accepted: number;
  wouldArm: number;
};

export type OpenRow = {
  id: number;
  symbol: string;
  side: string;
  qty: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  riskQuote: string;
  unrealizedPnl: string;
  markPrice: string | null;
  liqPrice: string | null;
  zoneId: string | null;
};

export type PendingRow = {
  id: number;
  symbol: string;
  side: string;
  limitPrice: string;
  stopLoss: string;
  takeProfit: string;
  qty: string;
  rr: string;
  zoneId: string | null;
};

export type ZoneRow = {
  zoneId: string;
  symbol: string;
  tf: string;
  side: string;
  setup: string;
  proximal: number | null;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  freshness: string;
  expiresTs: number | null;
};

export type AlertRow = {
  id: number;
  symbol: string;
  op: string;
  price: string;
  zoneId: string | null;
};

export type EventRow = {
  id: number;
  kind: string;
  symbol: string;
  ts: number;
  brief: string;
};

export type DeskSource = {
  name: string;
  equity: string | null;
  cash: string | null;
  startingCash: string | null;
  mutations: string;
  observer: boolean;
  standing: { accepted: number; pending: number; open: number; alerts: number };
  open: OpenRow[];
  pending: PendingRow[];
  alerts: AlertRow[];
  zones: ZoneRow[];
  recent: EventRow[];
};

export type TerminalModel = {
  asof: number;
  feed: FeedSource | null;
  gates: GateSource | null;
  map: MapSource | null;
  tape: TapeSource | null;
  shadow: ShadowSource | null;
  desk: DeskSource | null;
};

const MISSING = "—";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown, fallback = MISSING): string {
  if (typeof value === "string" && value !== "") return value;
  const n = num(value);
  return n === null ? fallback : String(value);
}

function bool(value: unknown): boolean {
  return value === true || value === 1;
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function tapeField(raw: unknown): TapeField {
  if (!isRecord(raw)) return { ok: 0, missing: 0 };
  return { ok: num(raw.ok) ?? 0, missing: num(raw.missing) ?? 0 };
}

/** `null` everywhere means "this source never answered", not "nothing happened". */
export function buildTerminalModel(raw: unknown, asof = Date.now()): TerminalModel {
  if (!isRecord(raw)) {
    return { asof, feed: null, gates: null, map: null, tape: null, shadow: null, desk: null };
  }
  const feed = isRecord(raw.feed) ? raw.feed : null;
  const gates = isRecord(raw.gates) ? raw.gates : null;
  const map = isRecord(raw.map) ? raw.map : null;
  const tape = isRecord(raw.tape) ? raw.tape : null;
  const shadow = isRecord(raw.shadow) ? raw.shadow : null;
  const paper = isRecord(raw.paper) ? raw.paper : null;
  // Feed /observe embeds `{ paper: null, note: "paper starting" }` before the
  // desk boots; a payload with neither `standing` nor `event` has no desk yet.
  const desk = paper && (isRecord(paper.standing) || Array.isArray(paper.event)) ? paper : null;
  const event = desk && isRecord(desk.event) ? desk.event : null;
  const standing = desk && isRecord(desk.standing) ? desk.standing : null;
  const account = desk && isRecord(desk.account) ? desk.account : null;
  return {
    asof,
    feed: feed
      ? {
        ok: bool(feed.ok),
        connected: bool(feed.connected),
        klineLagOk: bool(feed.klineLagOk),
        lastMessageAgeMs: num(feed.lastMessageAgeMs),
      }
      : null,
    gates: gates
      ? { tradingAllowed: bool(gates.tradingAllowed), reasons: Array.isArray(gates.reasons) ? gates.reasons.map(String) : [] }
      : null,
    map: map
      ? {
        quality: map.quality === "ok" ? "ok" : "missing",
        interval: text(map.interval, MISSING) === MISSING ? null : text(map.interval),
        ts: num(map.ts),
        symbols: count(map.symbols),
      }
      : null,
    tape: tape
      ? {
        quality: tape.quality === "ok" ? "ok" : "missing",
        symbols: num(tape.symbols) ?? 0,
        oi: tapeField(tape.oi),
        funding: tapeField(tape.funding),
        flow: tapeField(tape.flow),
        liq: tapeField(tape.liq),
      }
      : null,
    shadow: shadow
      ? {
        quality: shadow.quality === "ok" || shadow.quality === "missing" ? shadow.quality : "down",
        accepted: num(shadow.accepted) ?? 0,
        wouldArm: num(shadow.wouldArm) ?? 0,
      }
      : null,
    desk: desk
      ? {
        name: text(account?.name, "paper"),
        equity: text(account?.equity, MISSING) === MISSING ? null : text(account?.equity),
        cash: text(account?.cash, MISSING) === MISSING ? null : text(account?.cash),
        startingCash: text(account?.startingCash, MISSING) === MISSING ? null : text(account?.startingCash),
        mutations: text(desk.mutations, "open"),
        observer: bool(desk.observer),
        standing: {
          accepted: num(standing?.accepted) ?? 0,
          pending: num(standing?.pending) ?? 0,
          open: num(standing?.open) ?? 0,
          alerts: num(standing?.alerts) ?? 0,
        },
        open: records(event?.open).map((row) => ({
          id: num(row.id) ?? 0,
          symbol: text(row.symbol),
          side: text(row.side),
          qty: text(row.qty),
          entryPrice: text(row.entryPrice),
          stopLoss: text(row.stopLoss),
          takeProfit: text(row.takeProfit),
          riskQuote: text(row.riskQuote),
          unrealizedPnl: text(row.unrealizedPnl, "0"),
          markPrice: text(row.markPrice, MISSING) === MISSING ? null : text(row.markPrice),
          liqPrice: text(row.liqPrice, MISSING) === MISSING ? null : text(row.liqPrice),
          zoneId: text(row.zoneId, MISSING) === MISSING ? null : text(row.zoneId),
        })),
        pending: records(event?.pending).map((row) => ({
          id: num(row.id) ?? 0,
          symbol: text(row.symbol),
          side: text(row.side),
          limitPrice: text(row.limitPrice),
          stopLoss: text(row.stopLoss),
          takeProfit: text(row.takeProfit),
          qty: text(row.qty),
          rr: text(row.rr),
          zoneId: text(row.zoneId, MISSING) === MISSING ? null : text(row.zoneId),
        })),
        alerts: records(event?.alerts).map((row) => ({
          id: num(row.id) ?? 0,
          symbol: text(row.symbol),
          op: text(row.op),
          price: text(row.price),
          zoneId: text(row.zoneId, MISSING) === MISSING ? null : text(row.zoneId),
        })),
        zones: records(event?.zones).map((row) => ({
          zoneId: text(row.zoneId),
          symbol: text(row.symbol),
          tf: text(row.tf),
          side: text(row.side),
          setup: text(row.setup, "sd"),
          proximal: num(row.proximal),
          entry: num(row.entry),
          sl: num(row.sl),
          tp: num(row.tp),
          rr: num(row.rr),
          freshness: text(row.freshness, "unknown"),
          expiresTs: num(row.expiresTs ?? row.baseEndTs),
        })),
        recent: records(desk.recent).map((row) => ({
          id: num(row.id) ?? 0,
          kind: text(row.kind),
          symbol: text(row.symbol, "-"),
          ts: num(row.ts) ?? 0,
          brief: eventBrief(row),
        })),
      }
      : null,
  };
}

/** Event payloads differ per kind; show the one field an operator scans for. */
function eventBrief(row: Record<string, unknown>): string {
  const payload = isRecord(row.payload) ? row.payload : {};
  for (const key of ["closeReason", "cancelCode", "action", "limitPrice", "price", "zoneId", "side"]) {
    const value = text(payload[key], MISSING);
    if (value !== MISSING) return `${key}=${value}`;
  }
  return "";
}

function age(ms: number | null): string {
  if (ms === null || ms < 0) return MISSING;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function utc(ts: number | null): string {
  if (ts === null) return MISSING;
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function sign(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

/** PnL as a multiple of the original risk, so R is comparable across symbols. */
function rMultiple(unrealized: string, riskQuote: string): string {
  const pnl = num(unrealized);
  const risk = num(riskQuote);
  if (pnl === null || risk === null || risk === 0) return MISSING;
  return `${sign(pnl / risk)}R`;
}

function equityDelta(equity: string | null, starting: string | null): string {
  const now = num(equity);
  const start = num(starting);
  if (now === null || start === null || start === 0) return MISSING;
  return `${sign(((now - start) / start) * 100)}%`;
}

function tapeCell(field: TapeField, symbols: number): string {
  if (symbols === 0) return MISSING;
  const missing = field.missing;
  return `${field.ok}/${symbols} ok${missing > 0 ? ` ${missing} miss` : ""}`;
}

export function renderTerminal(model: TerminalModel): string {
  const lines: string[] = [];
  const d = model.desk;
  const f = model.feed;
  const g = model.gates;
  lines.push(
    `minh · paper simulation only — no keys, no orders` +
    `   ${utc(model.asof)}Z`,
  );
  lines.push(
    `FEED   ${f ? `${f.ok ? "ok" : "DOWN"} ws=${f.connected ? "up" : "down"} lag=${f.klineLagOk ? "ok" : "STALE"} last-msg=${age(f.lastMessageAgeMs === null ? null : f.lastMessageAgeMs)}` : "down (no /observe)"}` +
    `   GATES ${g ? (g.tradingAllowed ? "allow" : `deny${g.reasons.length ? ` (${g.reasons.join(",")})` : ""}`) : MISSING}`,
  );
  const m = model.map;
  lines.push(
    `MAP    ${m ? (m.quality === "ok"
      ? `${m.symbols} symbols${m.interval ? ` ${m.interval}` : ""} @ ${utc(m.ts)} (${age(m.ts === null ? null : model.asof - m.ts)} ago)`
      : m.quality) : MISSING}` +
    `   MUTATIONS ${d ? d.mutations : MISSING}`,
  );
  const t = model.tape;
  lines.push(
    `TAPE   ${t ? `${t.quality} over ${t.symbols} symbols` : MISSING}` +
    `   oi ${t ? tapeCell(t.oi, t.symbols) : MISSING}` +
    ` funding ${t ? tapeCell(t.funding, t.symbols) : MISSING}` +
    ` flow ${t ? tapeCell(t.flow, t.symbols) : MISSING}` +
    ` liq ${t ? tapeCell(t.liq, t.symbols) : MISSING}`,
  );
  lines.push(
    `PAPER  ${d ? `${d.name} equity=${d.equity ?? MISSING} (${equityDelta(d.equity, d.startingCash)}) cash=${d.cash ?? MISSING} · accepted=${d.standing.accepted} pending=${d.standing.pending} open=${d.standing.open} alerts=${d.standing.alerts}` : "down (no paper desk in /observe)"}`,
  );
  const s = model.shadow;
  lines.push(
    `SHADOW ${s ? `${s.quality}${s.quality === "ok" ? ` accepted=${s.accepted} would-arm=${s.wouldArm}` : ""}` : MISSING}`,
  );
  if (d) {
    for (const row of d.open) {
      lines.push(
        `  OPEN   ${row.symbol} ${row.side} qty=${row.qty} entry=${row.entryPrice} sl=${row.stopLoss} tp=${row.takeProfit}` +
        ` u=${row.unrealizedPnl} (${rMultiple(row.unrealizedPnl, row.riskQuote)}) mark=${row.markPrice ?? MISSING} liq=${row.liqPrice ?? MISSING}${row.zoneId ? ` zone=${row.zoneId}` : ""}`,
      );
    }
    for (const row of d.pending) {
      lines.push(
        `  REST   ${row.symbol} ${row.side} limit=${row.limitPrice} sl=${row.stopLoss} tp=${row.takeProfit} rr=${row.rr}${row.zoneId ? ` zone=${row.zoneId}` : ""}`,
      );
    }
    for (const row of d.alerts) {
      lines.push(`  ALERT  ${row.symbol} ${row.op} ${row.price}${row.zoneId ? ` zone=${row.zoneId}` : ""}`);
    }
    for (const row of d.zones) {
      const band = row.proximal !== null && row.sl !== null ? `${row.proximal}..${row.sl}` : MISSING;
      lines.push(
        `  ZONE   ${row.symbol} ${row.tf} ${row.side}/${row.setup} band=${band} entry=${row.entry ?? MISSING} rr=${row.rr ?? MISSING}` +
        ` ${row.freshness}${row.expiresTs !== null ? ` exp=${utc(row.expiresTs)}Z` : ""} ${row.zoneId}`,
      );
    }
    lines.push(d.recent.length === 0 ? "EVENTS none yet" : "EVENTS");
    for (const row of d.recent.slice(0, 8)) {
      lines.push(`  ${utc(row.ts).slice(5)} ${row.kind.padEnd(17)} ${row.symbol.padEnd(10)} ${row.brief}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
