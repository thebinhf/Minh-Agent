import { describe, expect, test } from "bun:test";
import { buildTerminalModel, renderTerminal } from "../../src/terminal/view";
import { parseTerminalArgs } from "../../src/terminal/index";

const ASOF = 1_789_718_837_205;

function observeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "observe",
    observer: true,
    ts: ASOF,
    feed: { ok: true, connected: 1, klineLagOk: false, lastMessageAgeMs: 1500 },
    gates: { tradingAllowed: false, reasons: ["kline_lag"] },
    map: { quality: "ok", interval: "240", ts: ASOF - 3_600_000, symbols: ["BTCUSDT", "ETHUSDT"] },
    tape: {
      quality: "ok",
      symbols: 2,
      oi: { ok: 2, missing: 0 },
      funding: { ok: 2, missing: 0 },
      flow: { ok: 1, missing: 1 },
      liq: { ok: 0, missing: 2 },
    },
    shadow: { quality: "down", accepted: 0, wouldArm: 0 },
    paper: {
      mode: "observe",
      observer: true,
      mutations: "blocked",
      account: { name: "minh-paper", equity: "9988.87", cash: "9992.27", startingCash: "10000" },
      standing: { accepted: 1, pending: 1, open: 1, alerts: 1 },
      event: {
        mode: "event",
        pending: [{
          id: 7,
          symbol: "BTCUSDT",
          side: "long",
          limitPrice: "77300",
          stopLoss: "76900",
          takeProfit: "78100",
          qty: "0.5",
          rr: "2",
          zoneId: "btc-4h-d-20260914-demo",
        }],
        alerts: [{ id: 3, symbol: "SOLUSDT", op: "above", price: "180.5", zoneId: null }],
        open: [{
          id: 1,
          symbol: "BTCUSDT",
          side: "long",
          qty: "0.5",
          entryPrice: "77300",
          stopLoss: "76900",
          takeProfit: "78100",
          riskQuote: "200",
          unrealizedPnl: "-100",
          markPrice: "77100",
          liqPrice: "57665.6",
          zoneId: "btc-4h-d-20260914-demo",
        }],
        zones: [{
          zoneId: "doge-4h-s-rv-20260912-01",
          symbol: "DOGEUSDT",
          tf: "240",
          side: "supply",
          setup: "reversal",
          proximal: 0.08447,
          sl: 0.08546018,
          entry: 0.084665,
          tp: 0.08307464,
          rr: 2,
          freshness: "virgin",
          baseEndTs: ASOF - 86_400_000,
        }],
      },
      recent: [
        { id: 4, kind: "position.managed", symbol: "BTCUSDT", ts: ASOF - 60_000, payload: { action: "be", stopLoss: "77300", mfeR: "0.5" } },
        { id: 3, kind: "order.invalidated", symbol: "ETHUSDT", ts: ASOF - 120_000, payload: { cancelCode: "deep_mitigate" } },
      ],
    },
    ...overrides,
  };
}

describe("terminal model", () => {
  test("a source that never answered stays null, not zero", () => {
    const model = buildTerminalModel(null, ASOF);
    expect(model.feed).toBeNull();
    expect(model.desk).toBeNull();
    const text = renderTerminal(model);
    expect(text).toContain("down (no /observe)");
    expect(text).toContain("PAPER  down");
    expect(text).not.toContain("open=0 alerts=0");
  });

  test("the booting host has no desk yet, so none is invented", () => {
    const model = buildTerminalModel(observeBody({
      paper: { mode: "observe", observer: true, paper: null, note: "paper starting" },
    }), ASOF);
    expect(model.desk).toBeNull();
  });

  test("tape coverage reads as ok vs missing, never as a bare zero", () => {
    const text = renderTerminal(buildTerminalModel(observeBody(), ASOF));
    expect(text).toContain("flow 1/2 ok 1 miss");
    expect(text).toContain("liq 0/2 ok 2 miss");
  });

  test("stale lag and denied gates are visible on the feed line", () => {
    const text = renderTerminal(buildTerminalModel(observeBody(), ASOF));
    expect(text).toContain("lag=STALE");
    expect(text).toContain("GATES deny (kline_lag)");
    expect(text).toContain("last-msg=2s");
  });

  test("MAP header works with and without a single interval", () => {
    const single = renderTerminal(buildTerminalModel(observeBody(), ASOF));
    expect(single).toContain("MAP    2 symbols 240 @");
    const batch = renderTerminal(buildTerminalModel(observeBody({
      map: { quality: "ok", ts: ASOF - 120_000, symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] },
    }), ASOF));
    expect(batch).toContain("MAP    3 symbols @");
    for (const text of [single, batch]) {
      expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
    }
  });
});

