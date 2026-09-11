import { describe, expect, test } from "bun:test";
import { intervalToMs } from "../../src/feed/bb/recovery";
import { asOfTape, type AsOfStore } from "../../src/features/tape";

const H4 = intervalToMs("240");
const H1 = intervalToMs("60");
const ASOF = 1_000_000_000_000;

function store(opts: {
  oi?: Array<{ interval: string; start_ts: number; open_interest: string }>;
  funding?: Array<{ funding_ts: number; funding_rate: string }>;
  flow?: { buyNotional: string; sellNotional: string };
  liq?: Array<{ side: string; price: string; size: string; exch_ts: number }>;
}): AsOfStore {
  return {
    listOi({ interval, endTs }) {
      return (opts.oi ?? []).filter((row) => {
        if (interval && row.interval !== interval) return false;
        if (endTs !== undefined && row.start_ts > endTs) return false;
        return true;
      }).map((row) => ({
        symbol: "BTCUSDT",
        interval: row.interval,
        start_ts: row.start_ts,
        open_interest: row.open_interest,
        recv_ts: row.start_ts,
      }));
    },
    listFunding({ endTs }) {
      return (opts.funding ?? []).filter((row) => (
        endTs === undefined || row.funding_ts <= endTs
      )).map((row) => ({
        symbol: "BTCUSDT",
        funding_ts: row.funding_ts,
        funding_rate: row.funding_rate,
        recv_ts: row.funding_ts,
      }));
    },
    sumFlowWindow() {
      return opts.flow ?? { buyNotional: "0", sellNotional: "0" };
    },
    listLiquidations({ endTs, startTs }) {
      return (opts.liq ?? [])
        .filter((row) => (startTs === undefined || row.exch_ts >= startTs)
          && (endTs === undefined || row.exch_ts <= endTs))
        .map((row) => ({
          symbol: "BTCUSDT",
          side: row.side,
          price: row.price,
          size: row.size,
          exch_ts: row.exch_ts,
          recv_ts: row.exch_ts,
        }));
    },
  };
}

describe("as-of quant tape", () => {
  test("empty store is missing — does not invent crowded/OI/flow/cascade", () => {
    const row = asOfTape(store({}), { symbol: "BTCUSDT", asof: ASOF });
    expect(row.quality).toBe("missing");
    expect(row.tape).toEqual({
      crowded: null,
      oiReading: null,
      cascade: null,
      flowReading: null,
    });
  });

  test("OI and funding after asof are ignored; closed 4H OI is used", () => {
    const closed = ASOF - H4;
    const forming = ASOF - 60_000;
    const future = ASOF + H4;
    const row = asOfTape(store({
      oi: [
        { interval: "240", start_ts: closed - H4, open_interest: "100" },
        { interval: "240", start_ts: closed, open_interest: "130" },
        { interval: "240", start_ts: forming, open_interest: "999" },
        { interval: "240", start_ts: future, open_interest: "50" },
      ],
      funding: [
        { funding_ts: ASOF - 8 * 3600_000, funding_rate: "0.0001" },
        { funding_ts: ASOF + 1, funding_rate: "0.01" },
      ],
    }), {
      symbol: "BTCUSDT",
      asof: ASOF,
      closes: ["100", "110"],
    });
    expect(row.quality).toBe("asof");
    expect(row.tape.oiReading).toBe("long_add");
    expect(row.tape.crowded).toBeNull();
    expect(row.fields.funding).toBe("ok");
  });

  test("crowded funding at asof is long when rate ≥ extreme", () => {
    const row = asOfTape(store({
      funding: [{ funding_ts: ASOF, funding_rate: "0.001" }],
    }), { symbol: "ETHUSDT", asof: ASOF });
    expect(row.tape.crowded).toBe("long");
    expect(row.quality).toBe("asof");
  });

  test("liq prints after asof do not enter cascade", () => {
    const row = asOfTape(store({
      liq: [{
        side: "Buy",
        price: "100",
        size: "10",
        exch_ts: ASOF + 1,
      }],
    }), { symbol: "BTCUSDT", asof: ASOF, lastPrice: 100 });
    expect(row.tape.cascade).toBeNull();
    expect(row.quality).toBe("missing");
  });

  test("1h interval cap is used for OI", () => {
    expect(H1).toBe(3_600_000);
  });
});
