import { Dec, REL_TOL } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperAccountRow, PaperMarginMode, PaperSide, TakeProfitPlan } from "./types";
import type { InstrumentSpec } from "./venue";

export function parseMarginMode(raw: string | null | undefined): PaperMarginMode {
  const value = (raw ?? "isolated").trim().toLowerCase();
  if (value === "isolated" || value === "cross") return value;
  throw new PaperReject("invalid_margin_mode", "margin", { marginMode: raw });
}

export function closeFeeOn(qty: Dec, entry: Dec, leverage: Dec, side: PaperSide, feeRate: Dec): Dec {
  if (feeRate.isZero()) return Dec.zero();
  const inv = Dec.from("1").div(leverage);
  const factor = side === "long" ? Dec.from("1").sub(inv) : Dec.from("1").add(inv);
  return qty.mul(entry).mul(factor).mul(feeRate);
}

function assertTpSide(side: PaperSide, entry: Dec, takeProfit: Dec): void {
  if (side === "long" && !takeProfit.gt(entry)) {
    throw new PaperReject("tp_side", "tp_side", { side, entry: entry.toText(), takeProfit: takeProfit.toText() });
  }
  if (side === "short" && !takeProfit.lt(entry)) {
    throw new PaperReject("tp_side", "tp_side", { side, entry: entry.toText(), takeProfit: takeProfit.toText() });
  }
}

/** Effective band: instrument spec binds; account min/max are an extra operator ceiling. */
export function leverageBand(account: PaperAccountRow, spec: InstrumentSpec): { min: Dec; max: Dec } {
  const accountMin = Dec.from(account.leverage_min ?? "1");
  const accountMax = Dec.from(account.leverage_max ?? "150");
  const specMin = Dec.from(spec.minLeverage);
  const specMax = Dec.from(spec.maxLeverage);
  const min = accountMin.gt(specMin) ? accountMin : specMin;
  const max = accountMax.lt(specMax) ? accountMax : specMax;
  if (!min.isPos() || min.gt(max)) {
    throw new PaperReject("leverage_out_of_band", "leverage", {
      leverageMin: min.toText(),
      leverageMax: max.toText(),
      accountMin: account.leverage_min ?? "1",
      accountMax: account.leverage_max ?? "150",
      specMin: spec.minLeverage,
      specMax: spec.maxLeverage,
    });
  }
  return { min, max };
}

export function requireLeverage(
  account: PaperAccountRow,
  requested: string | undefined,
  spec: InstrumentSpec,
): Dec {
  const leverage = Dec.from((requested ?? account.default_leverage ?? "1").trim());
  const { min, max } = leverageBand(account, spec);
  if (!leverage.isPos() || leverage.lt(min) || leverage.gt(max)) {
    throw new PaperReject("leverage_out_of_band", "leverage", {
      leverage: leverage.toText(),
      leverageMin: min.toText(),
      leverageMax: max.toText(),
    });
  }
  return leverage;
}

/**
 * Minimum leverage so IM + estimated close fee + open fee fit `available`.
 * Null when even infinite leverage cannot cover the two fee terms.
 */
export function minLeverageForMargin(input: {
  qty: Dec;
  entry: Dec;
  side: PaperSide;
  feeRate: Dec;
  available: Dec;
}): Dec | null {
  const notional = input.qty.mul(input.entry);
  if (!notional.isPos() || !input.available.isPos()) return null;
  const leftover = input.available.sub(notional.mul(input.feeRate).mul(Dec.from("2")));
  if (!leftover.isPos()) return null;
  const invFactor = input.side === "long"
    ? Dec.from("1").sub(input.feeRate)
    : Dec.from("1").add(input.feeRate);
  if (!invFactor.isPos()) return null;
  const needed = notional.mul(invFactor).div(leftover);
  return needed.isPos() ? needed : null;
}

/**
 * Keep `requested` when IM already fits. Otherwise raise to the minimum that
 * fits, snapped up to `leverageStep`, capped at `max` (already the band max).
 * Does not lower below `requested`. Caller still `assertMargin`.
 */
export function fitLeverage(input: {
  requested: Dec;
  qty: Dec;
  entry: Dec;
  side: PaperSide;
  feeRate: Dec;
  available: Dec;
  spec: InstrumentSpec;
  max: Dec;
}): Dec {
  const openFee = feeOn(input.qty, input.entry, input.feeRate);
  const fits = (lev: Dec): boolean => {
    const margin = marginOn(input.qty, input.entry, lev, {
      side: input.side,
      feeRate: input.feeRate,
      entry: input.entry,
    });
    return !input.available.sub(margin).sub(openFee).isNeg();
  };
  if (fits(input.requested)) return input.requested;
  const step = Dec.from(input.spec.leverageStep);
  const cap = input.max.floorToStep(step);
  const needed = minLeverageForMargin({
    qty: input.qty,
    entry: input.entry,
    side: input.side,
    feeRate: input.feeRate,
    available: input.available,
  });
  let lev = input.requested;
  if (needed) {
    const target = needed.gt(cap) ? cap : needed;
    lev = target.ceilToStep(step);
    if (lev.gt(cap)) lev = cap;
    if (lev.lt(input.requested)) lev = input.requested;
  }
  if (!fits(lev) && lev.lt(cap)) {
    const bumped = lev.add(step);
    lev = bumped.gt(cap) ? cap : bumped;
  }
  return lev;
}

export function feeOn(qty: Dec, price: Dec, feeRate: Dec): Dec {
  if (feeRate.isNeg()) {
    throw new PaperReject("fee_rate", "fee", { feeRate: feeRate.toText() });
  }
  return qty.mul(price).mul(feeRate);
}

