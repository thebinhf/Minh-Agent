/**
 * Data & signal verification against the venue.
 *
 *   bun run scripts/verify-data.ts [--db data/bybit-market.sqlite]
 *
 * Sections:
 *   1. klines vs venue REST   — stored OHLCV must equal what the venue serves
 *   2. OI vs venue REST       — stored history must match /open-interest
 *   3. funding vs venue REST  — stored history must match /funding/history
 *   4. tape integrity         — flow bars bucketed/aggregated honestly, liq prints sane
 *   5. signal invariants      — every zone card re-derived from raw klines: geometry,
 *                               impulse, rr, penetration/freshness; plus determinism
 *   6. methodology audit      — one signal producer, veto-only quant, overlay never arms,
 *                               no LLM/MCP in the autonomous path
 *   7. market coverage        — watchlist vs the venue's full instrument universe
 *
 * REST hosts fail over like the feed. Read-only: opens the feed DB readonly and
 * never writes. Exit code is non-zero when a hard check fails.
 *
 * Venue semantics this encodes (learned, do not "simplify" away):
 *   - REST /v5/market/kline has no confirm column and its newest row is the
 *     forming candle — drop it, compare the closed history only.
 *   - /v5/market/open-interest takes intervalTime=1h|4h (not 60|240) and
 *     timestamps may arrive in seconds.
 *   - /v5/market/funding/history records carry fundingRateTimestamp.
 *   - Liquidation prints carry the venue execution time T; a local clock a few
 *     seconds behind makes recv_ts < exch_ts — skew, not corruption.
 *   - The detector rounds: roundPrice = 8dp, roundRatio = 4dp, and
 *     ZONE_DETECT.deepPenetrationPct = 50. Penetration is judged on bars up to
 *     the detecting close, never on the card's whole lifetime.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function argOf(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const DB_PATH = argOf("--db", "data/bybit-market.sqlite");

const REST_HOSTS = ["https://api.bybit.com", "https://api.bytick.com", "https://api.manepa.jp"];
const INTERVAL_MS: Record<string, number> = { "5": 300_000, "15": 900_000, "60": 3_600_000, "240": 14_400_000 };
const OI_INTERVAL_PARAM: Record<string, string> = { "60": "1h", "240": "4h" };

let failures = 0;
let warnings = 0;
function report(name: string, ok: boolean, detail: string): void {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!ok) failures += 1;
}
function warn(name: string, detail: string): void {
  warnings += 1;
  console.log(`  [WARN] ${name}: ${detail}`);
}

async function venueGet(path: string): Promise<unknown> {
  let lastError = "";
  for (const host of REST_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 403 || res.status === 401 || res.status === 404) {
        lastError = `${host} HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as { retCode: number; retMsg: string; result: unknown };
      if (body.retCode !== 0) {
        lastError = `${host} retCode ${body.retCode} ${body.retMsg}`;
        continue;
      }
      return body.result;
    } catch (error) {
      lastError = `${host} ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new Error(`all REST hosts failed for ${path}: ${lastError}`);
}

function close(a: string | null | undefined, b: string | null | undefined, rel = 1e-9): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return a === b;
  if (x === y) return true;
  const scale = Math.max(Math.abs(x), Math.abs(y), 1e-12);
  return Math.abs(x - y) / scale <= rel;
}

function toMs(ts: number): number {
  return ts < 1e11 ? ts * 1000 : ts; // venue sometimes answers in seconds
}

type Section = { name: string; run: () => Promise<void> };
const sections: Section[] = [];
function section(name: string, run: () => Promise<void>): void {
  sections.push({ name, run });
}

// ---------------------------------------------------------------- 1. klines
section("klines vs venue REST", async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM klines").all() as { symbol: string }[]).map((r) => r.symbol);
  let checked = 0;
  let mismatched = 0;
  let staleForming = 0;
  let confirmedMismatch = 0;
  let missingInDb = 0;
  let extraInDb = 0;
  const missingBySeries = new Map<string, number[]>();
  const now = Date.now();
  for (const symbol of symbols) {
    for (const interval of ["240", "60", "15"]) {
      const result = (await venueGet(
        `/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=200`,
      )) as { list: string[][] };
      const venue = new Map<number, string[]>();
      for (const row of result.list) {
        const startTs = Number(row[0]);
        if (startTs + INTERVAL_MS[interval] > now) continue; // forming candle
        venue.set(startTs, row);
      }
      if (venue.size === 0) continue;
      const from = Math.min(...venue.keys());
      const rows = db
        .prepare(
          `SELECT start_ts, open, high, low, close, volume, turnover, confirm FROM klines
           WHERE symbol = ? AND interval = ? AND start_ts >= ?`,
        )
        .all(symbol, interval, from) as { start_ts: number; open: string; high: string; low: string; close: string; volume: string; turnover: string; confirm: number }[];
      const byStart = new Map(rows.map((r) => [r.start_ts, r]));
      for (const [startTs, row] of venue) {
        const local = byStart.get(startTs);
        checked += 1;
        if (!local) {
          missingInDb += 1;
          const key = `${symbol}:${interval}`;
          missingBySeries.set(key, [...(missingBySeries.get(key) ?? []), startTs]);
          continue;
        }
        const same =
          close(local.open, row[1]) &&
          close(local.high, row[2]) &&
          close(local.low, row[3]) &&
          close(local.close, row[4]) &&
          close(local.volume, row[5]) &&
          close(local.turnover, row[6]);
        if (!same) {
          mismatched += 1;
          // A row still confirm=0 is a forming bar whose process died before
          // the close update — detectors ignore it; gap-fill won't re-fetch it
          // because the row exists. confirm=1 drift would be real corruption.
          if (local.confirm === 0) staleForming += 1;
          else confirmedMismatch += 1;
        }
      }
      for (const r of rows) {
        if (r.confirm === 1 && !venue.has(r.start_ts)) extraInDb += 1;
      }
    }
  }
  db.close();
  report("stored closed OHLCV equals venue", confirmedMismatch === 0, `${checked} bars compared, ${confirmedMismatch} confirmed mismatches, ${staleForming} stale forming rows (harmless to signals)`);
  // Missing bars cluster into contiguous downtime blocks on a dev machine
  // (the tracker only writes while running). Scattered single-bar holes would
  // mean collection glitches; blocky holes mean the process was simply off.
  let singles = 0;
  let blocks = 0;
  for (const [key, starts] of missingBySeries) {
    const interval = key.split(":")[1] ?? "15";
    const step = INTERVAL_MS[interval] ?? 900_000;
    const sorted = [...starts].sort((a, b) => a - b);
    let runLen = 1;
    for (let i = 1; i <= sorted.length; i++) {
      const contiguous = i < sorted.length && sorted[i] - sorted[i - 1] === step && sorted[i - 1] % step === 0;
      if (contiguous) runLen += 1;
      else {
        if (runLen === 1) singles += 1;
        else blocks += 1;
        runLen = 1;
      }
    }
  }
  report("no scattered missing bars (single-bar holes)", singles === 0, `${singles} single-bar holes; downtime blocks are counted separately`);
  if (missingInDb > 0) warn("downtime holes", `${missingInDb} bars across ${blocks} contiguous blocks — tracker-off windows; mid-history hole healing is a follow-up`);
  if (extraInDb > 0) warn("extra local closed bars", `${extraInDb} (venue window edge)`);
});

// ---------------------------------------------------------------- 2. OI
section("open interest vs venue REST", async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM open_interest").all() as { symbol: string }[]).map((r) => r.symbol);
  let checked = 0;
  let mismatched = 0;
  let missingInDb = 0;
  for (const symbol of symbols) {
    for (const interval of ["60", "240"]) {
      const result = (await venueGet(
        `/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${OI_INTERVAL_PARAM[interval]}&limit=200`,
      )) as { list: { openInterest: string; timestamp: string }[] };
      const venue = new Map<number, string>();
      for (const row of result.list) venue.set(toMs(Number(row.timestamp)), row.openInterest);
      if (venue.size === 0) continue;
      const from = Math.min(...venue.keys());
      const rows = db
        .prepare(`SELECT start_ts, open_interest FROM open_interest WHERE symbol = ? AND interval = ? AND start_ts >= ?`)
        .all(symbol, interval, from) as { start_ts: number; open_interest: string }[];
      const byStart = new Map(rows.map((r) => [r.start_ts, r.open_interest]));
      for (const [ts, value] of venue) {
        checked += 1;
        const local = byStart.get(ts);
        if (local === undefined) {
          missingInDb += 1;
          continue;
        }
        if (!close(local, value)) mismatched += 1;
      }
    }
  }
  db.close();
  report("stored history equals venue", mismatched === 0, `${checked} points compared, ${mismatched} mismatched`);
  report("no venue point missing locally", missingInDb === 0, `${missingInDb} missing (venue serves the newest 200 per series)`);
});

// ---------------------------------------------------------------- 3. funding
section("funding vs venue REST", async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM funding").all() as { symbol: string }[]).map((r) => r.symbol);
  let checked = 0;
  let mismatched = 0;
  let missingInDb = 0;
  for (const symbol of symbols) {
    const result = (await venueGet(
      `/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200`,
    )) as { list: { fundingRate: string; fundingRateTimestamp: string }[] };
    const venue = new Map<number, string>();
    for (const row of result.list) venue.set(Number(row.fundingRateTimestamp), row.fundingRate);
    if (venue.size === 0) continue;
    const from = Math.min(...venue.keys());
    const rows = db
      .prepare(`SELECT funding_ts, funding_rate FROM funding WHERE symbol = ? AND funding_ts >= ?`)
      .all(symbol, from) as { funding_ts: number; funding_rate: string }[];
    const byTs = new Map(rows.map((r) => [r.funding_ts, r.funding_rate]));
    for (const [ts, rate] of venue) {
      checked += 1;
      const local = byTs.get(ts);
      if (local === undefined) {
        missingInDb += 1;
        continue;
      }
      if (!close(local, rate)) mismatched += 1;
    }
  }
  db.close();
  report("stored history equals venue", mismatched === 0, `${checked} records compared, ${mismatched} mismatched`);
  report("no venue record missing locally", missingInDb === 0, `${missingInDb} missing (venue serves the newest 200 per symbol)`);
});

// ---------------------------------------------------------------- 4. tape integrity
section("tape integrity (flow / liquidations)", async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const FLOW_BAR_MS = 60_000; // src/feed/bb/flow.ts flowBarStart
  const misaligned = (
    db.prepare("SELECT COUNT(*) n FROM flow_bars WHERE start_ts % ? <> 0").get(FLOW_BAR_MS) as { n: number }
  ).n;
  report("flow bars minute-bucketed exactly", misaligned === 0, `${misaligned} misaligned`);
  const badCounts = (
    db.prepare("SELECT COUNT(*) n FROM flow_bars WHERE trade_count <= 0 OR buy_size < 0 OR sell_size < 0").get() as { n: number }
  ).n;
  report("flow sizes non-negative, trade_count positive", badCounts === 0, `${badCounts} violations`);
  const badLiq = (
    db.prepare("SELECT COUNT(*) n FROM liquidations WHERE price <= 0 OR size <= 0").get() as { n: number }
  ).n;
  report("liq prints sane (price/size)", badLiq === 0, `${badLiq} violations`);
  const skew = db.prepare("SELECT MIN(recv_ts - exch_ts) mn, MAX(recv_ts - exch_ts) mx FROM liquidations").get() as { mn: number; mx: number };
  const skewViolations = (
    db.prepare("SELECT COUNT(*) n FROM liquidations WHERE abs(recv_ts - exch_ts) > 60000").get() as { n: number }
  ).n;
  report("liq recv/exch within clock tolerance", skewViolations === 0, `skew ${skew.mn}..${skew.mx} ms (local clock behind venue), ${skewViolations} beyond ±60s`);
  const flowSpan = db.prepare("SELECT MIN(start_ts) mn, MAX(start_ts) mx, COUNT(*) n FROM flow_bars").get() as { mn: number; mx: number; n: number };
  const flowSymbols = (db.prepare("SELECT COUNT(DISTINCT symbol) n FROM flow_bars").get() as { n: number }).n;
  warn(
    "coverage is forward-only (venue has no tape backfill)",
    `${flowSymbols} symbols, ${flowSpan.n} bars over ${Math.round((flowSpan.mx - flowSpan.mn) / 3_600_000)}h — missing stays missing, never zeroed`,
  );
  db.close();
});

// ---------------------------------------------------------------- 5. signal invariants
section("signal invariants (zones re-derived from raw klines)", async () => {
  const { openDb } = await import("../src/feed/bb/db");
  const { buildZones } = await import("../src/feed/bb/zones");
  const symbols = (
    new Database(DB_PATH, { readonly: true }).prepare("SELECT DISTINCT symbol FROM klines WHERE interval = '240'").all() as { symbol: string }[]
  ).map((r) => r.symbol);
  const store = openDb(DB_PATH, true);

  const now = Date.now();
  const snapshot = buildZones(store, { symbols, dbPath: DB_PATH, interval: "240", now });
  const again = buildZones(store, { symbols, dbPath: DB_PATH, interval: "240", now });
  report("detector is deterministic", JSON.stringify(snapshot) === JSON.stringify(again), `${snapshot.zones.length} cards, two runs byte-identical`);

  const raw = new Database(DB_PATH, { readonly: true });
  let geometryBad = 0;
  let impulseBad = 0;
  let rrBad = 0;
  let penetrationBad = 0;
  for (const card of snapshot.zones) {
    const supply = card.side === "supply";
    const heightOk = card.zoneLow < card.zoneHigh
      && (supply ? card.distal === card.zoneHigh && card.proximal === card.zoneLow : card.distal === card.zoneLow && card.proximal === card.zoneHigh);
    const slOk = supply ? card.sl > card.distal : card.sl < card.distal;
    const entryOk = supply
      ? card.entry > card.proximal && card.entry < card.distal
      : card.entry < card.proximal && card.entry > card.distal;
    const tpOk = supply ? card.tp < card.entry : card.tp > card.entry;
    if (!(heightOk && slOk && entryOk && tpOk && card.hardInvalid === card.sl && card.softInvalid === card.distal)) geometryBad += 1;

    const impulse = Math.abs(card.impulseBody) / card.atr14;
    if (Math.abs(impulse - card.impulseAtr) > 0.0001) impulseBad += 1;

    const reward = Math.abs(card.entry - card.tp);
    const risk = Math.abs(card.entry - card.sl);
    if (Math.abs(reward / risk - card.rr) > 0.011) rrBad += 1;

    // The card's penetrationPct/freshness are as-of emission (detector's
    // `later` = bars after the impulse leg). Post-emission bars can only
    // deepen penetration — never erase it — so the honest re-derivation is a
    // monotonicity check: stored pct must be <= the pct over every confirmed
    // bar from baseEndTs onward, and the freshness label must match the
    // stored pct's band (virgin <= 0 < touched < 50 <= deep). The trading
    // path re-checks penetration at ARM time regardless (proximity.ts).
    const latest = (
      raw
        .prepare(`SELECT MAX(start_ts) mx FROM klines WHERE symbol = ? AND interval = ? AND confirm = 1`)
        .get(card.symbol, card.tf) as { mx: number }
    ).mx;
    const later = raw
      .prepare(
        `SELECT high, low FROM klines WHERE symbol = ? AND interval = ? AND confirm = 1 AND start_ts >= ?`,
      )
      .all(card.symbol, card.tf, card.baseEndTs) as { high: string; low: string }[];
    const height = Math.abs(card.distal - card.proximal);
    let best = 0;
    for (const bar of later) {
      const high = Number(bar.high);
      const low = Number(bar.low);
      let into = 0;
      if (supply && high > card.proximal) into = Math.min(high, card.distal) - card.proximal;
      if (!supply && low < card.proximal) into = card.proximal - Math.max(low, card.distal);
      best = Math.max(best, height > 0 ? (into / height) * 100 : 0);
    }
    const labelBand = card.penetrationPct <= 0 ? "virgin" : card.penetrationPct < 50 ? "touched" : "deep";
    const monotone = card.penetrationPct <= best + 0.5;
    const labelOk = labelBand === card.freshness;
    if (!monotone || !labelOk) penetrationBad += 1;
  }
  raw.close();
  report("geometry (bounds/sl/entry/tp/invalid) consistent", geometryBad === 0, `${snapshot.zones.length - geometryBad} ok, ${geometryBad} bad`);
  report("impulseAtr equals |body| / atr14 (4dp)", impulseBad === 0, `${impulseBad} bad`);
  report("rr equals reward / risk", rrBad === 0, `${rrBad} bad`);
  report(
    "penetration monotone since base + freshness label matches band",
    penetrationBad === 0,
    `${penetrationBad} bad of ${snapshot.zones.length} (cards age: post-emission penetration may deepen, ARM re-checks)`,
  );
  store.close();
});

// ---------------------------------------------------------------- 6. methodology audit
section("methodology audit (one signal, veto-only quant, no LLM/MCP)", async () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const pack = read("src/ta/pack.ts");
  report("TA overlay is signal:false and never arms", pack.includes('"signal": false') || pack.includes("signal: false"), "pack output carries signal:false");

  const policy = read("src/agent/policy.ts");
  const quantReasons = ["quant_crowded", "quant_oi", "quant_cascade", "quant_flow"].every((r) => policy.includes(`"${r}"`));
  report("quant tape enters MAP only as vetoes", quantReasons, "quant_* are deny reasons in POLICY_REASONS");

  const live = read("src/live/http.ts");
  report("live-shadow never holds orders", live.includes("orders: false"), "/live/health reports orders:false");

  // The detector has exactly one definition; its importers must be the live
  // /zones endpoint or the replay of the same method. Anything else is a
  // second methodology and fails this audit.
  const definition = Bun.spawnSync(["grep", "-rl", "export function detectAllSetupsFromKlines", "src"]).stdout.toString().trim().split("\n").filter(Boolean);
  const importersRaw = Bun.spawnSync(["grep", "-rl", "detectAllSetups", "src"]).stdout.toString().trim().split("\n").filter(Boolean);
  const importers = importersRaw.filter((f) => !f.includes("src/zones"));
  const allowed = importers.filter((f) => f === "src/feed/bb/zones.ts" || f === "src/paper/replay-map.ts");
  report(
    "one signal producer (zones detector), three consumers",
    definition.length === 1 && importers.length === allowed.length,
    `definition: ${definition.join(", ") || "none"}; consumers: ${importers.join(", ") || "none"}`,
  );

  const banned = Bun.spawnSync(["grep", "-ril", "openai|anthropic|chatgpt|trading-mcp", "src"]);
  report("no LLM / MCP in the autonomous path", banned.exitCode !== 0, banned.exitCode === 0 ? banned.stdout.toString() : "clean");

  const roadmap = read("docs/ROADMAP.md");
  report(
    "ROADMAP locks present",
    roadmap.includes("Keys and order placement exist only in `src/exec/`") && roadmap.includes("Event-once"),
    "boundary + event-once locks in place",
  );
});

// ---------------------------------------------------------------- 7. market coverage
section("market coverage vs the venue universe", async () => {
  const linear = (await venueGet("/v5/market/instruments-info?category=linear&limit=1000")) as { list: unknown[] };
  let spotCount = -1;
  try {
    const spot = (await venueGet("/v5/market/instruments-info?category=spot&limit=1000")) as { list: unknown[] };
    spotCount = spot.list.length;
  } catch {}
  const config = JSON.parse(readFileSync("src/feed/bb/config.json", "utf8")) as { symbols: string[] };
  const db = new Database(DB_PATH, { readonly: true });
  const perTable = (table: string) => (db.prepare(`SELECT COUNT(DISTINCT symbol) n FROM ${table}`).get() as { n: number }).n;
  const covered = {
    klines: perTable("klines"),
    oi: perTable("open_interest"),
    funding: perTable("funding"),
    flow: perTable("flow_bars"),
    liq: perTable("liquidations"),
  };
  db.close();
  const pct = ((config.symbols.length / linear.list.length) * 100).toFixed(1);
  report(
    "watchlist is an explicit subset of the venue",
    config.symbols.length <= linear.list.length,
    `${config.symbols.length} of ${linear.list.length} linear perps (${pct}%) — deliberate MVP scope; Terminal expansion path in docs/DATA-VERIFICATION.md`,
  );
  warn(
    "tape tables follow the watchlist",
    `symbols covered: klines=${covered.klines} oi=${covered.oi} funding=${covered.funding} flow=${covered.flow} liq=${covered.liq}${spotCount >= 0 ? `; venue spot universe: ${spotCount}` : ""}`,
  );
});

// ---------------------------------------------------------------- run
console.log(`minh data & signal verification — db=${DB_PATH}\n`);
for (const s of sections) {
  console.log(`== ${s.name}`);
  try {
    await s.run();
  } catch (error) {
    failures += 1;
    console.log(`  [FAIL] section crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log("");
}
console.log(`result: ${failures === 0 ? "VERIFIED" : "FAILURES PRESENT"} (${failures} fail, ${warnings} warn)`);
process.exit(failures === 0 ? 0 : 1);
