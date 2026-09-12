import type { TaArmTape, TaOscTape } from "../agent/ta-gate";
import { emptyTaArmTape, emptyTaOscTape } from "../agent/ta-gate";
import type { TaBar } from "./bars";
import { divergence, oscillators, volume } from "./oscillator";
import { fibonacci, reversal } from "./structure";

export type ArmTapeBar = {
  startTs: number | null | undefined;
  open?: string | number | null;
  high?: string | number | null;
  low?: string | number | null;
  close: string | number | null | undefined;
  volume?: string | number | null;
  confirm?: boolean | null;
};

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function taBarsFromSnaps(rows: ArmTapeBar[]): TaBar[] {
  const out: TaBar[] = [];
  for (const row of rows) {
    if (row.confirm === false) continue;
    const startTs = num(row.startTs);
    const open = num(row.open);
    const high = num(row.high ?? row.close);
    const low = num(row.low ?? row.close);
    const close = num(row.close);
    if (startTs == null || open == null || high == null || low == null || close == null) continue;
    if (!(high >= low) || !(high >= Math.max(open, close)) || !(low <= Math.min(open, close))) continue;
    const volume = num(row.volume);
    out.push({
      startTs,
      open,
      high,
      low,
      close,
      volume: volume != null && volume > 0 ? volume : null,
      confirm: true,
    });
  }
  out.sort((a, b) => a.startTs - b.startTs);
  return out;
}

export function taOscFromBars(bars: TaBar[]): TaOscTape {
  if (bars.length === 0) return emptyTaOscTape();
  const osc = oscillators(bars);
  const div = divergence(bars);
  return {
    rsi14: osc.data?.rsi14 ?? null,
    divergence: div.quality === "ok" ? div.reading : null,
  };
}

export function taArmFromBars(
  h4: TaBar[],
  m15: TaBar[],
  shock: string | null = null,
): TaArmTape {
  const tape = emptyTaArmTape();
  tape.shock = shock;
  if (h4.length > 0) {
    const fib = fibonacci(h4);
    tape.fibNearest = fib.quality === "ok" && fib.data ? fib.data.nearest : null;
    const vol4 = volume(h4);
    const vol15 = m15.length > 0 ? volume(m15) : { quality: "missing" as const, data: null };
    const vol = vol15.quality === "ok" ? vol15 : vol4;
    tape.volumeRel = vol.quality === "ok" && vol.data ? vol.data.rel : null;
  }
  const revBars = m15.length >= 2 ? m15 : [];
  if (revBars.length >= 2) {
    const rev = reversal(revBars);
    tape.reversal = rev.quality === "ok" ? rev.reading : null;
  }
  return tape;
}

/** 4H klines from a `/map` item. Missing OHLC stays missing. */
export function taOscFromMapItem(item: unknown): TaOscTape | null {
  if (!item || typeof item !== "object") return null;
  const klines = (item as { klines?: { "240"?: unknown } }).klines?.["240"];
  if (!Array.isArray(klines) || klines.length === 0) return null;
  const rows = (klines as Array<Record<string, unknown>>).map((row) => ({
    startTs: (row.start_ts ?? row.startTs) as number | null,
    open: row.open as string | number | null,
    high: row.high as string | number | null,
    low: row.low as string | number | null,
    close: row.close as string | number | null,
    volume: row.volume as string | number | null,
    confirm: row.confirm as boolean | null,
  }));
  const bars = taBarsFromSnaps(rows);
  if (bars.length === 0) return emptyTaOscTape();
  return taOscFromBars(bars);
}

export function taOscFromMap(map: unknown): Map<string, TaOscTape> {
  const out = new Map<string, TaOscTape>();
  if (!map || typeof map !== "object") return out;
  const root = map as { maps?: unknown; symbol?: unknown };
  const items = Array.isArray(root.maps) ? root.maps : [map];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { symbol?: unknown };
    const symbol = String(rec.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const osc = taOscFromMapItem(item);
    if (osc) out.set(symbol, osc);
  }
  return out;
}
