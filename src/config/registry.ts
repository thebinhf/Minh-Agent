/**
 * Self-describing config knobs. A knob carries the metadata an operator
 * surface (HTTP, Telegram, agent) needs to render and reason about it:
 * type, range, unit, scope, and when a change takes effect.
 *
 * Layers, lowest → highest precedence: registry default < config.json <
 * dotenv (.env) < real env vars. Empty-string overrides mean "unset".
 */

export type KnobType = "int" | "num" | "bool" | "str" | "enum" | "csv";
export type KnobEffect = "hot" | "restart" | "next-run";
export type KnobScope = "feed" | "paper" | "agent" | "live" | "global";

export type KnobValue = string | number | boolean | string[];

export type KnobDef = {
  /** Dotted config path, e.g. "retention.liquidationsHours". */
  key: string;
  /** Env override variable. */
  env: string;
  type: KnobType;
  scope: KnobScope;
  /**
   * When a resolved change takes effect. "hot" = honored by the next read,
   * "restart" = process restart, "next-run" = next one-shot run (CLI/replay).
   * Only declare what the current read sites actually honor.
   */
  effect: KnobEffect;
  desc: string;
  unit?: string;
  min?: number;
  max?: number;
  choices?: readonly string[];
  /** Last-resort value when no layer provides one. Absent = required. */
  default?: KnobValue;
  /** If still unresolved after all layers, take the resolved value of this key. */
  fallbackKey?: string;
  /** An explicitly empty override yields [] instead of "unset" (csv only). */
  emptyMeansEmpty?: boolean;
};

/**
 * Feed boot knobs — everything `loadConfig` consumes from config.json + env.
 * All are read once at boot, so every change is effect "restart".
 */
export const FEED_KNOBS: readonly KnobDef[] = [
  { key: "endpoint", env: "BYBIT_WS_ENDPOINT", type: "str", scope: "feed", effect: "restart",
    desc: "Bybit public linear WS endpoint" },
  { key: "restEndpoint", env: "BYBIT_REST_ENDPOINT", type: "str", scope: "feed", effect: "restart",
    desc: "Bybit public REST base", default: "https://api.bybit.com" },
  { key: "restFallbacks", env: "BYBIT_REST_FALLBACKS", type: "csv", scope: "feed", effect: "restart",
    desc: "Extra REST bases tried on 401/403/404; empty override disables them",
    default: ["https://api.manepa.jp"], emptyMeansEmpty: true },
  { key: "httpHost", env: "BYBIT_HTTP_HOST", type: "str", scope: "feed", effect: "restart",
    desc: "Feed HTTP bind host" },
  { key: "httpPort", env: "BYBIT_HTTP_PORT", type: "int", scope: "feed", effect: "restart",
    desc: "Feed HTTP port", unit: "port", min: 1, max: 65535 },
  { key: "dbPath", env: "BYBIT_DB_PATH", type: "str", scope: "feed", effect: "restart",
    desc: "SQLite market-data store; resolved against the working directory" },
  { key: "symbols", env: "BYBIT_SYMBOLS", type: "csv", scope: "feed", effect: "restart",
    desc: "Watchlist — WS subscribe set and the map/zone universe" },
  { key: "klineIntervals", env: "BYBIT_KLINE_INTERVALS", type: "csv", scope: "feed", effect: "restart",
    desc: "PA kline intervals to cache (not the live 5m stream)" },
  { key: "orderbook.depth", env: "BYBIT_ORDERBOOK_DEPTH", type: "int", scope: "feed", effect: "restart",
    desc: "Orderbook depth", unit: "levels", min: 1, max: 500 },
  { key: "orderbook.symbols", env: "BYBIT_ORDERBOOK_SYMBOLS", type: "csv", scope: "feed", effect: "restart",
    desc: "Orderbook subscribe list; derived from symbols when unset", fallbackKey: "symbols" },
  { key: "pingIntervalMs", env: "BYBIT_PING_INTERVAL_MS", type: "int", scope: "feed", effect: "restart",
    desc: "WS ping interval", unit: "ms", min: 1 },
  { key: "retention.klinesDays", env: "BYBIT_KLINES_DAYS", type: "int", scope: "feed", effect: "restart",
    desc: "Kline retention", unit: "days", min: 1 },
  { key: "retention.liquidationsHours", env: "BYBIT_LIQ_HOURS", type: "int", scope: "feed", effect: "restart",
    desc: "Liquidation print retention; also the /liq-heatmap hours cap", unit: "hours", min: 1, default: 48 },
  { key: "retention.flowHours", env: "BYBIT_FLOW_HOURS", type: "int", scope: "feed", effect: "restart",
    desc: "1m CVD flow-bar retention", unit: "hours", min: 1, default: 24 },
  { key: "recovery.pongStaleMs", env: "BYBIT_PONG_STALE_MS", type: "int", scope: "feed", effect: "restart",
    desc: "WS considered dead when no pong for this long", unit: "ms", min: 1, default: 60000 },
  { key: "recovery.klineLagMs", env: "BYBIT_KLINE_LAG_MS", type: "int", scope: "feed", effect: "restart",
    desc: "PA klines stale after this much lag while ticker is live", unit: "ms", min: 1, default: 180000 },
  { key: "recovery.gapFill", env: "BYBIT_GAP_FILL", type: "bool", scope: "feed", effect: "restart",
    desc: "REST gap-fill klines/OI/funding after reconnect", default: true },
];
