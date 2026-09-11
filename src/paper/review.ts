import { POLICY_REASONS, type PolicyReason } from "../agent/policy";
import { emptyQuantCoverage, mergeQuantCoverage, type QuantCoverage } from "../features/tape";
import { Dec } from "./decimal";
import { PaperReject } from "./errors";

export type PaperReviewFlag =
  | "hype_accepted"
  | "flow_missing"
  | "cascade_missing"
  | "tape_skipped"
  | "quant_missing"
  | "coverage_absent";

export type PaperReview = {
  mode: "paper";
  review: true;
  source: string;
  replayMap: boolean;
  oneBook: boolean | null;
  days: number | null;
  symbols: string[] | null;
  skipped: Array<{ symbol: string; error: string }>;
  htfBars: number | null;
  ltfBars: number | null;
  ticks: number | null;
  slippage: string | null;
  quant: "asof" | "missing" | null;
  quantCoverage: QuantCoverage | null;
  accepted: number;
  hypeAccepted: number;
  armed: number;
  filled: number | null;
  invalidated: number | null;
  skipReasons: Partial<Record<PolicyReason, number>>;
  cancelCodes: Record<string, number> | null;
  equity: string | null;
  startingCash: string | null;
  realizedPnl: string | null;
  winRate: string | null;
  trades: number | null;
  wins: number | null;
  losses: number | null;
  funnel: unknown;
  families: Array<{
    family: string;
    score: string | null;
    trades: number;
    winRate: string | null;
    avgRealizedRr: string | null;
  }>;
  flags: PaperReviewFlag[];
};

export type PaperAbDelta = {
  accepted: number;
  hypeAccepted: number;
  armed: number;
  filled: number | null;
  invalidated: number | null;
  trades: number | null;
  wins: number | null;
  losses: number | null;
  equity: string | null;
  realizedPnl: string | null;
  skipReasons: Partial<Record<PolicyReason, number>>;
  cancelCodes: Record<string, number>;
  flagsAdded: PaperReviewFlag[];
  flagsRemoved: PaperReviewFlag[];
};

export type PaperAb = {
  mode: "paper";
  ab: true;
  base: PaperReview;
  variant: PaperReview;
  delta: PaperAbDelta;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function countHype(ids: string[]): number {
  return ids.filter((id) => id.toLowerCase().startsWith("hype")).length;
}

function pickSkipReasons(raw: unknown): Partial<Record<PolicyReason, number>> {
  const out: Partial<Record<PolicyReason, number>> = {};
  if (!isRecord(raw)) return out;
  for (const reason of POLICY_REASONS) {
    const n = raw[reason];
    if (typeof n === "number" && n !== 0) out[reason] = n;
  }
  return out;
}

function addSkipReasons(
  out: Partial<Record<PolicyReason, number>>,
  extra: Partial<Record<PolicyReason, number>>,
): void {
  for (const reason of POLICY_REASONS) {
    const n = extra[reason];
    if (typeof n === "number" && n !== 0) out[reason] = (out[reason] ?? 0) + n;
  }
}

function pickCoverage(raw: unknown): QuantCoverage | null {
  if (!isRecord(raw) || typeof raw.samples !== "number") return null;
  const coverage = emptyQuantCoverage();
  coverage.samples = raw.samples;
  for (const key of ["oi", "funding", "flow", "cascade"] as const) {
    const row = raw[key];
    if (!isRecord(row)) continue;
    if (typeof row.ok === "number") coverage[key].ok = row.ok;
    if (typeof row.missing === "number") coverage[key].missing = row.missing;
  }
  return coverage;
}

function familyKeyOf(id: string): string {
  const match = /^([a-z0-9]+)-(4h|1h|15m|5m|d)-(s|d)-/i.exec(id);
  if (!match) return id;
  const side = match[3]!.toLowerCase() === "s" ? "supply" : "demand";
  const tf = match[2]!.toLowerCase() === "4h" ? "240" : match[2]!;
  return `${match[1]!.toUpperCase()}USDT:${tf}:${side}`;
}

function pickSkipped(raw: unknown): Array<{ symbol: string; error: string }> {
  if (!Array.isArray(raw)) return [];
  const skipped: Array<{ symbol: string; error: string }> = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    skipped.push({ symbol: String(row.symbol ?? ""), error: String(row.error ?? "") });
  }
  return skipped;
}

function pickAccepted(folded: Record<string, unknown>): { count: number; hype: number } {
  if (typeof folded.accepted === "number") {
    return {
      count: folded.accepted,
      hype: typeof folded.hypeAccepted === "number" ? folded.hypeAccepted : 0,
    };
  }
  const ids = asStringArray(folded.accepted);
  return { count: ids.length, hype: countHype(ids) };
}

function pickArmed(folded: Record<string, unknown>): number {
  if (typeof folded.armed === "number") return folded.armed;
  return asStringArray(folded.armed).length;
}

