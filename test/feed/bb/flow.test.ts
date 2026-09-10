import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/feed/bb/db";
import { startHttp } from "../../../src/feed/bb/http";
import {
  FLOW_NOTE,
  buildFlow,
  buildMapFlow,
  flowReading,
  parsePublicTrades,
} from "../../../src/feed/bb/flow";
import type { TrackerConfig } from "../../../src/feed/bb/types";

const dirs: string[] = [];
const savedExtreme = process.env.BYBIT_FLOW_EXTREME;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedExtreme === undefined) delete process.env.BYBIT_FLOW_EXTREME;
  else process.env.BYBIT_FLOW_EXTREME = savedExtreme;
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "minh-flow-"));
  dirs.push(dir);
  const dbPath = join(dir, "market.sqlite");
  return { dbPath, store: openDb(dbPath) };
}

describe("publicTrade parse + CVD reading", () => {
  test("Buy is taker buy; Sell is taker sell; imbalance vs extreme", () => {
    const trades = parsePublicTrades([
      { T: 1_000, s: "BTCUSDT", S: "Buy", v: "2", p: "100" },
      { T: 2_000, s: "BTCUSDT", S: "Sell", v: "1", p: "100" },
      { T: 3_000, s: "BTCUSDT", S: "Nope", v: "1", p: "1" },
    ]);
    expect(trades).toEqual([
      { symbol: "BTCUSDT", side: "Buy", price: "100", size: "2", exchTs: 1_000 },
      { symbol: "BTCUSDT", side: "Sell", price: "100", size: "1", exchTs: 2_000 },
    ]);
    expect(flowReading("0.20", "0.15")).toBe("buy_dom");
    expect(flowReading("-0.20", "0.15")).toBe("sell_dom");
    expect(flowReading("0.10", "0.15")).toBeNull();
  });
});

describe("flow store + HTTP + MAP", () => {
  test("GET /flow and /map.flow use 4H CVD as primary reading", async () => {
    delete process.env.BYBIT_FLOW_EXTREME;
    const { store, dbPath } = tempDb();
    const now = Date.now();
    store.saveFlowTrades([
      { symbol: "BTCUSDT", side: "Sell", price: "100", size: "8", exchTs: now - 60_000 },
      { symbol: "BTCUSDT", side: "Buy", price: "100", size: "1", exchTs: now - 60_000 },
    ], now);

    const snap = buildFlow(store, { symbol: "BTCUSDT", dbPath, now });
    expect(snap.reading).toBe("sell_dom");
    expect(snap.delta).toBe("-700.0000");
    expect(snap["240"].reading).toBe("sell_dom");
    expect(snap["15"].reading).toBe("sell_dom");
    expect(snap.meta.note).toBe(FLOW_NOTE);

    const mapFlow = buildMapFlow(store, "BTCUSDT", now);
    expect(mapFlow.reading).toBe("sell_dom");
    expect(mapFlow.note).toBe(FLOW_NOTE);

    const server = startHttp({
      httpHost: "127.0.0.1",
      httpPort: 0,
      dbPath,
    } as TrackerConfig, store);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/flow?symbol=BTCUSDT`);
      expect(res.status).toBe(200);
      const body = await res.json() as { reading: string; note?: string; meta: { note: string } };
      expect(body.reading).toBe("sell_dom");
      expect(body.meta.note).toBe(FLOW_NOTE);

      const map = await (await fetch(`http://127.0.0.1:${server.port}/map?symbol=BTCUSDT`)).json() as {
        flow: { reading: string; delta: string; note: string };
      };
      expect(map.flow.reading).toBe("sell_dom");
      expect(map.flow.note).toBe(FLOW_NOTE);
    } finally {
      server.stop();
      store.close();
    }
  });

  test("quiet tape is not a reading; 15m window can differ from 4H", () => {
    const { store, dbPath } = tempDb();
    const now = 20_000_000;
    store.saveFlowTrades([
      { symbol: "BTCUSDT", side: "Buy", price: "100", size: "10", exchTs: now - 3 * 3_600_000 },
      { symbol: "BTCUSDT", side: "Sell", price: "100", size: "1", exchTs: now - 60_000 },
    ], now);
    const snap = buildFlow(store, { symbol: "BTCUSDT", dbPath, now });
    expect(snap["240"].reading).toBe("buy_dom");
    expect(snap["15"].reading).toBe("sell_dom");
    expect(snap.reading).toBe("buy_dom");
    expect(buildFlow(store, { symbol: "ETHUSDT", dbPath, now }).reading).toBeNull();
    store.close();
  });
});