describe("terminal rows", () => {
  test("open position shows unrealised PnL as a multiple of original risk", () => {
    const text = renderTerminal(buildTerminalModel(observeBody(), ASOF));
    expect(text).toContain("OPEN   BTCUSDT long qty=0.5 entry=77300 sl=76900");
    expect(text).toContain("u=-100 (-0.50R)");
    expect(text).toContain("zone=btc-4h-d-20260914-demo");
  });

  test("resting OCO, armed alert, MAP verdict row and recent events each get a line", () => {
    const text = renderTerminal(buildTerminalModel(observeBody(), ASOF));
    expect(text).toContain("REST   BTCUSDT long limit=77300 sl=76900 tp=78100 rr=2 zone=btc-4h-d-20260914-demo");
    expect(text).toContain("ALERT  SOLUSDT above 180.5");
    expect(text).toContain(
      "CARD   DOGEUSDT 4h supply/reversal band=0.08447..0.08546018 entry=0.084665 rr=2 virgin paper=accepted shadow=—",
    );
    expect(text).toContain("MAPCARDS — /zones did not answer, desk rows only");
    expect(text).not.toContain("plan=");
    expect(text).not.toContain("undetected");
    expect(text).toContain("position.managed  BTCUSDT    action=be");
    expect(text).toContain("order.invalidated ETHUSDT    cancelCode=deep_mitigate");
  });

  test("mutation lock is on the same screen as the desk", () => {
    expect(renderTerminal(buildTerminalModel(observeBody(), ASOF))).toContain("MUTATIONS blocked");
  });
});

