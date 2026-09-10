import { defaultLiqBucket, type LiqPrint } from "./liq";

export const RELAY_NOTE = "local push — not Bybit";
export const RELAY_MAX_CLIENTS = 16;
export const RELAY_MAX_TOPICS = 32;
export const DEFAULT_RELAY_TICKER_MS = 1_000;
export const DEFAULT_RELAY_LIQ_MS = 1_000;
export const RELAY_LIQ_FLUSH_COUNT = 8;
export const RELAY_LIQ_MAX_BINS = 32;

export type RelayPush = {
  topic: string;
  ts: number;
  data: unknown;
};

type RelayWs = {
  send: (data: string) => void;
  close: () => void;
  data: { topics: Set<string> };
};

export function relayEnabled(): boolean {
  return process.env.BYBIT_RELAY !== "0";
}

export function relayTickerMs(): number {
  const raw = process.env.BYBIT_RELAY_TICKER_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RELAY_TICKER_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RELAY_TICKER_MS;
}

export function relayLiqMs(): number {
  const raw = process.env.BYBIT_RELAY_LIQ_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RELAY_LIQ_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RELAY_LIQ_MS;
}

export type LiqRelayBin = {
  price: string;
  longSize: string;
  shortSize: string;
  count: number;
};

export type LiqRelayPayload = {
  bins: LiqRelayBin[];
  longSize: string;
  shortSize: string;
  count: number;
};

