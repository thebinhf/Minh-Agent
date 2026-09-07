import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PaperReject } from "../../src/paper/errors";
import { mockFeed, paperEngine } from "./helpers";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function harness(feed = mockFeed()) {
  const ctx = await paperEngine(feed);
  dirs.push(ctx.dir);
  return ctx;
}

function reject(error: unknown): PaperReject {
  expect(error).toBeInstanceOf(PaperReject);
  return error as PaperReject;
}

describe("paper alerts", () => {
  test("arms a below alert and fires once on mark when last prints through", async () => {
    const feed = mockFeed({ lastPrice: "63000", markPrice: "63000" });
    const { engine } = await harness(feed);
    const created = await engine.setAlert({
      symbol: "BTCUSDT",
      op: "below",
      price: "62000",
      note: "HTF demand",
    });
    expect(created.mode).toBe("paper");
    expect(created.alert.status).toBe("armed");
    expect(created.alert.price).toBe("62000");
    expect(engine.alerts("armed")).toHaveLength(1);

    feed.ticker = async (symbol) => ({
      symbol,
      lastPrice: "61900",
      markPrice: "61900",
      recvTs: Date.now(),
      fundingRate: null,
      nextFundingTime: null,
    });
    const marked = await engine.mark();
    expect(marked.alerts).toHaveLength(1);
    expect(marked.alerts[0]?.status).toBe("fired");
    expect(marked.alerts[0]?.firedLast).toBe("61900");
    expect(marked.events.some((event) => event.kind === "alert.fired")).toBe(true);
    expect(engine.alerts("armed")).toHaveLength(0);

    const again = await engine.mark();
    expect(again.alerts).toHaveLength(0);
  });

  test("fires immediately if last is already through the level", async () => {
    const { engine } = await harness(mockFeed({ lastPrice: "63000" }));
    const created = await engine.setAlert({ symbol: "BTCUSDT", op: "above", price: "62000" });
    expect(created.alert.status).toBe("fired");
    expect(created.event?.kind).toBe("alert.fired");
  });

  test("rejects duplicate armed alerts and unknown symbols", async () => {
    const { engine } = await harness();
    await engine.setAlert({ symbol: "BTCUSDT", op: "above", price: "70000" });
    try {
      await engine.setAlert({ symbol: "BTCUSDT", op: "above", price: "70000" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("duplicate_alert");
    }
    try {
      await engine.setAlert({ symbol: "DOGEUSDT", op: "above", price: "1" });
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("unknown_symbol");
    }
  });

  test("cancel only works on armed alerts", async () => {
    const { engine } = await harness();
    const created = await engine.setAlert({ symbol: "ETHUSDT", op: "below", price: "1000" });
    const cancelled = engine.cancelAlert(created.alert.id);
    expect(cancelled.alert.status).toBe("cancelled");
    try {
      engine.cancelAlert(created.alert.id);
      throw new Error("expected reject");
    } catch (error) {
      expect(reject(error).error).toBe("alert_not_armed");
    }
  });
});