describe("MAP verdict panel", () => {
  function card(zoneId: string, symbol: string, over: Record<string, unknown> = {}) {
    return {
      zoneId,
      symbol,
      tf: "240",
      side: "supply",
      setup: "sd",
      proximal: 108_400,
      entry: 107_900,
      sl: 107_100,
      tp: 106_300,
      rr: 2.41,
      freshness: "virgin",
      baseEndTs: ASOF - 3_600_000,
      expiryBars: 48,
      ...over,
    };
  }

  function detected(zones: unknown[]) {
    return { ts: ASOF - 120_000, interval: "240", symbols: ["BTCUSDT"], zones };
  }

  function shadow(events: unknown[], wouldArm: string[] = []) {
    return { mode: "live-shadow", accepted: [], wouldArm, events, counts: { mapAllow: 0, armAllow: 0 } };
  }

  test("a detected card carries the reason the policy kept it off the desk", () => {
    const model = buildTerminalModel(observeBody({
      cardBody: detected([
        card("btc-4h-s-1", "BTCUSDT"),
        card("btc-4h-s-2", "BTCUSDT", { rr: 3 }),
      ]),
      shadowBody: shadow([
        { id: 9, ts: ASOF - 60_000, kind: "map_plan", symbol: "BTCUSDT", zoneId: "btc-4h-s-2", allow: false, reason: "family_floor", last: "108000" },
        { id: 8, ts: ASOF - 60_000, kind: "map_plan", symbol: "BTCUSDT", zoneId: "btc-4h-s-1", allow: false, reason: "bias_chop", last: "108000" },
      ]),
    }), ASOF);
    const text = renderTerminal(model);
    expect(text).toContain("MAPCARDS 4h cards=3 @");
    expect(text).toContain("desk accepted=1 off-desk=2");
    expect(text).toContain("shadow pass=0 deny=2 (bias_chop 1, family_floor 1) no-verdict=1");
    expect(text).toContain("CARD   BTCUSDT 4h supply/sd band=108400..107100 entry=107900 rr=2.41 virgin win=2026-09-26");
    expect(text).toContain("shadow=deny bias_chop btc-4h-s-1");
    expect(text).toContain("shadow=deny family_floor btc-4h-s-2");
    expect(text).toContain("plan=2026-09-18 08:06Z (1m ago)");
    expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
  });

  test("the desk's own stage outranks the shadow's advisory verdict", () => {
    const model = buildTerminalModel(observeBody({
      cardBody: detected([card("btc-4h-d-20260914-demo", "BTCUSDT", { side: "demand" })]),
      shadowBody: shadow(
        [{ id: 9, ts: ASOF - 60_000, kind: "map_plan", symbol: "BTCUSDT", zoneId: "btc-4h-d-20260914-demo", allow: false, reason: "family_floor", last: null }],
        ["btc-4h-d-20260914-demo"],
      ),
    }), ASOF);
    const row = model.cards?.rows.find((item) => item.zoneId === "btc-4h-d-20260914-demo");
    expect(row?.paper).toBe("open");
    expect(row?.shadow).toBe("arm");
    expect(renderTerminal(model)).toContain("desk open=1 accepted=1 off-desk=0");
  });

  test("only the newest verdict per card counts, and non-plan events are ignored", () => {
    const model = buildTerminalModel(observeBody({
      cardBody: detected([card("btc-4h-s-1", "BTCUSDT")]),
      shadowBody: shadow([
        { id: 11, ts: ASOF, kind: "map_plan", symbol: "BTCUSDT", zoneId: "btc-4h-s-1", allow: true, reason: "ok", last: null },
        { id: 10, ts: ASOF - 86_400_000, kind: "map_plan", symbol: "BTCUSDT", zoneId: "btc-4h-s-1", allow: false, reason: "bias_chop", last: null },
        { id: 9, ts: ASOF, kind: "arm_plan", symbol: "BTCUSDT", zoneId: "btc-4h-s-1", allow: true, reason: "ok", last: null },
      ]),
    }), ASOF);
    const row = model.cards?.rows.find((item) => item.zoneId === "btc-4h-s-1");
    expect(row?.shadow).toBe("allow");
    expect(row?.reason).toBeNull();
  });

  test("a card the shadow never judged says no-verdict, and a dropped card says undetected", () => {
    const model = buildTerminalModel(observeBody({
      cardBody: detected([]),
      shadowBody: shadow([]),
    }), ASOF);
    const text = renderTerminal(model);
    expect(text).toContain("MAPCARDS 4h cards=1 @");
    expect(text).toContain("undetected paper=accepted shadow=none doge-4h-s-rv-20260912-01");
    expect(text).toContain("shadow pass=0 deny=0 no-verdict=1");
  });

  test("the accept-gate deadline shows for off-desk cards only", () => {
    const offDesk = renderTerminal(buildTerminalModel(observeBody({
      cardBody: detected([card("btc-4h-s-1", "BTCUSDT")]),
    }), ASOF));
    expect(offDesk).toContain("win=2026-09-26");
    const held = renderTerminal(buildTerminalModel(observeBody({
      cardBody: detected([card("btc-4h-d-20260914-demo", "BTCUSDT", { side: "demand" })]),
    }), ASOF));
    expect(held).toContain("paper=open");
    expect(held).not.toContain("win=");
  });

  test("rows past the cap point at the endpoint instead of vanishing", () => {
    const many = Array.from({ length: 14 }, (_, i) => card(`btc-4h-s-${i}`, "BTCUSDT", { rr: 2 + i / 100 }));
    const text = renderTerminal(buildTerminalModel(observeBody({
      cardBody: detected(many),
    }), ASOF));
    expect(text.match(/^  CARD   /gm)).toHaveLength(12);
    expect(text).toContain("+3 more cards — GET /zones?interval=240");
  });

  test("the terminal's own shadow read wins over the feed's probe", () => {
    const model = buildTerminalModel(observeBody({
      shadow: { quality: "missing", accepted: 0, wouldArm: 0 },
      cardBody: detected([]),
      shadowBody: { ...shadow([]), accepted: [{ zoneId: "a" }, { zoneId: "b" }], wouldArm: ["a"] },
    }), ASOF);
    expect(model.shadow).toEqual({ quality: "ok", accepted: 2, wouldArm: 1 });
    expect(renderTerminal(model)).toContain("SHADOW ok accepted=2 would-arm=1");
  });

  test("a source stamped after our snapshot reads fresh, not unknown", () => {
    const text = renderTerminal(buildTerminalModel(observeBody({
      cardBody: { ...detected([]), ts: ASOF + 5_000 },
    }), ASOF));
    expect(text).toContain("MAPCARDS 4h cards=1 @ 2026-09-18 08:07Z (0s ago)");
    expect(text).not.toContain("— ago");
  });
});

describe("terminal args", () => {
  test("defaults redraw every 5s and honour the one-shot flag", () => {
    expect(parseTerminalArgs([])).toEqual({
      feedUrl: null, paperUrl: null, intervalSec: 5, once: false, help: false,
    });
    expect(parseTerminalArgs(["--once", "--interval", "15"]).intervalSec).toBe(15);
  });

  test("URLs are validated, not guessed", () => {
    expect(parseTerminalArgs(["--feed", "http://127.0.0.1:43180"]).feedUrl).toBe("http://127.0.0.1:43180");
    expect(parseTerminalArgs(["--paper", "http://h:43181/"]).paperUrl).toBe("http://h:43181");
    expect(() => parseTerminalArgs(["--feed", "127.0.0.1:43180"])).toThrow("--feed needs an http(s) URL");
    expect(() => parseTerminalArgs(["--interval", "0"])).toThrow("--interval");
    expect(() => parseTerminalArgs(["--post", "arm"])).toThrow("unknown argument: --post");
  });
});