/**
 * Bybit IM. Isolated uses entry as notional; cross uses mark.
 * Close-fee term is always on entry: qty*entry*(1±1/lev)*fee.
 */
export function marginOn(
  qty: Dec,
  notional: Dec,
  leverage: Dec,
  extra?: { side: PaperSide; feeRate: Dec; entry?: Dec },
): Dec {
  const im = qty.mul(notional).div(leverage);
  if (!extra || extra.feeRate.isZero()) return im;
  return im.add(closeFeeOn(qty, extra.entry ?? notional, leverage, extra.side, extra.feeRate));
}

/** Bybit MM: qty*mark*mmRate + estimated close fee. Deduction = 0. */
export function maintenanceMargin(
  qty: Dec,
  mark: Dec,
  mmRate: Dec,
  extra?: { side: PaperSide; feeRate: Dec; entry: Dec; leverage: Dec },
): Dec {
  const mm = qty.mul(mark).mul(mmRate);
  if (!extra || extra.feeRate.isZero()) return mm;
  return mm.add(closeFeeOn(qty, extra.entry, extra.leverage, extra.side, extra.feeRate));
}

/** Cross UTA: mark where marginBalance = total MM, other positions held constant. */
export function estimateCrossLiq(input: {
  side: PaperSide;
  qty: Dec;
  entry: Dec;
  leverage: Dec;
  mmRate: Dec;
  feeRate: Dec;
  cash: Dec;
  othersUnrealized: Dec;
  othersMm: Dec;
}): Dec {
  if (!input.qty.isPos()) return Dec.zero();
  const fee = closeFeeOn(input.qty, input.entry, input.leverage, input.side, input.feeRate);
  if (input.side === "long") {
    const num = input.cash.add(input.othersUnrealized).sub(input.entry.mul(input.qty)).sub(input.othersMm).sub(fee);
    const den = input.qty.mul(input.mmRate.sub(Dec.from("1")));
    if (den.isZero()) return Dec.zero();
    const mark = num.div(den);
    return mark.isPos() ? mark : Dec.zero();
  }
  const num = input.cash.add(input.othersUnrealized).add(input.entry.mul(input.qty)).sub(input.othersMm).sub(fee);
  const den = input.qty.mul(Dec.from("1").add(input.mmRate));
  if (!den.isPos()) return Dec.zero();
  const mark = num.div(den);
  return mark.isPos() ? mark : Dec.zero();
}

/**
 * Bybit UTA isolated USDT perp (no extra margin, no MM deduction):
 * long  (entry*qty − entry*qty/lev) / (qty − qty*mm)
 * short (entry*qty + entry*qty/lev) / (qty + qty*mm)
 */
export function liqPrice(side: PaperSide, entry: Dec, leverage: Dec, mmRate: Dec): Dec {
  const inv = Dec.from("1").div(leverage);
  if (side === "long") {
    const den = Dec.from("1").sub(mmRate);
    if (!den.isPos()) return Dec.zero();
    const px = entry.mul(Dec.from("1").sub(inv)).div(den);
    return px.isPos() ? px : Dec.zero();
  }
  return entry.mul(Dec.from("1").add(inv)).div(Dec.from("1").add(mmRate));
}

export function liqHit(side: PaperSide, last: Dec, liq: Dec): boolean {
  return side === "long" ? last.lte(liq) : last.gte(liq);
}

/** Linear USDT: long pays when rate > 0. Amount is signed (credit to cash). */
export function fundingAmount(side: PaperSide, qty: Dec, mark: Dec, rate: Dec): Dec {
  const payment = qty.mul(mark).mul(rate);
  return side === "long" ? payment.neg() : payment;
}

export function parseTakeProfits(
  side: PaperSide,
  entry: Dec,
  takeProfit: string | undefined,
  raw: TakeProfitPlan[] | undefined,
): TakeProfitPlan[] {
  const plans = (raw ?? []).map((item) => ({
    price: String(item.price ?? "").trim(),
    qtyPct: String(item.qtyPct ?? "").trim(),
    filled: Boolean(item.filled),
  })).filter((item) => item.price);
  if (plans.length === 0) {
    const price = takeProfit?.trim();
    if (!price) throw new PaperReject("missing_take_profit", "tp_side", {});
    assertTpSide(side, entry, Dec.from(price));
    return [{ price, qtyPct: "1", filled: false }];
  }
  let sum = Dec.zero();
  for (const plan of plans) {
    if (!plan.qtyPct) throw new PaperReject("tp_qty_pct", "tp", { takeProfit: plan });
    const pct = Dec.from(plan.qtyPct);
    if (!pct.isPos()) throw new PaperReject("tp_qty_pct", "tp", { qtyPct: plan.qtyPct });
    assertTpSide(side, entry, Dec.from(plan.price));
    sum = sum.add(pct);
  }
  if (sum.sub(Dec.from("1")).abs().gt(REL_TOL)) {
    throw new PaperReject("tp_qty_pct_sum", "tp", { qtyPctSum: sum.toText() });
  }
  const sorted = [...plans].sort((a, b) => {
    const cmp = Dec.from(a.price).cmp(Dec.from(b.price));
    return side === "long" ? cmp : -cmp;
  });
  return sorted.map((plan) => ({ ...plan, filled: plan.filled === true }));
}

export function furthestTakeProfit(plans: TakeProfitPlan[]): string {
  return plans[plans.length - 1]?.price ?? "";
}

export function takeProfitCloseQty(qtyInitial: Dec, qtyRemaining: Dec, plan: TakeProfitPlan, isLast: boolean): Dec {
  if (isLast) return qtyRemaining;
  const slice = qtyInitial.mul(Dec.from(plan.qtyPct));
  return slice.gt(qtyRemaining) ? qtyRemaining : slice;
}
