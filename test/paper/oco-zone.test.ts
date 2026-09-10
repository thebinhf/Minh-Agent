import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createPaperEngine } from "../../src/paper/engine";
import { openPaperDb } from "../../src/paper/db";
import { pendingProximityReject, pendingQuantSkipFill } from "../../src/paper/proximity";
import { mockFeed, OPEN_LONG, paperConfig, paperEngine, tempDir, UNIVERSE } from "./helpers";
import type { ZoneCard } from "../../src/zones/card";
import type { PaperFeed, PaperQuantTape } from "../../src/paper/types";

const dirs: string[] = [];
const savedArm = process.env.PAPER_PROXIMITY_ARM;
const savedQuant = process.env.AGENT_QUANT;
const savedConfirm = process.env.PAPER_CONFIRM_15;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedArm === undefined) delete process.env.PAPER_PROXIMITY_ARM;
  else process.env.PAPER_PROXIMITY_ARM = savedArm;
  if (savedQuant === undefined) delete process.env.AGENT_QUANT;
  else process.env.AGENT_QUANT = savedQuant;
  if (savedConfirm === undefined) delete process.env.PAPER_CONFIRM_15;
  else process.env.PAPER_CONFIRM_15 = savedConfirm;
});

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

const CASCADE_SHORT: PaperQuantTape = {
  crowded: null,
  oiReading: null,
  cascade: { active: true, side: "short", fuel: "6" },
  flowReading: null,
};

const CROWDED_SHORT: PaperQuantTape = {
  crowded: "short",
  oiReading: null,
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: null,
};

const BUY_DOM: PaperQuantTape = {
  crowded: null,
  oiReading: null,
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: "buy_dom",
};

const LONG_ADD: PaperQuantTape = {
  crowded: null,
  oiReading: "long_add",
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: null,
};

const QUIET: PaperQuantTape = {
  crowded: null,
  oiReading: null,
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: null,
};

function setLast(feed: PaperFeed, last: string, recvTs = Date.now()) {
  feed.ticker = async (symbol) => ({
    symbol,
    lastPrice: last,
    markPrice: last,
    recvTs,
    fundingRate: null,
    nextFundingTime: null,
  });
}

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

function armFeed() {
  return mockFeed({
    lastPrice: "79280",
    markPrice: "79280",
    klines: { "15": SUPPLY_15 },
  });
}

async function armSupply(feed = armFeed()) {
  delete process.env.PAPER_PROXIMITY_ARM;
  delete process.env.PAPER_CONFIRM_15;
  delete process.env.AGENT_QUANT;
  const ctx = await engineWithLev(feed);
  ctx.engine.acceptZone(SUPPLY);
  const marked = await ctx.engine.mark();
  expect(marked.proximity.armed).toEqual([SUPPLY.zoneId]);
  expect(ctx.engine.orders("pending")).toHaveLength(1);
  return ctx;
}

describe("pendingProximityReject / pendingQuantSkipFill", () => {
  test("through entry still fills; deep and SL bind; arm-gate skip is cascade/crowded only", () => {
    expect(pendingProximityReject(SUPPLY, 79_280)).toBeNull();
    expect(pendingProximityReject(SUPPLY, 79_350)).toBeNull();
    expect(pendingProximityReject(SUPPLY, 79_400)).toBe("deep_mitigate");
    expect(pendingProximityReject(SUPPLY, 79_900)).toBe("htf_break");
    expect(pendingQuantSkipFill("supply", CASCADE_SHORT)).toBe(true);
    expect(pendingQuantSkipFill("supply", CROWDED_SHORT)).toBe(true);
    expect(pendingQuantSkipFill("supply", BUY_DOM)).toBe(false);
    expect(pendingQuantSkipFill("supply", LONG_ADD)).toBe(false);
    expect(pendingQuantSkipFill("supply", undefined)).toBe(false);
  });
});