function foldWatchlist(body: Record<string, unknown>): Record<string, unknown> {
  const rows = Array.isArray(body.rows) ? body.rows.filter(isRecord) : [];
  if (rows.length === 0) return body;
  const accepted: string[] = [];
  const armed: string[] = [];
  const skipReasons: Partial<Record<PolicyReason, number>> = {};
  const coverage = emptyQuantCoverage();
  let filled = 0;
  let invalidated = 0;
  let htfBars = 0;
  let ltfBars = 0;
  let ticks = 0;
  let quant: "asof" | "missing" = "missing";
  let hasCoverage = false;
  for (const row of rows) {
    accepted.push(...asStringArray(row.accepted));
    armed.push(...asStringArray(row.armed));
    addSkipReasons(skipReasons, pickSkipReasons(row.skipReasons));
    const rowCoverage = pickCoverage(row.quantCoverage);
    if (rowCoverage) {
      mergeQuantCoverage(coverage, rowCoverage);
      hasCoverage = true;
    }
    if (typeof row.filled === "number") filled += row.filled;
    if (typeof row.invalidated === "number") invalidated += row.invalidated;
    if (typeof row.htfBars === "number") htfBars += row.htfBars;
    if (typeof row.ltfBars === "number") ltfBars += row.ltfBars;
    if (typeof row.ticks === "number") ticks += row.ticks;
    if (row.quant === "asof") quant = "asof";
  }
  return {
    ...body,
    accepted,
    armed,
    skipReasons,
    quantCoverage: hasCoverage ? coverage : undefined,
    filled,
    invalidated,
    htfBars,
    ltfBars,
    ticks,
    quant,
    oneBook: false,
  };
}

/**
 * Compact QC table from a `replay-map` JSON body (file or already-parsed).
 * One-book, single-symbol, watchlist `rows[]`, or a prior `paper review` JSON.
 * Does not walk bars. Missing flow/cascade is a flag, not a zero.
 */
export function paperReviewFromReplayMap(body: unknown, source = "json"): PaperReview {
  if (!isRecord(body) || body.replayMap !== true) {
    throw new PaperReject("invalid_review", "review", { source, replayMap: false });
  }
  const folded = Array.isArray(body.rows) ? foldWatchlist(body) : body;
  const accepted = pickAccepted(folded);
  const armed = pickArmed(folded);
  const metrics = isRecord(folded.metrics) ? folded.metrics : null;
  const account = isRecord(folded.account) ? folded.account : null;
  const skipped = pickSkipped(folded.skipped);
  const coverage = pickCoverage(folded.quantCoverage);
  const flags: PaperReviewFlag[] = [];
  if (accepted.hype > 0) flags.push("hype_accepted");
  if (skipped.length > 0) flags.push("tape_skipped");
  if (folded.quant === "missing") flags.push("quant_missing");
  if (!coverage) flags.push("coverage_absent");
  else {
    if (coverage.samples > 0 && coverage.flow.ok === 0) flags.push("flow_missing");
    if (coverage.samples > 0 && coverage.cascade.ok === 0) flags.push("cascade_missing");
  }
  const byFamily = metrics && Array.isArray(metrics.byFamily)
    ? metrics.byFamily
    : (Array.isArray(folded.families) ? folded.families : []);
  const families = byFamily
    .filter(isRecord)
    .map((row) => ({
      family: String(row.family ?? familyKeyOf(String(row.zoneId ?? ""))),
      score: row.score == null ? null : String(row.score),
      trades: typeof row.trades === "number" ? row.trades : 0,
      winRate: row.winRate == null ? null : String(row.winRate),
      avgRealizedRr: row.avgRealizedRr == null ? null : String(row.avgRealizedRr),
    }))
    .sort((a, b) => b.trades - a.trades || a.family.localeCompare(b.family));

  return {
    mode: "paper",
    review: true,
    source,
    replayMap: true,
    oneBook: folded.oneBook === true ? true : folded.oneBook === false ? false : (folded.watchlist === true ? false : null),
    days: typeof folded.days === "number" ? folded.days : null,
    symbols: Array.isArray(folded.symbols)
      ? asStringArray(folded.symbols)
      : typeof folded.symbol === "string" ? [folded.symbol] : null,
    skipped,
    htfBars: typeof folded.htfBars === "number" ? folded.htfBars : null,
    ltfBars: typeof folded.ltfBars === "number" ? folded.ltfBars : null,
    ticks: typeof folded.ticks === "number" ? folded.ticks : null,
    slippage: typeof folded.slippage === "string" ? folded.slippage : null,
    quant: folded.quant === "asof" || folded.quant === "missing" ? folded.quant : null,
    quantCoverage: coverage,
    accepted: accepted.count,
    hypeAccepted: accepted.hype,
    armed,
    filled: typeof folded.filled === "number"
      ? folded.filled
      : (typeof metrics?.funnel === "object" && isRecord(metrics.funnel) && typeof metrics.funnel.filled === "number"
        ? metrics.funnel.filled
        : null),
    invalidated: typeof folded.invalidated === "number" ? folded.invalidated : null,
    skipReasons: pickSkipReasons(folded.skipReasons),
    cancelCodes: metrics && isRecord(metrics.cancelCodes)
      ? Object.fromEntries(
        Object.entries(metrics.cancelCodes).filter(([, n]) => typeof n === "number" && n !== 0),
      ) as Record<string, number>
      : (isRecord(folded.cancelCodes)
        ? Object.fromEntries(
          Object.entries(folded.cancelCodes).filter(([, n]) => typeof n === "number" && n !== 0),
        ) as Record<string, number>
        : null),
    equity: account && account.equity != null
      ? String(account.equity)
      : (folded.equity != null ? String(folded.equity) : null),
    startingCash: account && account.startingCash != null
      ? String(account.startingCash)
      : (folded.startingCash != null ? String(folded.startingCash) : null),
    realizedPnl: metrics && metrics.realizedPnl != null
      ? String(metrics.realizedPnl)
      : (folded.realizedPnl != null ? String(folded.realizedPnl) : null),
    winRate: metrics && metrics.winRate != null
      ? String(metrics.winRate)
      : (folded.winRate != null ? String(folded.winRate) : null),
    trades: typeof metrics?.trades === "number"
      ? metrics.trades
      : (typeof folded.trades === "number" ? folded.trades : null),
    wins: typeof metrics?.wins === "number"
      ? metrics.wins
      : (typeof folded.wins === "number" ? folded.wins : null),
    losses: typeof metrics?.losses === "number"
      ? metrics.losses
      : (typeof folded.losses === "number" ? folded.losses : null),
    funnel: metrics?.funnel ?? folded.funnel ?? null,
    families,
    flags,
  };
}

