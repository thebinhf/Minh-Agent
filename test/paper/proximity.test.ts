import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createPaperEngine } from "../../src/paper/engine";
import { openPaperDb } from "../../src/paper/db";
import { confirm15Bar } from "../../src/paper/proximity";
import { mockFeed, paperConfig, tempDir, UNIVERSE } from "./helpers";
import type { ZoneCard } from "../../src/zones/card";

const dirs: string[] = [];
const saved = process.env.PAPER_PROXIMITY_ARM;
const savedQuant = process.env.AGENT_QUANT;
const savedConfirm = process.env.PAPER_CONFIRM_15;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (saved === undefined) delete process.env.PAPER_PROXIMITY_ARM;
  else process.env.PAPER_PROXIMITY_ARM = saved;
  if (savedQuant === undefined) delete process.env.AGENT_QUANT;
  else process.env.AGENT_QUANT = savedQuant;
  if (savedConfirm === undefined) delete process.env.PAPER_CONFIRM_15;
  else process.env.PAPER_CONFIRM_15 = savedConfirm;
});

async function engineWithLev(feed = mockFeed(), leverage = "10") {
  const dir = tempDir();
  dirs.push(dir);
  const base = await paperConfig(dir);
  const account = { ...base.account, defaultLeverage: leverage, minRr: null };
  const config = { ...base, account, tickMs: 0 };
  const store = openPaperDb(config.dbPath, account);
  const engine = createPaperEngine({ store, feed, config, universe: UNIVERSE });
  return { dir, engine, feed, store };
}

const SUPPLY: ZoneCard = {
  zoneId: "btc-4h-s-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "supply",
  baseStartTs: 1_788_801_600_000,
  baseEndTs: 1_788_808_800_000,
  zoneLow: 79_250,
  zoneHigh: 79_472,
  distal: 79_472,
  proximal: 79_250,
  impulseBody: 980,
  atr14: 720,
  impulseAtr: 1.36,
  departureAtr: 0.42,
  freshness: "virgin",
  penetrationPct: 0,
  entry: 79_300,
  sl: 79_880,
  tp: 77_580,
  rr: 2.97,
  hardInvalid: 79_880,
  softInvalid: 79_472,
  expiryBars: 48,
  cancelCodes: [],
};

const SUPPLY_15 = {
  interval: "15",
  open: "79320",
  close: "79280",
  startTs: 1_788_808_800_000,
  confirm: true as const,
};

function armFeed() {
  return mockFeed({
    lastPrice: "79280",
    markPrice: "79280",
    klines: { "15": SUPPLY_15 },
  });
}

describe("confirm15Bar", () => {
  test("forming / doji / opposite / close through entry wait; bear in-band ok; kill skips", () => {
    delete process.env.PAPER_CONFIRM_15;
    expect(confirm15Bar(SUPPLY, { ...SUPPLY_15, confirm: false })).toBe("wait");
    expect(confirm15Bar(SUPPLY, { ...SUPPLY_15, open: "79280" })).toBe("wait");
    expect(confirm15Bar(SUPPLY, { ...SUPPLY_15, open: "79240", close: "79280" })).toBe("wait");
    expect(confirm15Bar(SUPPLY, { ...SUPPLY_15, close: "79310" })).toBe("wait");
    expect(confirm15Bar(SUPPLY, SUPPLY_15)).toBe("ok");
    process.env.PAPER_CONFIRM_15 = "0";
    expect(confirm15Bar(SUPPLY, { ...SUPPLY_15, confirm: false })).toBe("ok");
  });
});

