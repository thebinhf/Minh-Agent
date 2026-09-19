import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCorpusSummary,
  ingestDecisionFile,
  openCorpusDb,
  summarizeCorpus,
} from "../../src/agent/corpus";
import { parseAgentArgs } from "../../src/agent/cli";
import type { DecisionRecord } from "../../src/agent/decision-log";

const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "minh-corpus-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // EBUSY on Windows teardown — leave the temp dir for the OS to clean.
    }
  }
});

function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    v: 1,
    asof: 1_789_000_000_000,
    symbol: "BTCUSDT",
    zoneId: "btc-4h-s-1",
    side: "supply",
    setup: "sd",
    tf: "240",
    rr: 2,
    freshness: "virgin",
    impulseAtr: 1.4,
    biasHtf: "chop",
    bias4h: "chop",
    bias1h: "bull",
    last: 61000,
    crowded: null,
    oiReading: null,
    cascadeActive: null,
    cascadeSide: null,
    flowReading: null,
    familyScore: null,
    familyTrades: null,
    familyAvgRealizedRr: null,
    allow: false,
    reason: "bias_chop",
    ...over,
  };
}

describe("decision corpus", () => {
  test("ingest is idempotent and counts by reason, setup and tape coverage", async () => {
    const dir = tempRoot();
    const path = join(dir, "decisions.jsonl");
    const rows = [
      record(),
      record({ zoneId: "eth-4h-d-bo-1", symbol: "ETHUSDT", side: "demand", setup: "breakout", allow: true, reason: "ok", asof: 1_789_003_600_000 }),
      record({ zoneId: "sol-4h-d-1", symbol: "SOLUSDT", side: "demand", flowReading: "sell_dom", oiReading: "long_add" }),
    ];
    await Bun.write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}
not-a-record
${JSON.stringify(rows[1])}
`);

    const corpus = openCorpusDb(join(dir, "decisions.sqlite"));
    try {
      const first = await ingestDecisionFile(corpus, path);
      expect(first.lines).toBeGreaterThanOrEqual(5);
      expect(first.parsed).toBe(4);
      expect(first.inserted).toBe(3);
      expect(first.skippedUnparseable).toBe(1);
      const again = await ingestDecisionFile(corpus, path);
      expect(again.parsed).toBe(4);
      expect(again.inserted).toBe(0);
      expect(again.verdictConflicts).toBe(0);

      const summary = summarizeCorpus(corpus, 400);
      expect(summary.rows).toBe(3);
      expect(summary.totalRows).toBe(3);
      expect(summary.cards).toBe(3);
      expect(summary.accepted).toBe(1);
      expect(summary.acceptRate).toBe("0.3333");
      expect(summary.byReason.map((row) => `${row.reason}=${row.n}`)).toEqual(["bias_chop=2", "ok=1"]);
      expect(summary.bySetup.map((row) => `${row.setup}=${row.n}/${row.accepted}`).sort())
        .toEqual(["breakout=1/1", "sd=2/0"]);
      expect(summary.tape.flowKnown).toBe(1);
      expect(summary.tape.flowMissing).toBe(2);
      expect(summary.tape.oiKnown).toBe(1);
      expect(summary.tape.cascadeKnown).toBe(0);

      const text = formatCorpusSummary(summary);
      expect(text).toContain("corpus rows=3");
      expect(text).toContain("flow 1 known / 2 missing");
      expect(text).not.toMatch(/\b(undefined|NaN)\b/);
    } finally {
      corpus.close();
    }
  });

  test("the same card at a later close is a new row, not an overwrite", async () => {
    const dir = tempRoot();
    const path = join(dir, "d.jsonl");
    await Bun.write(path, [
      JSON.stringify(record()),
      JSON.stringify(record({ asof: 1_789_086_400_000, allow: true, reason: "ok" })),
    ].join("\n"));
    const corpus = openCorpusDb(join(dir, "decisions.sqlite"));
    try {
      expect((await ingestDecisionFile(corpus, path)).inserted).toBe(2);
      const summary = summarizeCorpus(corpus, 400);
      expect(summary.rows).toBe(2);
      expect(summary.cards).toBe(1);
    } finally {
      corpus.close();
    }
  });

  test("a second flag arm in one db is reported, not silently dropped", async () => {
    const dir = tempRoot();
    const base = join(dir, "base.jsonl");
    const variant = join(dir, "variant.jsonl");
    await Bun.write(base, `${JSON.stringify(record())}\n`);
    // Same card, same close, flipped by the flag under test.
    await Bun.write(variant, `${JSON.stringify(record({ allow: true, reason: "ok" }))}\n`);
    const corpus = openCorpusDb(join(dir, "decisions.sqlite"));
    try {
      await ingestDecisionFile(corpus, base);
      const second = await ingestDecisionFile(corpus, variant);
      expect(second.parsed).toBe(1);
      expect(second.inserted).toBe(0);
      expect(second.verdictConflicts).toBe(1);
      const summary = summarizeCorpus(corpus, 400);
      expect(summary.rows).toBe(1);
      // The db kept the first arm's deny — the warning is what makes that visible.
      expect(summary.byReason.map((row) => row.reason)).toEqual(["bias_chop"]);
    } finally {
      corpus.close();
    }
  });

  test("a replay-dated corpus still summarizes at the default window", async () => {
    const dir = tempRoot();
    const path = join(dir, "d.jsonl");
    // An 180d walk is written today and labels every row with a past close. A
    // wall-clock window reads that as an empty corpus and prints 0.
    const newest = Date.now() - 30 * 86_400_000;
    const oldest = newest - 150 * 86_400_000;
    await Bun.write(path, [
      JSON.stringify(record({ zoneId: "btc-old", asof: oldest })),
      JSON.stringify(record({ zoneId: "eth-mid", asof: newest - 60 * 86_400_000, allow: true, reason: "ok" })),
      JSON.stringify(record({ zoneId: "sol-new", asof: newest, allow: true, reason: "ok" })),
    ].join("\n"));
    const corpus = openCorpusDb(join(dir, "decisions.sqlite"));
    try {
      await ingestDecisionFile(corpus, path);
      const summary = summarizeCorpus(corpus, 90);
      expect(summary.rows).toBe(2);
      expect(summary.totalRows).toBe(3);
      expect(summary.accepted).toBe(2);
      expect(formatCorpusSummary(summary)).toContain("rows=2/3 in db");
      expect(summarizeCorpus(corpus, 200).rows).toBe(3);
    } finally {
      corpus.close();
    }
  });
});

describe("agent cli args", () => {
  test("defaults, overrides, and rejects a nonsense window", () => {
    expect(parseAgentArgs([])).toEqual({ name: "help", file: null, db: null, days: 90, json: false });
    expect(parseAgentArgs(["corpus", "--days", "180", "--json"])).toMatchObject({
      name: "corpus", days: 180, json: true,
    });
    expect(parseAgentArgs(["corpus", "--file", "a.jsonl", "--db", "b.sqlite"])).toMatchObject({
      file: "a.jsonl", db: "b.sqlite",
    });
    expect(() => parseAgentArgs(["corpus", "--days", "0"])).toThrow("--days");
    expect(() => parseAgentArgs(["corpus", "--post", "arm"])).toThrow("unknown argument");
  });
});
