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
};

const CROWDED_LONG: QuantTape = {
  crowded: "long",
  oiReading: null,
  cascade: { active: false, side: null, fuel: "0" },
};

const SHORT_ADD: QuantTape = {
  crowded: null,
  oiReading: "short_add",
  cascade: { active: false, side: null, fuel: "0" },
};

describe("quant veto", () => {
  test("AGENT_QUANT follows MAP kill pattern (default on, 0 off)", () => {
    delete process.env.AGENT_QUANT;
    expect(agentQuantEnabled()).toBe(true);
    process.env.AGENT_QUANT = "0";
    expect(agentQuantEnabled()).toBe(false);
    expect(quantVeto("demand", CASCADE_LONG)).toEqual({ allow: true, reason: "ok" });
  });

  test("one flow: cascade then crowded then opposing OI add; missing tape is not a veto", () => {
    delete process.env.AGENT_QUANT;
    expect(quantVeto("demand", undefined)).toEqual({ allow: true, reason: "ok" });
    expect(quantVeto("demand", CASCADE_LONG).reason).toBe("quant_cascade");
    expect(quantVeto("supply", CASCADE_LONG).reason).toBe("ok");
    expect(quantVeto("demand", CROWDED_LONG).reason).toBe("quant_crowded");
    expect(quantVeto("supply", CROWDED_LONG).reason).toBe("ok");
    expect(quantVeto("demand", SHORT_ADD).reason).toBe("quant_oi");
    expect(quantVeto("supply", SHORT_ADD).reason).toBe("ok");
    expect(quantVeto("supply", {
      crowded: "short",
      oiReading: "long_add",
      cascade: { active: true, side: "short", fuel: "4" },
    }).reason).toBe("quant_cascade");
  });

  test("readMapQuant walks /map batch", () => {
    const tapes = readMapQuant({
      maps: [{
        symbol: "BTCUSDT",
        funding: { crowded: "long" },
        oi: { reading: "short_add" },
        liq: { cascade: { active: true, side: "long", fuel: "8" } },
      }],
    });
    expect(tapes.get("BTCUSDT")).toEqual({
      crowded: "long",
      oiReading: "short_add",
      cascade: { active: true, side: "long", fuel: "8" },
    });
  });
});
