import { intervalToMs, restCandleConfirm } from "./recovery";
import { parseRestKlineList } from "./rest";
import type { BybitKline } from "./types";

export type DumpMeta = {
  symbol?: string;
  interval?: string;
};

export type ParsedDump = DumpMeta & {
  candles: BybitKline[];
};

const MT4_NAME = /^([A-Z0-9]+)_(\d+)_/;

export function inferDumpMeta(name: string): DumpMeta {
  const base = name.split(/[\\/]/).pop() ?? name;
  const match = MT4_NAME.exec(base);
  if (!match) return {};
  return { symbol: match[1], interval: match[2] };
}

export function decodeDumpBytes(bytes: Uint8Array): string {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const raw = gzip ? Bun.gunzipSync(bytes) : bytes;
  return new TextDecoder().decode(raw);
}

export function parseKlineDump(
  text: string,
  opts: { interval: string; now: number; symbol?: string },
): ParsedDump {
  const trimmed = text.trim();
  if (!trimmed) return { symbol: opts.symbol, interval: opts.interval, candles: [] };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonDump(JSON.parse(trimmed) as unknown, opts);
  }
  return {
    symbol: opts.symbol,
    interval: opts.interval,
    candles: parseCsvDump(trimmed, opts.interval, opts.now),
  };
}

function parseJsonDump(
  data: unknown,
  opts: { interval: string; now: number; symbol?: string },
): ParsedDump {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { symbol: opts.symbol, interval: opts.interval, candles: [] };
    }
    if (Array.isArray(data[0])) {
      return {
        symbol: opts.symbol,
        interval: opts.interval,
        candles: parseRestKlineList(data, opts.interval, opts.now),
      };
    }
    return {
      symbol: opts.symbol,
      interval: opts.interval,
      candles: parseObjectRows(data, opts.interval, opts.now),
    };
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const result = obj.result && typeof obj.result === "object"
      ? obj.result as Record<string, unknown>
      : undefined;
    const list = result?.list ?? obj.list ?? obj.klines ?? obj.candles;
    const symbol = stringish(obj.symbol) ?? stringish(result?.symbol) ?? opts.symbol;
    const interval = stringish(obj.interval) ?? stringish(result?.interval) ?? opts.interval;
    if (Array.isArray(list)) {
      if (list.length && Array.isArray(list[0])) {
        return { symbol, interval, candles: parseRestKlineList(list, interval, opts.now) };
      }
      return { symbol, interval, candles: parseObjectRows(list, interval, opts.now) };
    }
  }

  throw new Error("Unrecognized kline JSON dump");
}

function parseObjectRows(rows: unknown[], interval: string, now: number): BybitKline[] {
  const intervalMs = intervalToMs(interval);
  const candles: BybitKline[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const start = parseStart(rec.start ?? rec.start_ts ?? rec.startTime ?? rec.time ?? rec.datetime);
    if (start === null) continue;
    const open = rec.open ?? rec.Open;
    const high = rec.high ?? rec.High;
    const low = rec.low ?? rec.Low;
    const close = rec.close ?? rec.Close;
    if (open == null || high == null || low == null || close == null) continue;
    candles.push({
      start,
      end: start + intervalMs,
      interval,
      open: String(open),
      high: String(high),
      low: String(low),
      close: String(close),
      volume: String(rec.volume ?? rec.Volume ?? "0"),
      turnover: String(rec.turnover ?? rec.Turnover ?? "0"),
      confirm: restCandleConfirm(start, intervalMs, now),
      timestamp: start,
    });
  }
  return candles;
}

export function parseCsvDump(text: string, interval: string, now: number): BybitKline[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  let start = 0;
  let header: string[] | null = null;
  if (looksLikeHeader(lines[0] ?? "")) {
    header = splitCsv(lines[0] ?? "").map((cell) => cell.trim().toLowerCase());
    start = 1;
  }

  const intervalMs = intervalToMs(interval);
  const candles: BybitKline[] = [];
  for (const line of lines.slice(start)) {
    const cells = splitCsv(line);
    if (cells.length < 5) continue;
    const mapped = header ? mapHeaderRow(header, cells) : mapPositionalRow(cells);
    if (!mapped) continue;
    candles.push({
      start: mapped.start,
      end: mapped.start + intervalMs,
      interval,
      open: mapped.open,
      high: mapped.high,
      low: mapped.low,
      close: mapped.close,
      volume: mapped.volume,
      turnover: mapped.turnover,
      confirm: restCandleConfirm(mapped.start, intervalMs, now),
      timestamp: mapped.start,
    });
  }
  return candles;
}

function looksLikeHeader(line: string): boolean {
  return /start|datetime|time|open|date/i.test(line) && /open/i.test(line);
}

function mapHeaderRow(header: string[], cells: string[]) {
  const get = (...names: string[]) => {
    for (const name of names) {
      const idx = header.indexOf(name);
      if (idx !== -1 && cells[idx] !== undefined) return cells[idx];
    }
    return undefined;
  };
  const start = parseStart(get("start", "start_ts", "starttime", "time", "datetime", "date"));
  const open = get("open");
  const high = get("high");
  const low = get("low");
  const close = get("close");
  if (start === null || open == null || high == null || low == null || close == null) return null;
  return {
    start,
    open,
    high,
    low,
    close,
    volume: get("volume") ?? "0",
    turnover: get("turnover") ?? "0",
  };
}

function mapPositionalRow(cells: string[]) {
  const start = parseStart(cells[0]);
  if (start === null || cells[1] == null || cells[2] == null || cells[3] == null || cells[4] == null) {
    return null;
  }
  return {
    start,
    open: cells[1],
    high: cells[2],
    low: cells[3],
    close: cells[4],
    volume: cells[5] ?? "0",
    turnover: cells[6] ?? "0",
  };
}

function parseStart(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const mt4 = /^(\d{4})[.\-](\d{2})[.\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (mt4) {
    return Date.UTC(
      Number(mt4[1]),
      Number(mt4[2]) - 1,
      Number(mt4[3]),
      Number(mt4[4]),
      Number(mt4[5]),
      Number(mt4[6] ?? 0),
    );
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function splitCsv(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

function stringish(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
