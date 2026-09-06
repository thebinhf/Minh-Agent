import { Dec, REL_TOL } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperAccountRow, PaperMarginMode, PaperSide, TakeProfitPlan } from "./types";

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

export function requireLeverage(account: PaperAccountRow, requested: string | undefined): Dec {
  const leverage = Dec.from((requested ?? account.default_leverage ?? "1").trim());
  const min = Dec.from(account.leverage_min ?? "1");
  const max = Dec.from(account.leverage_max ?? "25");
  if (!leverage.isPos() || leverage.lt(min) || leverage.gt(max)) {
    throw new PaperReject("leverage_out_of_band", "leverage", {
      leverage: leverage.toText(),
      leverageMin: account.leverage_min ?? "1",
      leverageMax: account.leverage_max ?? "25",
    });
  }
  return leverage;
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