export async function paperReviewFromFile(path: string): Promise<PaperReview> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new PaperReject("invalid_review", "review", { path, exists: false });
  }
  let body: unknown;
  try {
    body = JSON.parse(await file.text());
  } catch {
    throw new PaperReject("invalid_review", "review", { path, json: false });
  }
  return paperReviewFromReplayMap(body, path);
}

function intDelta(base: number | null, variant: number | null): number | null {
  if (base == null || variant == null) return null;
  return variant - base;
}

function moneyDelta(base: string | null, variant: string | null): string | null {
  if (base == null || variant == null) return null;
  return Dec.from(variant).sub(Dec.from(base)).toText();
}

function countDelta<K extends string>(
  keys: readonly K[],
  base: Partial<Record<K, number>> | null | undefined,
  variant: Partial<Record<K, number>> | null | undefined,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const d = (variant?.[key] ?? 0) - (base?.[key] ?? 0);
    if (d !== 0) out[key] = d;
  }
  return out;
}

/**
 * Variant minus base. One flag at a time. Does not walk bars.
 * Accepts replay-map JSON or a prior `paper review` JSON.
 */
export function paperAbFromReviews(base: PaperReview, variant: PaperReview): PaperAb {
  const flagSet = (flags: PaperReviewFlag[]) => new Set(flags);
  const baseFlags = flagSet(base.flags);
  const variantFlags = flagSet(variant.flags);
  return {
    mode: "paper",
    ab: true,
    base,
    variant,
    delta: {
      accepted: variant.accepted - base.accepted,
      hypeAccepted: variant.hypeAccepted - base.hypeAccepted,
      armed: variant.armed - base.armed,
      filled: intDelta(base.filled, variant.filled),
      invalidated: intDelta(base.invalidated, variant.invalidated),
      trades: intDelta(base.trades, variant.trades),
      wins: intDelta(base.wins, variant.wins),
      losses: intDelta(base.losses, variant.losses),
      equity: moneyDelta(base.equity, variant.equity),
      realizedPnl: moneyDelta(base.realizedPnl, variant.realizedPnl),
      skipReasons: countDelta(POLICY_REASONS, base.skipReasons, variant.skipReasons),
      cancelCodes: countDelta(
        ["never_touched", "ops_cancel", "deep_mitigate", "htf_break", "expired", "rr_fail", "gates_block"] as const,
        base.cancelCodes ?? {},
        variant.cancelCodes ?? {},
      ) as Record<string, number>,
      flagsAdded: variant.flags.filter((flag) => !baseFlags.has(flag)),
      flagsRemoved: base.flags.filter((flag) => !variantFlags.has(flag)),
    },
  };
}

export async function paperAbFromFiles(basePath: string, variantPath: string): Promise<PaperAb> {
  const base = await paperReviewFromFile(basePath);
  const variant = await paperReviewFromFile(variantPath);
  return paperAbFromReviews(base, variant);
}
