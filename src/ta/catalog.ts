/** Overlay catalog. None of these arm, accept, or rest OCO. */

export const TA_NOTE = "overlay pack — not a signal, does not arm";

export const TA_INTERVALS = ["15", "60", "240"] as const;
export type TaInterval = (typeof TA_INTERVALS)[number];

export const TA_KLINE_LIMIT = 120;

export const TA_FAMILIES = [
  "existing",
  "structure",
  "candle",
  "oscillator",
  "discretionary",
  "ict_confirm",
] as const;
export type TaFamily = (typeof TA_FAMILIES)[number];

export const TA_ROLES = ["overlay", "context", "existing", "discretionary", "ict_confirm"] as const;
export type TaRole = (typeof TA_ROLES)[number];

export const TA_METHOD_IDS = [
  "fibonacci",
  "breakouts",
  "reversal",
  "elliott",
  "fvg",
  "candlesticks",
  "heikin_ashi",
  "moon_phases",
  "renko",
  "harmonic",
  "support_resistance",
  "dynamic_sr",
  "trend_lines",
  "gann",
  "momentum",
  "oscillators",
  "divergence",
  "volume",
  "supply_demand",
  "market_structure",
  "bos",
  "choch",
] as const;
export type TaMethodId = (typeof TA_METHOD_IDS)[number];

export type TaMethodMeta = {
  id: TaMethodId;
  name: string;
  family: TaFamily;
  role: TaRole;
};

export const TA_METHODS: readonly TaMethodMeta[] = [
  { id: "fibonacci", name: "Fibonacci Retracements", family: "structure", role: "overlay" },
  { id: "breakouts", name: "Breakouts", family: "structure", role: "overlay" },
  { id: "reversal", name: "Reversal", family: "structure", role: "overlay" },
  { id: "elliott", name: "Elliott Wave", family: "discretionary", role: "discretionary" },
  { id: "fvg", name: "Fair Value Gap", family: "ict_confirm", role: "ict_confirm" },
  { id: "candlesticks", name: "Candlesticks", family: "candle", role: "overlay" },
  { id: "heikin_ashi", name: "Heikin Ashi", family: "candle", role: "overlay" },
  { id: "moon_phases", name: "Moon Phases", family: "discretionary", role: "discretionary" },
  { id: "renko", name: "Renko", family: "candle", role: "overlay" },
  { id: "harmonic", name: "Harmonic Patterns", family: "discretionary", role: "discretionary" },
  { id: "support_resistance", name: "Support and Resistance", family: "structure", role: "overlay" },
  { id: "dynamic_sr", name: "Dynamic Support and Resistance", family: "structure", role: "overlay" },
  { id: "trend_lines", name: "Trend Lines", family: "structure", role: "overlay" },
  { id: "gann", name: "Gann Angles", family: "discretionary", role: "discretionary" },
  { id: "momentum", name: "Momentum Indicators", family: "oscillator", role: "context" },
  { id: "oscillators", name: "Oscillators", family: "oscillator", role: "context" },
  { id: "divergence", name: "Divergence", family: "oscillator", role: "context" },
  { id: "volume", name: "Volume", family: "existing", role: "context" },
  { id: "supply_demand", name: "Supply & Demand", family: "existing", role: "existing" },
  { id: "market_structure", name: "Market Structure", family: "existing", role: "existing" },
  { id: "bos", name: "BOS", family: "ict_confirm", role: "ict_confirm" },
  { id: "choch", name: "CHOCH", family: "ict_confirm", role: "ict_confirm" },
] as const;

export function isTaInterval(raw: string): raw is TaInterval {
  return raw === "15" || raw === "60" || raw === "240";
}

export function parseTaInterval(raw: string | undefined | null): TaInterval | { error: "ta_interval" } {
  if (raw == null || raw.trim() === "") return "240";
  const token = raw.trim();
  if (isTaInterval(token)) return token;
  return { error: "ta_interval" };
}
