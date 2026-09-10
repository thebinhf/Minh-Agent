export const RELAY_NOTE = "local push — not Bybit";
export const RELAY_MAX_CLIENTS = 16;
export const RELAY_MAX_TOPICS = 32;
export const DEFAULT_RELAY_TICKER_MS = 1_000;

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
