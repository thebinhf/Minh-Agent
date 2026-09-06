import { Dec, REL_TOL } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperAccountRow, PaperSide } from "./types";

export type SizedOpen = {
  side: PaperSide;
  riskPct: Dec;
  entry: Dec;
  stopLoss: Dec;
  takeProfit: Dec;
  stopDist: Dec;
  rewardDist: Dec;
  qty: Dec;
  riskQuote: Dec;
  rewardQuote: Dec;
  rr: Dec;
};

export function parseSide(raw: string): PaperSide {
  const side = raw.trim().toLowerCase();
  if (side === "long" || side === "short") return side;
  throw new PaperReject("invalid_side", "side", { side: raw });
}

export function normalizeTimeframes(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tf = String(item).trim();
    if (!tf || seen.has(tf)) continue;
    seen.add(tf);
    out.push(tf);
  }
  return out;
}

export function requireBandPct(account: PaperAccountRow, requested: string | undefined): Dec {
  const riskPct = Dec.from((requested ?? account.default_risk_pct).trim());
  const min = Dec.from(account.risk_pct_min);
  const max = Dec.from(account.risk_pct_max);
  if (riskPct.lt(min) || riskPct.gt(max)) {
    throw new PaperReject("risk_pct_out_of_band", "risk_pct", {
      riskPct: riskPct.toText(),
      riskPctMin: account.risk_pct_min,
      riskPctMax: account.risk_pct_max,
    });
  }
  return riskPct;
}

export function assertSlTpSide(side: PaperSide, entry: Dec, stopLoss: Dec, takeProfit: Dec): void {
  if (side === "long") {
    if (!stopLoss.lt(entry)) {
      throw new PaperReject("sl_side", "sl_side", {
        side,
        entry: entry.toText(),
        stopLoss: stopLoss.toText(),
      });
    }
    if (!takeProfit.gt(entry)) {
      throw new PaperReject("tp_side", "tp_side", {
        side,
        entry: entry.toText(),
        takeProfit: takeProfit.toText(),
      });
    }
    return;
  }
  if (!stopLoss.gt(entry)) {
    throw new PaperReject("sl_side", "sl_side", {
      side,
      entry: entry.toText(),
      stopLoss: stopLoss.toText(),
    });
  }
  if (!takeProfit.lt(entry)) {
    throw new PaperReject("tp_side", "tp_side", {
      side,
      entry: entry.toText(),
      takeProfit: takeProfit.toText(),
    });
  }
}

export function assertOptionalMinRr(account: PaperAccountRow, rr: Dec): void {
  if (account.min_rr == null || account.min_rr === "") return;
  const floor = Dec.from(account.min_rr);
  if (rr.lt(floor)) {
    throw new PaperReject("rr_below_min", "rr", {
      rr: rr.toText(),
      minRr: account.min_rr,
    });
  }
}

/**
 * Derive qty from equity × this trade's riskPct and |entry − SL|.
 * Band and optional min_rr come from the account row — not source constants.
 */
export function sizeFromRisk(input: {
  equity: Dec;
  riskPct: Dec;
  side: PaperSide;
  entry: Dec;
  stopLoss: Dec;
  takeProfit: Dec;
}): SizedOpen {
  if (!input.equity.isPos()) {
    throw new PaperReject("equity_non_positive", "equity", { equity: input.equity.toText() });
  }
  assertSlTpSide(input.side, input.entry, input.stopLoss, input.takeProfit);
  const stopDist = input.entry.sub(input.stopLoss).abs();
  if (!stopDist.isPos()) {
    throw new PaperReject("stop_dist", "stop_dist", { stopDist: "0" });
  }
  const rewardDist = input.takeProfit.sub(input.entry).abs();
  const riskBudget = input.equity.mul(input.riskPct);
  const qty = riskBudget.div(stopDist);
  if (!qty.isPos()) {
    throw new PaperReject("qty_non_positive", "qty", { qty: qty.toText() });
  }
  const riskQuote = stopDist.mul(qty);
  if (!riskQuote.lteRel(riskBudget, REL_TOL)) {
    throw new PaperReject("risk_quote", "risk_quote", {
      riskQuote: riskQuote.toText(),
      riskBudget: riskBudget.toText(),
    });
  }
  const rewardQuote = rewardDist.mul(qty);
  const rr = rewardDist.div(stopDist);
  return {
    side: input.side,
    riskPct: input.riskPct,
    entry: input.entry,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    stopDist,
    rewardDist,
    qty,
    riskQuote,
    rewardQuote,
    rr,
  };
}

export function pnlAt(side: PaperSide, entry: Dec, exit: Dec, qty: Dec): Dec {
  return side === "long" ? exit.sub(entry).mul(qty) : entry.sub(exit).mul(qty);
}

export function slHit(side: PaperSide, last: Dec, stopLoss: Dec): boolean {
  return side === "long" ? last.lte(stopLoss) : last.gte(stopLoss);
}

export function tpHit(side: PaperSide, last: Dec, takeProfit: Dec): boolean {
  return side === "long" ? last.gte(takeProfit) : last.lte(takeProfit);
}
