import { describe, expect, test } from "bun:test";
import { decodeDumpBytes, inferDumpMeta, parseCsvDump, parseKlineDump } from "../../../src/feed/bb/dump";

describe("inferDumpMeta", () => {
  test("reads symbol and interval from public.bybit.com filenames", () => {
    expect(inferDumpMeta("BTCUSDT_15_2025-01-01_2025-01-31.csv.gz")).toEqual({
      symbol: "BTCUSDT",
      interval: "15",
    });
    expect(inferDumpMeta("/tmp/ETHUSDT_60_2024-12-01_2024-12-31.csv")).toEqual({
      symbol: "ETHUSDT",
      interval: "60",
    });
  });
});

describe("parseKlineDump", () => {
  const now = Date.parse("2025-01-02T00:00:00.000Z");

  test("maps a Bybit REST JSON envelope", () => {
    const parsed = parseKlineDump(JSON.stringify({
      retCode: 0,
      result: {
        symbol: "BTCUSDT",
        list: [["1735689600000", "1", "3", "0.5", "2", "10", "20"]],
      },
    }), { interval: "15", now });
    expect(parsed.symbol).toBe("BTCUSDT");
    expect(parsed.candles).toHaveLength(1);
    expect(parsed.candles[0]).toMatchObject({
      start: 1_735_689_600_000,
      open: "1",
      high: "3",
      low: "0.5",
      close: "2",
      volume: "10",
      turnover: "20",
      interval: "15",
      confirm: true,
    });
  });

  test("maps a REST tuple array", () => {
    const parsed = parseKlineDump(
      JSON.stringify([["1735689600000", "1", "2", "1", "1.5", "4", "5"]]),
      { interval: "60", now },
    );
    expect(parsed.candles[0]?.interval).toBe("60");
    expect(parsed.candles[0]?.start).toBe(1_735_689_600_000);
  });

  test("maps object rows", () => {
    const parsed = parseKlineDump(JSON.stringify({
      symbol: "SOLUSDT",
      interval: "240",
      klines: [{ start: 1_735_689_600_000, open: "100", high: "110", low: "90", close: "105", volume: "1" }],
    }), { interval: "15", now });
    expect(parsed.symbol).toBe("SOLUSDT");
    expect(parsed.interval).toBe("240");
    expect(parsed.candles[0]?.close).toBe("105");
  });

  test("maps public.bybit.com MetaTrader CSV (no header)", () => {
    const candles = parseCsvDump(
      "2025.01.01 00:00,93537.7,93747.2,93441.6,93537.7,778.709\n2025.01.01 00:15,93537.7,93731.3,93468,93578.8,441.058\n",
      "15",
      now,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]?.start).toBe(Date.UTC(2025, 0, 1, 0, 0));
    expect(candles[0]?.open).toBe("93537.7");
    expect(candles[1]?.start).toBe(Date.UTC(2025, 0, 1, 0, 15));
  });

  test("maps a headed CSV with epoch start", () => {
    const parsed = parseKlineDump(
      "start,open,high,low,close,volume,turnover\n1735689600000,1,2,0.5,1.5,9,8\n",
      { interval: "15", now },
    );
    expect(parsed.candles[0]?.turnover).toBe("8");
  });

  test("gunzips a dump before parsing", () => {
    const csv = "2025.01.01 00:00,1,2,0.5,1.5,3\n";
    const gz = Bun.gzipSync(new TextEncoder().encode(csv));
    const parsed = parseKlineDump(decodeDumpBytes(gz), { interval: "15", now });
    expect(parsed.candles).toHaveLength(1);
    expect(parsed.candles[0]?.close).toBe("1.5");
  });
});
