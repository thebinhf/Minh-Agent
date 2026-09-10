import { afterEach, describe, expect, test } from "bun:test";
import { agentQuantEnabled, quantVeto, readMapQuant, type QuantTape } from "../../src/agent/quant";

const saved = process.env.AGENT_QUANT;

afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_QUANT;
  else process.env.AGENT_QUANT = saved;
});

const CASCADE_LONG: QuantTape = {
  crowded: null,
  oiReading: null,
  cascade: { active: true, side: "long", fuel: "12" },
  flowReading: null,
};

const CROWDED_LONG: QuantTape = {
  crowded: "long",
  oiReading: null,
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: null,
};

const SHORT_ADD: QuantTape = {
  crowded: null,
  oiReading: "short_add",
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: null,
};

const SELL_DOM: QuantTape = {
  crowded: null,
  oiReading: null,
  cascade: { active: false, side: null, fuel: "0" },
  flowReading: "sell_dom",
};

describe("quant veto", () => {
  test("AGENT_QUANT follows MAP kill pattern (default on, 0 off)", () => {
    delete process.env.AGENT_QUANT;
    expect(agentQuantEnabled()).toBe(true);
    process.env.AGENT_QUANT = "0";
    expect(agentQuantEnabled()).toBe(false);
    expect(quantVeto("demand", CASCADE_LONG)).toEqual({ allow: true, reason: "ok" });
  });

  test("one flow: cascade and crowded at both gates; opposing OI add is accept-only", () => {
    delete process.env.AGENT_QUANT;
    expect(quantVeto("demand", undefined)).toEqual({ allow: true, reason: "ok" });
    expect(quantVeto("demand", CASCADE_LONG).reason).toBe("quant_cascade");
    expect(quantVeto("supply", CASCADE_LONG).reason).toBe("ok");
    expect(quantVeto("demand", CROWDED_LONG).reason).toBe("quant_crowded");
    expect(quantVeto("supply", CROWDED_LONG).reason).toBe("ok");
    expect(quantVeto("demand", SHORT_ADD).reason).toBe("quant_oi");
    expect(quantVeto("demand", SHORT_ADD, "arm").reason).toBe("ok");
    expect(quantVeto("supply", SHORT_ADD).reason).toBe("ok");
    expect(quantVeto("demand", SELL_DOM).reason).toBe("quant_flow");
    expect(quantVeto("demand", SELL_DOM, "arm").reason).toBe("ok");
    expect(quantVeto("supply", SELL_DOM).reason).toBe("ok");
    expect(quantVeto("supply", {
      crowded: null,
      oiReading: "long_add",
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: null,
    }, "arm").reason).toBe("ok");
    expect(quantVeto("supply", {
      crowded: null,
      oiReading: null,
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: "buy_dom",
    }).reason).toBe("quant_flow");
    expect(quantVeto("supply", {
      crowded: null,
      oiReading: null,
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: "buy_dom",
    }, "arm").reason).toBe("ok");
    expect(quantVeto("demand", CASCADE_LONG, "arm").reason).toBe("quant_cascade");
    expect(quantVeto("demand", CROWDED_LONG, "arm").reason).toBe("quant_crowded");
    expect(quantVeto("demand", {
      crowded: null,
      oiReading: "cover",
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: null,
    }).reason).toBe("ok");
    expect(quantVeto("demand", {
      crowded: null,
      oiReading: "flush",
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: null,
    }, "arm").reason).toBe("ok");
    expect(quantVeto("demand", {
      crowded: null,
      oiReading: null,
      cascade: { active: true, side: null, fuel: "12" },
      flowReading: null,
    }).reason).toBe("ok");
    expect(quantVeto("demand", {
      crowded: null,
      oiReading: null,
      cascade: { active: false, side: null, fuel: "0" },
      flowReading: null,
    }).reason).toBe("ok");
    expect(readMapQuant({
      symbol: "ETHUSDT",
      flow: { delta: "1.2" },
    }).get("ETHUSDT")?.flowReading).toBeNull();
    expect(quantVeto("supply", {
      crowded: "short",
      oiReading: "long_add",
      cascade: { active: true, side: "short", fuel: "4" },
      flowReading: null,
    }).reason).toBe("quant_cascade");
  });

  test("readMapQuant walks /map batch", () => {
    const tapes = readMapQuant({
      maps: [{
        symbol: "BTCUSDT",
        funding: { crowded: "long" },
        oi: { reading: "short_add" },
        liq: { cascade: { active: true, side: "long", fuel: "8" } },
        flow: { reading: "sell_dom" },
      }],
    });
    expect(tapes.get("BTCUSDT")).toEqual({
      crowded: "long",
      oiReading: "short_add",
      cascade: { active: true, side: "long", fuel: "8" },
      flowReading: "sell_dom",
    });
  });
});
