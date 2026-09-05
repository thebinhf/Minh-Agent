import type { TrackerDb } from "./db";
import { applyOrderbook, mergeTicker } from "./merge";
import { buildTopics, parseTopic } from "./topics";
import type {
  BybitKline,
  BybitOrderbookData,
  BybitPushMessage,
  BybitTickerData,
  OrderBookState,
  TickerState,
  TrackerConfig,
} from "./types";

export type TrackerRuntime = {
  stop: () => void;
};

export function startTracker(config: TrackerConfig, store: TrackerDb): TrackerRuntime {
  const topics = buildTopics(config);
  const tickers = new Map<string, TickerState>();
  const books = new Map<string, OrderBookState>();
  const lastTickerSnap = new Map<string, number>();
  const lastBookSnap = new Map<string, number>();

  let stopped = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = config.reconnect.initialDelayMs;

  store.setMeta("endpoint", config.endpoint);
  store.setMeta("symbols", JSON.stringify(config.symbols));
  store.setMeta("kline_intervals", JSON.stringify(config.klineIntervals));
  store.setMeta("topics", JSON.stringify(topics));
  store.setMeta("started_at", String(Date.now()));
  store.setHealth({ endpoint: config.endpoint, subscribedTopics: topics.length, connected: 0 });

  const connect = () => {
    if (stopped) return;
    console.log(`[bybit-ws] connecting ${config.endpoint} (${topics.length} topics)`);
    const socket = new WebSocket(config.endpoint);
    ws = socket;

    socket.addEventListener("open", () => {
      delay = config.reconnect.initialDelayMs;
      store.setHealth({
        connected: 1,
        connectTs: Date.now(),
        lastError: "",
        endpoint: config.endpoint,
        subscribedTopics: topics.length,
      });
      socket.send(JSON.stringify({ op: "subscribe", args: topics }));
      startPing(socket);
      console.log(`[bybit-ws] subscribed ${topics.length} topics`);
    });

    socket.addEventListener("message", (event) => {
      handleMessage(String(event.data), socket);
    });

    socket.addEventListener("error", (event) => {
      const message = event instanceof ErrorEvent ? event.message : "websocket error";
      console.error(`[bybit-ws] ${message}`);
      store.setHealth({ lastError: message });
    });

    socket.addEventListener("close", () => {
      stopPing();
      store.setHealth({ connected: 0, disconnectTs: Date.now() });
      if (stopped) return;
      store.bumpReconnect();
      const wait = delay;
      delay = Math.min(delay * 2, config.reconnect.maxDelayMs);
      console.log(`[bybit-ws] disconnected; reconnect in ${wait}ms`);
      reconnectTimer = setTimeout(connect, wait);
    });
  };

  const startPing = (socket: WebSocket) => {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ op: "ping", req_id: `ping-${Date.now()}` }));
      store.setHealth({ lastPingTs: Date.now() });
    }, config.pingIntervalMs);
  };

  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const handleMessage = (raw: string, socket: WebSocket) => {
    let msg: BybitPushMessage;
    try {
      msg = JSON.parse(raw) as BybitPushMessage;
    } catch {
      return;
    }

    const now = Date.now();
    store.setHealth({ lastMessageTs: now });

    // Public linear heartbeat reply is { op: "ping", ret_msg: "pong", success: true }.
    if (msg.ret_msg === "pong" || msg.op === "pong" || (msg.op === "ping" && msg.success === true)) {
      store.setHealth({ lastPongTs: now });
      return;
    }

    if (msg.op === "ping") {
      socket.send(JSON.stringify({ op: "pong", req_id: msg.req_id }));
      return;
    }

    if (msg.op === "subscribe") {
      if (msg.success === false) {
        const err = msg.ret_msg ?? "subscribe failed";
        console.error(`[bybit-ws] subscribe failed: ${err}`);
        store.setHealth({ lastError: err });
      }
      return;
    }

    if (!msg.topic) return;
    const parsed = parseTopic(msg.topic);

    if (parsed.kind === "ticker") {
      const data = msg.data as BybitTickerData;
      if (!data || typeof data !== "object") return;
      const type = msg.type === "delta" ? "delta" : "snapshot";
      const next = mergeTicker(tickers.get(parsed.symbol) ?? null, type, data, { cs: msg.cs, ts: msg.ts });
      tickers.set(parsed.symbol, next);
      const due = now - (lastTickerSnap.get(parsed.symbol) ?? 0) >= config.snapshot.tickerEveryMs;
      const snap = type === "snapshot" || due;
      if (snap) lastTickerSnap.set(parsed.symbol, now);
      store.saveTicker(next, now, snap);
      return;
    }

    if (parsed.kind === "orderbook") {
      const data = msg.data as BybitOrderbookData;
      if (!data || typeof data !== "object") return;
      const type = msg.type === "delta" ? "delta" : "snapshot";
      const next = applyOrderbook(books.get(parsed.symbol) ?? null, type, data);
      books.set(parsed.symbol, next);
      const due = now - (lastBookSnap.get(parsed.symbol) ?? 0) >= config.snapshot.orderbookEveryMs;
      const snap = type === "snapshot" || data.u === 1 || due;
      if (snap) lastBookSnap.set(parsed.symbol, now);
      store.saveOrderbook(next, parsed.depth, type, now, msg.ts, snap);
      return;
    }

    if (parsed.kind === "kline") {
      const candles = Array.isArray(msg.data) ? (msg.data as BybitKline[]) : [];
      for (const candle of candles) {
        store.saveKline(parsed.symbol, candle, now);
      }
    }
  };

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPing();
      ws?.close();
      store.setHealth({ connected: 0, disconnectTs: Date.now() });
    },
  };
}
