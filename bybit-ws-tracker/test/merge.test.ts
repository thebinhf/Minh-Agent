import { describe, expect, test } from "bun:test";
import { applyOrderbook, mergeTicker, serializeBook } from "../src/merge";
import type { BybitOrderbookData, TickerState } from "../src/types";

describe("mergeTicker", () => {
  test("snapshot replaces the full ticker", () => {
    const prev: TickerState = {
      symbol: "BTCUSDT",
      fields: { lastPrice: "1", markPrice: "2", staleExtra: "keep-me-not" },
      type: "delta",
    };

    const next = mergeTicker(prev, "snapshot", {
      symbol: "BTCUSDT",
      lastPrice: "66666.60",
      markPrice: "66666.60",
    }, { cs: 10, ts: 100 });

    expect(next.symbol).toBe("BTCUSDT");
    expect(next.type).toBe("snapshot");
    expect(next.fields.lastPrice).toBe("66666.60");
    expect(next.fields.markPrice).toBe("66666.60");
    expect(next.fields.staleExtra).toBeUndefined();
    expect(next.cs).toBe(10);
    expect(next.ts).toBe(100);
  });

  test("delta overlays present fields and keeps missing ones", () => {
    const prev = mergeTicker(null, "snapshot", {
      symbol: "ETHUSDT",
      lastPrice: "3000",
      markPrice: "3001",
      fundingRate: "0.0001",
    });

    const next = mergeTicker(prev, "delta", {
      symbol: "ETHUSDT",
      lastPrice: "3002",
    }, { cs: 11, ts: 200 });

    expect(next.type).toBe("delta");
    expect(next.fields.lastPrice).toBe("3002");
    expect(next.fields.markPrice).toBe("3001");
    expect(next.fields.fundingRate).toBe("0.0001");
    expect(next.cs).toBe(11);
  });

  test("delta empty string overwrites because the field is present", () => {
    const prev = mergeTicker(null, "snapshot", {
      symbol: "SOLUSDT",
      fundingRate: "0.01",
      lastPrice: "140",
    });

    const next = mergeTicker(prev, "delta", {
      symbol: "SOLUSDT",
      fundingRate: "",
    });

    expect(next.fields.fundingRate).toBe("");
    expect(next.fields.lastPrice).toBe("140");
  });

  test("null and undefined fields are ignored on delta", () => {
    const prev = mergeTicker(null, "snapshot", {
      symbol: "BNBUSDT",
      lastPrice: "600",
      markPrice: "601",
    });

    const next = mergeTicker(prev, "delta", {
      symbol: "BNBUSDT",
      lastPrice: undefined,
      markPrice: null,
    });

    expect(next.fields.lastPrice).toBe("600");
    expect(next.fields.markPrice).toBe("601");
  });

  test("delta without a prior snapshot still records incoming fields", () => {
    const next = mergeTicker(null, "delta", {
      symbol: "LINKUSDT",
      lastPrice: "18.2",
    });
    expect(next.symbol).toBe("LINKUSDT");
    expect(next.fields.lastPrice).toBe("18.2");
    expect(next.type).toBe("delta");
  });
});

function book(
  s: string,
  b: Array<[string, string]>,
  a: Array<[string, string]>,
  u: number,
  seq = 1,
): BybitOrderbookData {
  return { s, b, a, u, seq };
}

describe("applyOrderbook", () => {
  test("snapshot replaces bids and asks", () => {
    const first = applyOrderbook(
      null,
      "snapshot",
      book("BTCUSDT", [["100", "1"], ["99", "2"]], [["101", "3"], ["102", "4"]], 10),
    );
    expect(first.ready).toBe(true);
    expect(first.updateId).toBe(10);
    expect(serializeBook(first)).toEqual({
      bids: [["100", "1"], ["99", "2"]],
      asks: [["101", "3"], ["102", "4"]],
    });

    const replaced = applyOrderbook(
      first,
      "snapshot",
      book("BTCUSDT", [["98", "5"]], [["103", "6"]], 20, 2),
    );
    expect(serializeBook(replaced)).toEqual({
      bids: [["98", "5"]],
      asks: [["103", "6"]],
    });
  });

  test("delta inserts, updates, and deletes size=0", () => {
    const snap = applyOrderbook(
      null,
      "snapshot",
      book("ETHUSDT", [["2000", "1"], ["1999", "2"]], [["2001", "3"]], 1),
    );

    const next = applyOrderbook(
      snap,
      "delta",
      book(
        "ETHUSDT",
        [
          ["2000", "1.5"],
          ["1999", "0"],
          ["1998", "4"],
        ],
        [["2001", "0"], ["2002", "8"]],
        2,
        9,
      ),
    );

    expect(next.ready).toBe(true);
    expect(next.updateId).toBe(2);
    expect(next.seq).toBe(9);
    expect(serializeBook(next)).toEqual({
      bids: [["2000", "1.5"], ["1998", "4"]],
      asks: [["2002", "8"]],
    });
  });

  test("u=1 overwrites the local book (service restart snapshot)", () => {
    const prev = applyOrderbook(
      null,
      "snapshot",
      book("SOLUSDT", [["140", "10"]], [["141", "11"]], 50),
    );

    const restarted = applyOrderbook(
      prev,
      "delta",
      book("SOLUSDT", [["139", "1"]], [["142", "2"]], 1, 100),
    );

    expect(restarted.ready).toBe(true);
    expect(restarted.updateId).toBe(1);
    expect(serializeBook(restarted)).toEqual({
      bids: [["139", "1"]],
      asks: [["142", "2"]],
    });
  });

  test("sorts bids descending and asks ascending", () => {
    const state = applyOrderbook(
      null,
      "snapshot",
      book(
        "BTCUSDT",
        [["99.5", "1"], ["100.0", "2"], ["99.0", "3"]],
        [["101.5", "4"], ["100.5", "5"], ["102.0", "6"]],
        3,
      ),
    );

    expect(serializeBook(state).bids.map((level) => level[0])).toEqual(["100.0", "99.5", "99.0"]);
    expect(serializeBook(state).asks.map((level) => level[0])).toEqual(["100.5", "101.5", "102.0"]);
  });
});
