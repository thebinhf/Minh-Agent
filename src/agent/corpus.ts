import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { parseDecisionLine, type DecisionRecord } from "./decision-log";

/**
 * The decision corpus: every MAP evaluation, with the as-of features that
 * produced it, queryable instead of grepped.
 *
 * It exists because a live host emits a few hundred labels a month — under the
 * ~9.5-trades-per-month ceiling of this method there is no statistical answer at
 * that rate. `replay-map` walks 180 days of closes through the same policy, so
 * the corpus is built from walks and read the same way either way.
 */

export const DEFAULT_CORPUS_DB = "./data/decisions.sqlite";

export function corpusDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MINH_DECISION_DB?.trim() || DEFAULT_CORPUS_DB);
}

export function openCorpusDb(path: string) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      asof INTEGER NOT NULL,
      zone_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      tf TEXT NOT NULL,
      side TEXT NOT NULL,
      setup TEXT NOT NULL,
      rr REAL,
      freshness TEXT,
      impulse_atr REAL,
      bias_htf TEXT,
      bias_240 TEXT,
      bias_60 TEXT,
      last REAL,
      crowded TEXT,
      oi_reading TEXT,
      cascade_active INTEGER,
      cascade_side TEXT,
      flow_reading TEXT,
      family_score TEXT,
      family_trades INTEGER,
      family_avg_rr TEXT,
      allow INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (asof, zone_id)
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_reason ON decisions(reason, asof);
    CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol, asof);
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO decisions (
      asof, zone_id, symbol, tf, side, setup, rr, freshness, impulse_atr,
      bias_htf, bias_240, bias_60, last, crowded, oi_reading, cascade_active,
      cascade_side, flow_reading, family_score, family_trades, family_avg_rr,
      allow, reason
    ) VALUES (
      $asof, $zone_id, $symbol, $tf, $side, $setup, $rr, $freshness, $impulse_atr,
      $bias_htf, $bias_240, $bias_60, $last, $crowded, $oi_reading, $cascade_active,
      $cascade_side, $flow_reading, $family_score, $family_trades, $family_avg_rr,
      $allow, $reason
    )
  `);
  return {
    db,
    upsert(row: DecisionRecord): "new" | "same" | "conflict" {
      const allow = row.allow ? 1 : 0;
      const prior = db
        .prepare("SELECT allow, reason FROM decisions WHERE asof = ? AND zone_id = ?")
        .get(row.asof, row.zoneId) as { allow: number; reason: string } | null;
      insert.run({
        $asof: row.asof,
        $zone_id: row.zoneId,
        $symbol: row.symbol,
        $tf: row.tf,
        $side: row.side,
        $setup: row.setup,
        $rr: Number.isFinite(row.rr) ? row.rr : null,
        $freshness: row.freshness,
        $impulse_atr: Number.isFinite(row.impulseAtr) ? row.impulseAtr : null,
        $bias_htf: row.biasHtf,
        $bias_240: row.bias4h,
        $bias_60: row.bias1h,
        $last: Number.isFinite(row.last) ? row.last : null,
        $crowded: row.crowded,
        $oi_reading: row.oiReading,
        $cascade_active: row.cascadeActive === null ? null : row.cascadeActive ? 1 : 0,
        $cascade_side: row.cascadeSide,
        $flow_reading: row.flowReading,
        $family_score: row.familyScore,
        $family_trades: row.familyTrades,
        $family_avg_rr: row.familyAvgRealizedRr,
        $allow: allow,
        $reason: row.reason,
      });
      if (!prior) return "new";
      return prior.allow === allow && prior.reason === row.reason ? "same" : "conflict";
    },
    close: () => db.close(),
  };
}

export type CorpusIngest = {
  file: string;
  lines: number;
  parsed: number;
  inserted: number;
  skippedUnparseable: number;
  /**
   * Keys already in the DB that carry a *different* verdict. That is a second
   * flag arm replayed into one DB: the earlier row stays, so the summary would
   * silently describe only the first walk. Say it out loud and point at `--db`.
   */
  verdictConflicts: number;
};

export async function ingestDecisionFile(corpus: ReturnType<typeof openCorpusDb>, path: string): Promise<CorpusIngest> {
  const text = await Bun.file(path).text();
  const rows = text.split(/\r?\n/);
  let parsed = 0;
  let inserted = 0;
  let conflicts = 0;
  let bad = 0;
  for (const line of rows) {
    if (!line.trim()) continue;
    const record = parseDecisionLine(line);
    if (!record) {
      bad += 1;
      continue;
    }
    parsed += 1;
    const result = corpus.upsert(record);
    if (result === "new") inserted += 1;
    else if (result === "conflict") conflicts += 1;
  }
  return { file: path, lines: rows.length, parsed, inserted, skippedUnparseable: bad, verdictConflicts: conflicts };
}

export type CorpusSummary = {
  rows: number;
  totalRows: number;
  cards: number;
  windowDays: number;
  firstAsof: number | null;
  lastAsof: number | null;
  spanDays: number | null;
  accepted: number;
  acceptRate: string;
  byReason: Array<{ reason: string; n: number }>;
  bySetup: Array<{ setup: string; n: number; accepted: number }>;
  bySide: Array<{ side: string; n: number; accepted: number }>;
  byFreshness: Array<{ freshness: string; n: number; accepted: number }>;
  byBias: Array<{ bias: string; n: number; accepted: number }>;
  bySymbol: Array<{ symbol: string; n: number; accepted: number }>;
  /** Missing tape is reported, never counted as absence of signal. */
  tape: { flowKnown: number; flowMissing: number; oiKnown: number; oiMissing: number; cascadeKnown: number };
};

function group(db: Database, sql: string, since: number): Array<Record<string, unknown>> {
  return db.prepare(sql).all(since) as Array<Record<string, unknown>>;
}

export function summarizeCorpus(corpus: ReturnType<typeof openCorpusDb>, days = 90): CorpusSummary {
  const db = corpus.db;
  // Anchored on the newest decision, not the wall clock: a replay walk labels its
  // rows with past 4H closes, so `Date.now() - 90d` would empty a corpus built a
  // second ago and print "nothing to see" for a corpus that is full.
  const newest = (db.prepare(`SELECT MAX(asof) AS m, COUNT(*) AS n FROM decisions`).get() as { m: number | null; n: number });
  const since = (newest.m ?? 0) - days * 86_400_000;
  const totals = db.prepare(
    `SELECT COUNT(*) n, COUNT(DISTINCT zone_id) cards, MIN(asof) first, MAX(asof) last,
            COALESCE(SUM(allow),0) accepted FROM decisions WHERE asof >= ?`,
  ).get(since) as { n: number; cards: number; first: number | null; last: number | null; accepted: number };
  const tape = db.prepare(
    `SELECT COALESCE(SUM(flow_reading IS NOT NULL),0) flow_known, COALESCE(SUM(flow_reading IS NULL),0) flow_missing,
            COALESCE(SUM(oi_reading IS NOT NULL),0) oi_known, COALESCE(SUM(oi_reading IS NULL),0) oi_missing,
            COALESCE(SUM(cascade_active IS NOT NULL),0) cascade_known
     FROM decisions WHERE asof >= ?`,
  ).get(since) as { flow_known: number; flow_missing: number; oi_known: number; oi_missing: number; cascade_known: number };
  return {
    rows: totals.n,
    totalRows: newest.n,
    cards: totals.cards,
    windowDays: days,
    firstAsof: totals.first,
    lastAsof: totals.last,
    spanDays: totals.first && totals.last ? Math.round(((totals.last - totals.first) / 86_400_000) * 10) / 10 : null,
    accepted: totals.accepted,
    acceptRate: totals.n ? (totals.accepted / totals.n).toFixed(4) : "0",
    byReason: group(db, `SELECT reason, COUNT(*) n FROM decisions WHERE asof >= ? GROUP BY reason ORDER BY n DESC`, since)
      .map((row) => ({ reason: String(row.reason), n: Number(row.n) })),
    bySetup: group(db, `SELECT setup, COUNT(*) n, SUM(allow) a FROM decisions WHERE asof >= ? GROUP BY setup ORDER BY n DESC`, since)
      .map((row) => ({ setup: String(row.setup), n: Number(row.n), accepted: Number(row.a ?? 0) })),
    bySide: group(db, `SELECT side, COUNT(*) n, SUM(allow) a FROM decisions WHERE asof >= ? GROUP BY side ORDER BY n DESC`, since)
      .map((row) => ({ side: String(row.side), n: Number(row.n), accepted: Number(row.a ?? 0) })),
    byFreshness: group(db, `SELECT freshness, COUNT(*) n, SUM(allow) a FROM decisions WHERE asof >= ? GROUP BY freshness ORDER BY n DESC`, since)
      .map((row) => ({ freshness: String(row.freshness ?? "?"), n: Number(row.n), accepted: Number(row.a ?? 0) })),
    byBias: group(db, `SELECT bias_htf bias, COUNT(*) n, SUM(allow) a FROM decisions WHERE asof >= ? GROUP BY bias_htf ORDER BY n DESC`, since)
      .map((row) => ({ bias: String(row.bias ?? "?"), n: Number(row.n), accepted: Number(row.a ?? 0) })),
    bySymbol: group(db, `SELECT symbol, COUNT(*) n, SUM(allow) a FROM decisions WHERE asof >= ? GROUP BY symbol ORDER BY a DESC, n DESC LIMIT 12`, since)
      .map((row) => ({ symbol: String(row.symbol), n: Number(row.n), accepted: Number(row.a ?? 0) })),
    tape: {
      flowKnown: tape.flow_known,
      flowMissing: tape.flow_missing,
      oiKnown: tape.oi_known,
      oiMissing: tape.oi_missing,
      cascadeKnown: tape.cascade_known,
    },
  };
}

export function formatCorpusSummary(summary: CorpusSummary): string {
  const lines: string[] = [];
  const day = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : "—");
  const span = summary.spanDays === null ? "—" : `${summary.spanDays}d`;
  const cut = summary.rows === summary.totalRows ? "" : `/${summary.totalRows} in db`;
  lines.push(
    `corpus rows=${summary.rows}${cut} cards=${summary.cards} window=${summary.windowDays}d`
    + ` ${day(summary.firstAsof)}→${day(summary.lastAsof)} (${span})`
    + ` accept=${summary.accepted} (${summary.acceptRate})`,
  );
  lines.push(`reasons   ${summary.byReason.map((row) => `${row.reason}=${row.n}`).join(" ") || "—"}`);
  lines.push(`setups    ${summary.bySetup.map((row) => `${row.setup}=${row.n}/${row.accepted}`).join(" ") || "—"}`);
  lines.push(`sides     ${summary.bySide.map((row) => `${row.side}=${row.n}/${row.accepted}`).join(" ") || "—"}`);
  lines.push(`freshness ${summary.byFreshness.map((row) => `${row.freshness}=${row.n}/${row.accepted}`).join(" ") || "—"}`);
  lines.push(`htf bias  ${summary.byBias.map((row) => `${row.bias}=${row.n}/${row.accepted}`).join(" ") || "—"}`);
  lines.push(`top symbols ${summary.bySymbol.slice(0, 6).map((row) => `${row.symbol}=${row.accepted}/${row.n}`).join(" ") || "—"}`);
  lines.push(
    `tape      flow ${summary.tape.flowKnown} known / ${summary.tape.flowMissing} missing`
    + ` · oi ${summary.tape.oiKnown} known / ${summary.tape.oiMissing} missing`
    + ` · cascade ${summary.tape.cascadeKnown} known`,
  );
  return `${lines.join("\n")}\n`;
}