describe("proximity arm", () => {
  test("does not arm until last is in the proximal band; then rests post-only OCO once", async () => {
    delete process.env.PAPER_PROXIMITY_ARM;
    delete process.env.PAPER_CONFIRM_15;
    const feed = mockFeed({
      lastPrice: "79600",
      markPrice: "79600",
      klines: { "15": SUPPLY_15 },
    });
    const ctx = await engineWithLev(feed);
    ctx.engine.acceptZone(SUPPLY);
    await ctx.engine.mark();
    expect(ctx.engine.orders("pending")).toEqual([]);

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "79280",
      markPrice: "79280",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await ctx.engine.mark();
    expect(marked.proximity.armed).toEqual(["btc-4h-s-20260908-01"]);
    expect(ctx.engine.orders("pending")).toHaveLength(1);
    expect(ctx.engine.orders("pending")[0]?.side).toBe("short");
    expect(ctx.engine.orders("pending")[0]?.limitPrice).toBe("79300");
    expect(ctx.engine.orders("pending")[0]?.zoneId).toBe("btc-4h-s-20260908-01");
    expect(ctx.engine.alerts("armed")).toHaveLength(1);

    const again = await ctx.engine.mark();
    expect(again.proximity.armed).toEqual([]);
    expect(ctx.engine.orders("pending")).toHaveLength(1);
  });

  test("PAPER_PROXIMITY_ARM=0 never arms; through SL rejects the card", async () => {
    process.env.PAPER_PROXIMITY_ARM = "0";
    const feed = mockFeed({ lastPrice: "79280", markPrice: "79280" });
    const ctx = await engineWithLev(feed);
    ctx.engine.acceptZone(SUPPLY);
    await ctx.engine.mark();
    expect(ctx.engine.orders("pending")).toEqual([]);

    delete process.env.PAPER_PROXIMITY_ARM;
    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "79900",
      markPrice: "79900",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await ctx.engine.mark();
    expect(marked.proximity.armed).toEqual([]);
    expect(marked.proximity.rejected).toEqual(["btc-4h-s-20260908-01"]);
    expect(ctx.engine.zones("accepted")).toEqual([]);
    expect(ctx.engine.zones("rejected")[0]?.rejectCode).toBe("htf_break");
  });

  test("forming 15m waits — does not arm and does not reject", async () => {
    delete process.env.PAPER_PROXIMITY_ARM;
    delete process.env.PAPER_CONFIRM_15;
    const feed = mockFeed({
      lastPrice: "79280",
      markPrice: "79280",
      klines: { "15": { ...SUPPLY_15, confirm: false } },
    });
    const ctx = await engineWithLev(feed);
    ctx.engine.acceptZone(SUPPLY);
    const marked = await ctx.engine.mark();
    expect(marked.proximity.armed).toEqual([]);
    expect(marked.proximity.rejected).toEqual([]);
    expect(ctx.engine.orders("pending")).toEqual([]);
    expect(ctx.engine.zones("accepted")).toHaveLength(1);
  });

  test("quant cascade waits — does not arm and does not reject the card", async () => {
    delete process.env.PAPER_PROXIMITY_ARM;
    delete process.env.AGENT_QUANT;
    delete process.env.PAPER_CONFIRM_15;
    const feed = armFeed();
    feed.quant = async () => ({
      crowded: null,
      oiReading: null,
      cascade: { active: true, side: "short", fuel: "6" },
      flowReading: null,
    });
    const ctx = await engineWithLev(feed);
    ctx.engine.acceptZone(SUPPLY);
    const marked = await ctx.engine.mark();
    expect(marked.proximity.armed).toEqual([]);
    expect(marked.proximity.rejected).toEqual([]);
    expect(ctx.engine.orders("pending")).toEqual([]);
    expect(ctx.engine.zones("accepted")).toHaveLength(1);
  });

  test("opposing OI add does not block ARM (zone fill)", async () => {
    delete process.env.PAPER_PROXIMITY_ARM;
    delete process.env.AGENT_QUANT;
    delete process.env.PAPER_CONFIRM_15;
    const feed = armFeed();
    feed.quant = async () => ({
      crowded: null,
      oiReading: "long_add",
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: null,
    });
    const ctx = await engineWithLev(feed);
    ctx.engine.acceptZone(SUPPLY);
    const marked = await ctx.engine.mark();
    expect(marked.proximity.armed).toEqual(["btc-4h-s-20260908-01"]);
    expect(ctx.engine.orders("pending")).toHaveLength(1);
  });

  test("rr_below_min after tick snap latches rr_fail — does not retry every tick", async () => {
    delete process.env.PAPER_PROXIMITY_ARM;
    delete process.env.PAPER_CONFIRM_15;
    const dir = tempDir();
    dirs.push(dir);
    const base = await paperConfig(dir);
    const account = { ...base.account, defaultLeverage: "10", minRr: "10" };
    const config = { ...base, account, tickMs: 0 };
    const store = openPaperDb(config.dbPath, account);
    const engine = createPaperEngine({ store, feed: armFeed(), config, universe: UNIVERSE });
    engine.acceptZone(SUPPLY);
    const marked = await engine.mark();
    expect(marked.proximity.armed).toEqual([]);
    expect(marked.proximity.rejected).toEqual(["btc-4h-s-20260908-01"]);
    expect(engine.orders("pending")).toEqual([]);
    expect(engine.zones("accepted")).toEqual([]);
    expect(engine.zones("rejected")[0]?.rejectCode).toBe("rr_fail");
    const again = await engine.mark();
    expect(again.proximity.rejected).toEqual([]);
  });

  test("opposing CVD does not block ARM (like OI add)", async () => {
    delete process.env.PAPER_PROXIMITY_ARM;
    delete process.env.AGENT_QUANT;
    delete process.env.PAPER_CONFIRM_15;
    const feed = armFeed();
    feed.quant = async () => ({
      crowded: null,
      oiReading: null,
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: "buy_dom",
    });
    const ctx = await engineWithLev(feed);
    ctx.engine.acceptZone(SUPPLY);
    const marked = await ctx.engine.mark();
    expect(marked.proximity.armed).toEqual(["btc-4h-s-20260908-01"]);
    expect(ctx.engine.orders("pending")).toHaveLength(1);
  });
});
