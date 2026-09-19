import { afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onMapCloseAccept } from "../../src/agent/policy";
import { openLiveDb } from "../../src/live/db";
import { planMapClose } from "../../src/live/plan";
import { mockFeed, paperEngine } from "../paper/helpers";
import { HEALTH_OK, MAP_CARD_ASOF, MAP_CARD_BASE_END_TS, MAP_CARD_BASE_START_TS, mapPayload } from "../agent/htf";
import type { ZoneCard } from "../../src/zones/card";

/**
 * The point of `src/strategy/` is that the paper desk and the live-shadow run one
 * allocation. They used to run three: the desk took the cap in `/zones` payload
 * order, the shadow re-ranked by RR, and the walk ranked by family score only
 * where a score existed — so a `shadow=deny ledger_cap` line on the terminal
 * could disagree with what the desk actually did. This file locks that shut.
 */

beforeAll(() => setSystemTime(MAP_CARD_ASOF));

const dirs: string[] = [];
const savedAllocate = process.env.PAPER_MAP_ALLOCATE;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // EBUSY on Windows teardown — leave the temp dir for the OS to clean.
    }
  }
  if (savedAllocate === undefined) delete process.env.PAPER_MAP_ALLOCATE;
  else process.env.PAPER_MAP_ALLOCATE = savedAllocate;
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "minh-parity-"));
  dirs.push(dir);
  return dir;
}

/** The band geometry policy.test.ts proves accepts at this last price. */
const DEMAND_LAST = 79_450;
const DEMAND: ZoneCard = {
  zoneId: "btc-4h-d-20260908-01",
  symbol: "BTCUSDT",
  tf: "240",
  side: "demand",
  setup: "sd",
  baseStartTs: MAP_CARD_BASE_START_TS,
  baseEndTs: MAP_CARD_BASE_END_TS,
  zoneLow: 79_250,
  zoneHigh: 79_472,
  distal: 79_250,
  proximal: 79_472,
  impulseBody: 980,
  atr14: 720,
  impulseAtr: 1.36,
  departureAtr: 0.42,
  freshness: "virgin",
  penetrationPct: 0,
  entry: 79_400,
  sl: 79_100,
  tp: 80_200,
  rr: 3,
  hardInvalid: 79_100,
  softInvalid: 79_250,
  expiryBars: 48,
  cancelCodes: [],
};

/** Three cards for one symbol, two slots, and arrival order puts the worst first. */
const CARDS: ZoneCard[] = [
  { ...DEMAND, rr: 3 },
  { ...DEMAND, zoneId: "btc-4h-d-20260908-02", rr: 5 },
  { ...DEMAND, zoneId: "btc-4h-d-20260908-03", rr: 4 },
];

const map = mapPayload({ direction: "bull", lastPrice: String(DEMAND_LAST) });
const fetchCards = async () => CARDS;

async function deskAccepted(): Promise<string[]> {
  const ctx = await paperEngine(mockFeed({ lastPrice: String(DEMAND_LAST), markPrice: String(DEMAND_LAST) }));
  dirs.push(ctx.dir);
  const result = await onMapCloseAccept({ interval: "240", map }, ctx.engine, { fetchCards, health: HEALTH_OK });
  return (result?.accepted ?? []).slice().sort();
}

async function shadowAccepted(): Promise<string[]> {
  const store = openLiveDb(join(tempRoot(), "shadow.sqlite"));
  try {
    const plan = await planMapClose(store, { interval: "240", map }, { fetchCards, health: HEALTH_OK });
    return (plan?.accepted ?? []).slice().sort();
  } finally {
    store.close();
  }
}

describe("MAP allocation parity", () => {
  test("arrival order: desk and shadow take the same two cards", async () => {
    delete process.env.PAPER_MAP_ALLOCATE;
    const desk = await deskAccepted();
    expect(desk).toEqual(["btc-4h-d-20260908-01", "btc-4h-d-20260908-02"]);
    expect(await shadowAccepted()).toEqual(desk);
  });

  test("rank order: both surfaces move the scarce slot to the better card", async () => {
    process.env.PAPER_MAP_ALLOCATE = "rank";
    const desk = await deskAccepted();
    expect(desk).toEqual(["btc-4h-d-20260908-02", "btc-4h-d-20260908-03"]);
    expect(await shadowAccepted()).toEqual(desk);
  });
});
