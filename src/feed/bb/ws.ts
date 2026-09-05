import type { TrackerDb } from "./db";
import { applyOrderbook, mergeTicker } from "./merge";
import { chunkTopics, isPongStale, withRetries } from "./recovery";
import { fillKlineGaps } from "./rest";
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

type PendingSubscribe = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export function startTracker(config: TrackerConfig, store: TrackerDb): TrackerRuntime {
  const topics = buildTopics(config);
  const recovery = config.recovery;
  const tickers = new Map<string, TickerState>();
  const books = new Map<string, OrderBookState>();
  const lastTickerSnap = new Map<string, number>();
  const lastBookSnap = new Map<string, number>();
  const pendingSubscribe = new Map<string, PendingSubscribe>();

  let stopped = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = config.reconnect.initialDelayMs;
  let connectTs = 0;
  let lastPongTs = 0;
  let fillAbort: AbortController | null = null;
  let subscribeSeq = 0;

  store.setMeta("endpoint", config.endpoint);
  store.setMeta("symbols", JSON.stringify(config.symbols));
  store.setMeta("kline_intervals", JSON.stringify(config.klineIntervals));
  store.setMeta("topics", JSON.stringify(topics));
  store.setMeta("started_at", String(Date.now()));
  store.setHealth({ endpoint: config.endpoint, subscribedTopics: topics.length, connected: 0 });

  const rejectPending = (error: Error) => {
    for (const pending of pendingSubscribe.values()) pending.reject(error);
    pendingSubscribe.clear();
  };

  const connect = () => {
    if (stopped) return;
    console.log(`[bybit-ws] connecting ${config.endpoint} (${topics.length} topics)`);
    const socket = new WebSocket(config.endpoint);
    ws = socket;

    socket.addEventListener("open", () => {
      void onOpen(socket);
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
      stopWatchdog();
      fillAbort?.abort();
      fillAbort = null;
      rejectPending(new Error("websocket closed"));
      store.setHealth({ connected: 0, disconnectTs: Date.now() });
      if (stopped) return;
      store.bumpReconnect();
      const wait = delay;
      delay = Math.min(delay * 2, config.reconnect.maxDelayMs);
      console.log(`[bybit-ws] disconnected; reconnect in ${wait}ms`);
      reconnectTimer = setTimeout(connect, wait);
    });
  };

  const onOpen = async (socket: WebSocket) => {
    delay = config.reconnect.initialDelayMs;
    connectTs = Date.now();
    lastPongTs = 0;
    books.clear();
    store.setHealth({
      connected: 1,
      connectTs,
      lastError: "",
      endpoint: config.endpoint,
      subscribedTopics: topics.length,
    });
    socket.send(JSON.stringify({ op: "ping", req_id: `ping-${Date.now()}` }));
    store.setHealth({ lastPingTs: Date.now() });
    startPing(socket);
    startWatchdog(socket);

    try {
      await subscribeAll(socket);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bybit-ws] subscribe failed: ${message}`);
      store.setHealth({ lastError: message });
      if (socket.readyState === WebSocket.OPEN) socket.close();
      return;
    }

    console.log(`[bybit-ws] subscribed ${topics.length} topics`);
    fillAbort?.abort();
    fillAbort = new AbortController();
    const signal = fillAbort.signal;
    void fillKlineGaps(config, store, { signal })
      .then((result) => {
        if (signal.aborted) return;
        store.setMeta("last_gap_fill", JSON.stringify({ ...result, ts: Date.now() }));
        console.log(
          `[minh:bb] gap-fill series=${result.series} candles=${result.candles} errors=${result.errors}`,
        );
      })
      .catch((error) => {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[minh:bb] gap-fill failed: ${message}`);
      });
  };

  const subscribeAll = async (socket: WebSocket) => {
    const chunks = chunkTopics(topics, recovery.subscribeChunkSize);
    for (const chunk of chunks) {
      await withRetries(
        async () => {
          if (socket.readyState !== WebSocket.OPEN) {
            throw new Error("websocket closed");
          }
          await subscribeChunk(socket, chunk);
        },
        {
          retries: recovery.subscribeRetries,
          delayMs: recovery.subscribeRetryDelayMs,
        },
      );
    }
  };

  const subscribeChunk = (socket: WebSocket, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const reqId = `sub-${++subscribeSeq}`;
      const timer = setTimeout(() => {
        pendingSubscribe.delete(reqId);
        reject(new Error(`subscribe ack timeout (${args.length} topics)`));
      }, recovery.subscribeAckTimeoutMs);
      pendingSubscribe.set(reqId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ op: "subscribe", args, req_id: reqId }));
    });

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

  const startWatchdog = (socket: WebSocket) => {
    stopWatchdog();
    watchdogTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (
        !isPongStale({
          now: Date.now(),
          connectTs,
          lastPongTs,
          graceMs: recovery.watchdogGraceMs,
          staleMs: recovery.pongStaleMs,
        })
      ) {
        return;
      }
      console.error("[bybit-ws] pong stale; forcing reconnect");
      store.setHealth({ lastError: "pong stale" });
      socket.close();
    }, recovery.watchdogIntervalMs);
  };

  const stopWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const handleSubscribeAck = (msg: BybitPushMessage) => {
    const reqId = msg.req_id;
    const pending = reqId ? pendingSubscribe.get(reqId) : undefined;
    if (msg.success === false) {
      const err = msg.ret_msg ?? "subscribe failed";
      console.error(`[bybit-ws] subscribe failed: ${err}`);
      store.setHealth({ lastError: err });
      if (pending) {
        pendingSubscribe.delete(reqId!);
        pending.reject(new Error(err));
      }
      return;
    }
    if (pending && reqId) {
      pendingSubscribe.delete(reqId);
      pending.resolve();
      return;
    }
    if (msg.success === true && pendingSubscribe.size === 1) {
      const [[id, only]] = pendingSubscribe.entries();
      pendingSubscribe.delete(id);
      only.resolve();
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

    if (msg.ret_msg === "pong" || msg.op === "pong" || (msg.op === "ping" && msg.success === true)) {
      lastPongTs = now;
      store.setHealth({ lastPongTs: now });
      return;
    }

    if (msg.op === "ping") {
      socket.send(JSON.stringify({ op: "pong", req_id: msg.req_id }));
      return;
    }

    if (msg.op === "subscribe") {
      handleSubscribeAck(msg);
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
      if (!next?.ready) return;
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
      fillAbort?.abort();
      stopPing();
      stopWatchdog();
      rejectPending(new Error("tracker stopped"));
      ws?.close();
      store.setHealth({ connected: 0, disconnectTs: Date.now() });
    },
  };
}
