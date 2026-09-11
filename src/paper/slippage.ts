import { Dec } from "./decimal";
import type { PaperDepth, PaperDepthLevel, PaperSide, SlippageFallback, SlippageMeta } from "./types";

/**
 * PAPER_SLIPPAGE=0: taker fills stay at last/limit (0 walk).
 * Default on. Missing / stale / thin L50 is not a veto.
 */
export function paperSlippageOn(): boolean {
  return process.env.PAPER_SLIPPAGE !== "0";
}

export type BookTake = "buy" | "sell";

export type BookWalk = {
  vwap: Dec;
  levels: number;
  bookCapped: boolean;
};

/** Open long / close short buys asks. Open short / close long sells bids. */
export function takeSide(side: PaperSide, kind: "open" | "close"): BookTake {
  if (kind === "open") return side === "long" ? "buy" : "sell";
  return side === "long" ? "sell" : "buy";
}

export function takingLevels(depth: PaperDepth, take: BookTake): PaperDepthLevel[] {
  return take === "buy" ? depth.asks : depth.bids;
}

export function bookUsable(
  depth: PaperDepth | null | undefined,
  take: BookTake,
  now: number,
  staleMs: number,
): depth is PaperDepth {
  if (!depth) return false;
  if (depth.recvTs == null || now - depth.recvTs > staleMs) return false;
  if (takingLevels(depth, take).length === 0) return false;
  const bid = depth.bestBid ?? depth.bids[0]?.price ?? null;
  const ask = depth.bestAsk ?? depth.asks[0]?.price ?? null;
  if (bid == null || ask == null) return false;
  let bidPx: Dec;
  let askPx: Dec;
  try {
    bidPx = Dec.from(bid);
    askPx = Dec.from(ask);
  } catch {
    return false;
  }
  if (!bidPx.isPos() || !askPx.isPos() || askPx.lte(bidPx)) return false;
  return true;
}

/**
 * Walk the taking side. Long/buy consumes asks in array order (best first).
 * Optional cap: do not take a buy above the limit or a sell below it.
 * Remaining qty pads at the last consumed level (market) or the cap (--cross).
 * Returns null when nothing can be priced (empty book and no cap).
 */
export function walkBook(input: {
  take: BookTake;
  qty: Dec;
  levels: PaperDepthLevel[];
  cap?: Dec;
}): BookWalk | null {
  if (!input.qty.isPos()) return null;
  let remaining = input.qty;
  let notional = Dec.zero();
  let filled = Dec.zero();
  let lastPrice: Dec | null = null;
  let usedLevels = 0;

  for (const level of input.levels) {
    let price: Dec;
    let size: Dec;
    try {
      price = Dec.from(level.price);
      size = Dec.from(level.size);
    } catch {
      continue;
    }
    if (!price.isPos() || !size.isPos()) continue;
    if (input.cap) {
      if (input.take === "buy" && price.gt(input.cap)) break;
      if (input.take === "sell" && price.lt(input.cap)) break;
    }
    const takeQty = size.lt(remaining) ? size : remaining;
    notional = notional.add(takeQty.mul(price));
    filled = filled.add(takeQty);
    remaining = remaining.sub(takeQty);
    lastPrice = price;
    usedLevels += 1;
    if (!remaining.isPos()) break;
  }

  if (remaining.isPos()) {
    const pad = input.cap ?? lastPrice;
    if (!pad) return null;
    notional = notional.add(remaining.mul(pad));
    filled = filled.add(remaining);
    return { vwap: notional.div(filled), levels: usedLevels, bookCapped: true };
  }
  return { vwap: notional.div(filled), levels: usedLevels, bookCapped: false };
}

export function slippageMeta(input: {
  fill: Dec;
  reference: Dec;
  levels: number;
  bookCapped: boolean;
  fallback: SlippageFallback;
}): SlippageMeta {
  const slippage = input.fill.sub(input.reference).abs();
  const slippageBps = input.reference.isPos()
    ? slippage.div(input.reference).mul(Dec.from("10000"))
    : Dec.zero();
  return {
    slippage: slippage.toText(),
    slippageBps: slippageBps.toText(),
    levels: input.levels,
    bookCapped: input.bookCapped,
    fallback: input.fallback,
  };
}

export function offSlippage(price: Dec): SlippageMeta {
  return slippageMeta({
    fill: price,
    reference: price,
    levels: 0,
    bookCapped: false,
    fallback: "off",
  });
}

export function fallbackSlippage(price: Dec, fallback: Exclude<SlippageFallback, "none" | "off">): SlippageMeta {
  return slippageMeta({
    fill: price,
    reference: price,
    levels: 0,
    bookCapped: false,
    fallback,
  });
}
