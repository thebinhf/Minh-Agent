import { Dec, REL_TOL } from "./decimal";
import { PaperReject } from "./errors";
import type { PaperAccountRow, PaperSide, TakeProfitPlan } from "./types";

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

export function marginOn(qty: Dec, entry: Dec, leverage: Dec): Dec {
  return qty.mul(entry).div(leverage);
}

/** Isolated linear liq. Band/mm come from the account — not source constants. */
export function liqPrice(side: PaperSide, entry: Dec, leverage: Dec, mmRate: Dec): Dec {
  const inv = Dec.from("1").div(leverage);
  if (side === "long") {
    const px = entry.mul(Dec.from("1").sub(inv).add(mmRate));
    return px.isPos() ? px : Dec.zero();
  }
  return entry.mul(Dec.from("1").add(inv).sub(mmRate));
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
