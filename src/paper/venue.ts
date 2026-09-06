import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Dec } from "./decimal";
import { PaperReject } from "./errors";

export type InstrumentSpec = {
  base: string;
  quote: string;
  priceScale: string;
  tickSize: string;
  minPrice: string;
  maxPrice: string;
  qtyStep: string;
  minOrderQty: string;
  maxOrderQty: string;
  maxMktOrderQty: string;
  minNotionalValue: string;
  minLeverage: string;
  maxLeverage: string;
  leverageStep: string;
};

export type InstrumentCatalog = Record<string, InstrumentSpec>;

type FileShape = {
  venue: string;
  symbols: InstrumentCatalog;
};

const DEFAULT_PATH = resolve(import.meta.dir, "instruments/bybit-linear.json");

export function loadBybitLinear(path = DEFAULT_PATH): InstrumentCatalog {
  const file = JSON.parse(readFileSync(path, "utf8")) as FileShape;
  return file.symbols;
}

const DEFAULT_CATALOG = loadBybitLinear();

export function defaultCatalog(): InstrumentCatalog {
  return DEFAULT_CATALOG;
}

export function requireInstrument(symbol: string, catalog: InstrumentCatalog = DEFAULT_CATALOG): InstrumentSpec {
  const spec = catalog[symbol];
  if (!spec) {
    throw new PaperReject("unknown_instrument", "venue", { symbol, venue: "bybit", category: "linear" });
  }
  return spec;
}

export function snapPrice(price: Dec, spec: InstrumentSpec): Dec {
  const tick = Dec.from(spec.tickSize);
  const snapped = price.roundToStep(tick);
  const min = Dec.from(spec.minPrice);
  const max = Dec.from(spec.maxPrice);
  if (snapped.lt(min) || snapped.gt(max)) {
    throw new PaperReject("price_filter", "venue", {
      price: price.toText(),
      snapped: snapped.toText(),
      tickSize: spec.tickSize,
      minPrice: spec.minPrice,
      maxPrice: spec.maxPrice,
    });
  }
  return snapped;
}

export function floorQty(qty: Dec, spec: InstrumentSpec): Dec {
  return qty.floorToStep(Dec.from(spec.qtyStep));
}

export function snapLeverage(leverage: Dec, spec: InstrumentSpec): Dec {
  const step = Dec.from(spec.leverageStep);
  const snapped = leverage.floorToStep(step);
  const min = Dec.from(spec.minLeverage);
  const max = Dec.from(spec.maxLeverage);
  if (!snapped.isPos() || snapped.lt(min) || snapped.gt(max)) {
    throw new PaperReject("leverage_out_of_band", "venue", {
      leverage: leverage.toText(),
      snapped: snapped.toText(),
      leverageMin: spec.minLeverage,
      leverageMax: spec.maxLeverage,
      leverageStep: spec.leverageStep,
    });
  }
  return snapped;
}

/** Bybit linear market order: qty on lot, notional, max market qty. */
export function assertMarketQty(spec: InstrumentSpec, qty: Dec, price: Dec): void {
  const step = Dec.from(spec.qtyStep);
  const minQty = Dec.from(spec.minOrderQty);
  const maxQty = Dec.from(spec.maxOrderQty);
  const maxMkt = Dec.from(spec.maxMktOrderQty);
  const minNotional = Dec.from(spec.minNotionalValue);
  if (!qty.isPos() || qty.lt(minQty)) {
    throw new PaperReject("min_order_qty", "venue", {
      qty: qty.toText(),
      minOrderQty: spec.minOrderQty,
      qtyStep: spec.qtyStep,
    });
  }
  if (qty.gt(maxQty) || qty.gt(maxMkt)) {
    throw new PaperReject("max_order_qty", "venue", {
      qty: qty.toText(),
      maxOrderQty: spec.maxOrderQty,
      maxMktOrderQty: spec.maxMktOrderQty,
    });
  }
  if (!qty.isOnStep(step)) {
    throw new PaperReject("qty_step", "venue", { qty: qty.toText(), qtyStep: spec.qtyStep });
  }
  const notional = qty.mul(price);
  if (notional.lt(minNotional)) {
    throw new PaperReject("min_notional", "venue", {
      notional: notional.toText(),
      minNotionalValue: spec.minNotionalValue,
      qty: qty.toText(),
      price: price.toText(),
    });
  }
}

export function floorCloseQty(qty: Dec, spec: InstrumentSpec, remaining: Dec, isLast: boolean): Dec {
  if (isLast) return remaining;
  const sliced = qty.floorToStep(Dec.from(spec.qtyStep));
  return sliced.gt(remaining) ? remaining : sliced;
}