describe("zoned pending OCO", () => {
  test("expire cancels bound pending + alert before fill", async () => {
    const ctx = await armSupply();
    const t0 = Date.now();
    const later = t0 + 48 * 4 * 60 * 60 * 1000;
    setLast(ctx.feed, "79320", later);
    const marked = await ctx.engine.mark(later);
    expect(marked.filled).toHaveLength(0);
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.invalidated[0]?.status).toBe("invalidated");
    const event = marked.events.find((row) => row.kind === "order.invalidated");
    expect(event?.payload.cancelCode).toBe("expired");
    expect(ctx.engine.orders("pending")).toHaveLength(0);
    expect(ctx.engine.positions("open")).toHaveLength(0);
    expect(ctx.engine.alerts("armed")).toHaveLength(0);
    expect(ctx.engine.zones("accepted", later)).toHaveLength(0);
    expect(ctx.engine.zones("expired", later)[0]?.zoneId).toBe(SUPPLY.zoneId);
    const metrics = ctx.engine.metrics(7, later);
    expect(metrics.cancelCodes.expired).toBe(1);
    expect(metrics.cancelCodes.never_touched).toBe(0);
  });

  test("listing due zones also kills the bound OCO", async () => {
    const ctx = await armSupply();
    const later = Date.now() + 48 * 4 * 60 * 60 * 1000;
    expect(ctx.engine.zones("accepted", later)).toEqual([]);
    expect(ctx.engine.orders("pending")).toHaveLength(0);
    expect(ctx.engine.alerts("armed")).toHaveLength(0);
    const event = ctx.engine.events().find((row) => row.kind === "order.invalidated");
    expect(event?.payload.cancelCode).toBe("expired");
  });

  test("deep mitigate after rest invalidates pending, does not fill", async () => {
    const ctx = await armSupply();
    setLast(ctx.feed, "79400");
    const marked = await ctx.engine.mark();
    expect(marked.filled).toHaveLength(0);
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.events.find((row) => row.kind === "order.invalidated")?.payload.cancelCode).toBe("deep_mitigate");
    expect(ctx.engine.orders("pending")).toHaveLength(0);
    expect(ctx.engine.positions("open")).toHaveLength(0);
    expect(ctx.engine.alerts("armed")).toHaveLength(0);
    expect(ctx.engine.zones("rejected")[0]?.rejectCode).toBe("deep_mitigate");
    expect(ctx.engine.metrics().cancelCodes.deep_mitigate).toBe(1);
  });

  test("through SL after rest is htf_break, not never_touched", async () => {
    const ctx = await armSupply();
    setLast(ctx.feed, "79900");
    const marked = await ctx.engine.mark();
    expect(marked.filled).toHaveLength(0);
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.events.find((row) => row.kind === "order.invalidated")?.payload.cancelCode).toBe("htf_break");
    expect(ctx.engine.zones("rejected")[0]?.rejectCode).toBe("htf_break");
    expect(ctx.engine.metrics().cancelCodes.htf_break).toBe(1);
    expect(ctx.engine.metrics().cancelCodes.never_touched).toBe(0);
  });

  test("rejectZone cancels bound pending and matching alert", async () => {
    const ctx = await armSupply();
    const rejected = ctx.engine.rejectZone(SUPPLY.zoneId, "ops_cancel");
    expect(rejected.status).toBe("rejected");
    expect(ctx.engine.orders("pending")).toHaveLength(0);
    expect(ctx.engine.orders("invalidated")).toHaveLength(1);
    expect(ctx.engine.alerts("armed")).toHaveLength(0);
    const event = ctx.engine.events().find((row) => row.kind === "order.invalidated");
    expect(event?.payload.cancelCode).toBe("ops_cancel");
  });

  test("cascade while pending skips fill and keeps the zone", async () => {
    const ctx = await armSupply();
    ctx.feed.quant = async () => CASCADE_SHORT;
    setLast(ctx.feed, "79320");
    const held = await ctx.engine.mark();
    expect(held.filled).toHaveLength(0);
    expect(held.invalidated).toHaveLength(0);
    expect(ctx.engine.orders("pending")).toHaveLength(1);
    expect(ctx.engine.zones("accepted")).toHaveLength(1);

    ctx.feed.quant = async () => QUIET;
    const filled = await ctx.engine.mark();
    expect(filled.filled).toHaveLength(1);
    expect(ctx.engine.positions("open")).toHaveLength(1);
    expect(ctx.engine.positions("open")[0]?.entryPrice).toBe("79300");
  });

  test("crowded while pending holds; opposing CVD/OI still fill", async () => {
    const crowded = await armSupply();
    crowded.feed.quant = async () => CROWDED_SHORT;
    setLast(crowded.feed, "79320");
    const held = await crowded.engine.mark();
    expect(held.filled).toHaveLength(0);
    expect(crowded.engine.orders("pending")).toHaveLength(1);

    const cvd = await armSupply();
    cvd.feed.quant = async () => BUY_DOM;
    setLast(cvd.feed, "79320");
    expect((await cvd.engine.mark()).filled).toHaveLength(1);

    const oi = await armSupply();
    oi.feed.quant = async () => LONG_ADD;
    setLast(oi.feed, "79320");
    expect((await oi.engine.mark()).filled).toHaveLength(1);
  });

  test("unzoned OCO still never_touched; unzoned fill ignores cascade", async () => {
    delete process.env.AGENT_QUANT;
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    feed.quant = async () => CASCADE_SHORT;
    const ctx = await paperEngine(feed);
    dirs.push(ctx.dir);
    await ctx.engine.limit({
      ...OPEN_LONG,
      limitPrice: "62000",
    });
    setLast(feed, "61900");
    const filled = await ctx.engine.mark();
    expect(filled.filled).toHaveLength(1);

    const ocoFeed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const oco = await paperEngine(ocoFeed);
    dirs.push(oco.dir);
    await oco.engine.limit({ ...OPEN_LONG, limitPrice: "62000" });
    setLast(ocoFeed, "59000");
    const marked = await oco.engine.mark();
    expect(marked.invalidated).toHaveLength(1);
    expect(marked.events.find((row) => row.kind === "order.invalidated")?.payload.cancelCode).toBe("never_touched");
    expect(oco.engine.metrics().cancelCodes.never_touched).toBe(1);
  });
});