/** Merge prints into price bins. Relay payload — not the SQLite ledger. */
export function aggregateLiqPrints(prints: LiqPrint[], bucket: number): LiqRelayPayload {
  const bins = new Map<string, { long: number; short: number; count: number }>();
  let longSize = 0;
  let shortSize = 0;
  const step = bucket > 0 ? bucket : 10;
  for (const print of prints) {
    const n = Number(print.size);
    if (!Number.isFinite(n) || n <= 0) continue;
    const raw = Number(print.price);
    const key = Number.isFinite(raw)
      ? String(Math.round(raw / step) * step)
      : print.price;
    const cell = bins.get(key) ?? { long: 0, short: 0, count: 0 };
    if (print.side === "Buy") {
      cell.long += n;
      longSize += n;
    } else {
      cell.short += n;
      shortSize += n;
    }
    cell.count += 1;
    bins.set(key, cell);
  }
  const sorted = [...bins.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
  return {
    bins: sorted.slice(0, RELAY_LIQ_MAX_BINS).map(([price, cell]) => ({
      price,
      longSize: String(cell.long),
      shortSize: String(cell.short),
      count: cell.count,
    })),
    longSize: String(longSize),
    shortSize: String(shortSize),
    count: prints.length,
  };
}

export function createLiqRelayBatch(opts: {
  onFlush: (symbol: string, payload: LiqRelayPayload, ts: number) => void;
  everyMs?: () => number;
  flushCount?: number;
  bucketFor?: (symbol: string) => number;
}) {
  const pending = new Map<string, { prints: LiqPrint[]; timer: ReturnType<typeof setTimeout> | null }>();
  const flushCount = opts.flushCount ?? RELAY_LIQ_FLUSH_COUNT;

  function flush(symbol: string, ts = Date.now()) {
    const row = pending.get(symbol);
    if (!row || row.prints.length === 0) return;
    if (row.timer) clearTimeout(row.timer);
    pending.delete(symbol);
    const bucket = opts.bucketFor?.(symbol) ?? defaultLiqBucket(Number(row.prints[0]?.price));
    opts.onFlush(symbol, aggregateLiqPrints(row.prints, bucket), ts);
  }

  function push(symbol: string, prints: LiqPrint[], now = Date.now()) {
    if (prints.length === 0) return;
    let row = pending.get(symbol);
    if (!row) {
      row = { prints: [], timer: null };
      pending.set(symbol, row);
    }
    row.prints.push(...prints);
    const every = opts.everyMs?.() ?? DEFAULT_RELAY_LIQ_MS;
    if (every <= 0 || row.prints.length >= flushCount) {
      flush(symbol, now);
      return;
    }
    if (!row.timer) {
      row.timer = setTimeout(() => flush(symbol), every);
    }
  }

  function flushAll(now = Date.now()) {
    for (const symbol of [...pending.keys()]) flush(symbol, now);
  }

  return { push, flush, flushAll };
}

/** ticker.BTCUSDT | ticker.* | liq.BTCUSDT | kline.15.BTCUSDT | kline.240.* */
export function parseRelayArg(raw: string): string | null {
  const token = raw.trim();
  const ticker = /^ticker(\.\*|\.[A-Za-z0-9]+)$/i.exec(token);
  if (ticker) {
    const tail = ticker[1]!;
    return tail === ".*" ? "ticker.*" : `ticker.${tail.slice(1).toUpperCase()}`;
  }
  const liq = /^liq(\.\*|\.[A-Za-z0-9]+)$/i.exec(token);
  if (liq) {
    const tail = liq[1]!;
    return tail === ".*" ? "liq.*" : `liq.${tail.slice(1).toUpperCase()}`;
  }
  const kline = /^kline\.(5|15|60|240|D|W|M)(\.\*|\.[A-Za-z0-9]+)$/i.exec(token);
  if (kline) {
    const rawIv = kline[1]!;
    const interval = /^[DWM]$/i.test(rawIv) ? rawIv.toUpperCase() : rawIv;
    const tail = kline[2]!;
    return tail === ".*" ? `kline.${interval}.*` : `kline.${interval}.${tail.slice(1).toUpperCase()}`;
  }
  return null;
}

export function topicMatches(sub: string, topic: string): boolean {
  if (sub === topic) return true;
  if (!sub.endsWith(".*")) return false;
  const prefix = sub.slice(0, -1);
  return topic.startsWith(prefix);
}

export function thinTicker(fields: Record<string, string | undefined>): Record<string, string | null> {
  return {
    lastPrice: fields.lastPrice ?? null,
    markPrice: fields.markPrice ?? null,
    fundingRate: fields.fundingRate ?? null,
    openInterest: fields.openInterest ?? null,
    openInterestValue: fields.openInterestValue ?? null,
  };
}

export function createRelay() {
  const clients = new Set<RelayWs>();

  function send(ws: RelayWs, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      detach(ws);
    }
  }

  function attach(ws: RelayWs): boolean {
    if (!relayEnabled()) {
      ws.close();
      return false;
    }
    if (clients.size >= RELAY_MAX_CLIENTS) {
      send(ws, { success: false, op: "subscribe", ret_msg: "clients" });
      ws.close();
      return false;
    }
    clients.add(ws);
    return true;
  }

  function detach(ws: RelayWs) {
    clients.delete(ws);
  }

  function onMessage(ws: RelayWs, raw: unknown) {
    const text = typeof raw === "string"
      ? raw
      : ArrayBuffer.isView(raw)
        ? new TextDecoder().decode(raw)
        : raw instanceof ArrayBuffer
          ? new TextDecoder().decode(raw)
          : String(raw);
    let msg: { op?: unknown; args?: unknown };
    try {
      msg = JSON.parse(text) as { op?: unknown; args?: unknown };
    } catch {
      send(ws, { success: false, ret_msg: "json" });
      return;
    }
    if (msg.op === "ping") {
      send(ws, { op: "pong" });
      return;
    }
    if (msg.op !== "subscribe" && msg.op !== "unsubscribe") {
      send(ws, { success: false, ret_msg: "op" });
      return;
    }
    const args = Array.isArray(msg.args) ? msg.args.map((item) => String(item)) : [];
    const parsed: string[] = [];
    for (const arg of args) {
      const topic = parseRelayArg(arg);
      if (!topic) {
        send(ws, { success: false, op: msg.op, ret_msg: "topic", args: [arg] });
        return;
      }
      parsed.push(topic);
    }
    if (msg.op === "subscribe") {
      for (const topic of parsed) {
        if (ws.data.topics.size >= RELAY_MAX_TOPICS) break;
        ws.data.topics.add(topic);
      }
    } else {
      for (const topic of parsed) ws.data.topics.delete(topic);
    }
    send(ws, { success: true, op: msg.op, args: parsed });
  }

  function publish(msg: RelayPush) {
    if (!relayEnabled() || clients.size === 0) return;
    const body = JSON.stringify({ topic: msg.topic, ts: msg.ts, data: msg.data, meta: { note: RELAY_NOTE } });
    for (const ws of clients) {
      let hit = false;
      for (const sub of ws.data.topics) {
        if (topicMatches(sub, msg.topic)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      try {
        ws.send(body);
      } catch {
        detach(ws);
      }
    }
  }

  return {
    attach,
    detach,
    onMessage,
    publish,
    get size() {
      return clients.size;
    },
  };
}

export type RelayHub = ReturnType<typeof createRelay>;
