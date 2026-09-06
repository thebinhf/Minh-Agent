import { describe, expect, test } from "bun:test";
import { parsePaperArgs, PAPER_USAGE, runPaperCommand } from "../../src/paper/cli";
import { PaperUsageError } from "../../src/paper/errors";
import { mockFeed, paperEngine, OPEN_LONG } from "./helpers";

describe("paper CLI parser", () => {
  test("parses open / positions / close / mark", () => {
    expect(parsePaperArgs(["account"])).toEqual({ name: "account" });
    expect(parsePaperArgs(["positions", "--status", "all"])).toEqual({ name: "positions", status: "all" });
    expect(parsePaperArgs(["mark"])).toEqual({ name: "mark" });
    expect(parsePaperArgs(["close", "4"])).toEqual({ name: "close", id: 4 });
    expect(parsePaperArgs([
      "open", "btcusdt", "--side", "long", "--sl", "60000", "--tp", "66000",
      "--tf", "240,60,15", "--risk-pct", "0.03", "--note", "htf bias",
    ])).toEqual({
      name: "open",
      symbol: "btcusdt",
      side: "long",
      stopLoss: "60000",
      takeProfit: "66000",
      timeframes: ["240", "60", "15"],
      riskPct: "0.03",
      note: "htf bias",
    });
    expect(parsePaperArgs([
      "open", "BTCUSDT", "--side", "long", "--sl", "60000",
      "--tps", "64500:0.5,66000:0.5", "--tf", "60,15", "--leverage", "10",
    ])).toEqual({
      name: "open",
      symbol: "BTCUSDT",
      side: "long",
      stopLoss: "60000",
      takeProfits: [
        { price: "64500", qtyPct: "0.5" },
        { price: "66000", qtyPct: "0.5" },
      ],
      timeframes: ["60", "15"],
      leverage: "10",
      riskPct: undefined,
      note: undefined,
    });
  });

  test("usage errors for --help and missing --tf", () => {
    expect(() => parsePaperArgs(["--help"])).toThrow(PaperUsageError);
    expect(() => parsePaperArgs(["-h"])).toThrow(PaperUsageError);
    expect(() => parsePaperArgs([])).toThrow(PaperUsageError);
    expect(() => parsePaperArgs(["open", "BTCUSDT", "--side", "long", "--sl", "1", "--tp", "2"])).toThrow(PaperUsageError);
    expect(() => parsePaperArgs(["open", "BTCUSDT", "--side", "long", "--sl", "1", "--tf", "60,15"])).toThrow(PaperUsageError);
    try {
      parsePaperArgs(["--help"]);
    } catch (error) {
      expect((error as PaperUsageError).message).toBe(PAPER_USAGE);
      expect(PAPER_USAGE).toContain("Paper simulation only");
      expect(PAPER_USAGE).not.toContain("live trade");
    }
  });
});

describe("paper CLI runner", () => {
  test("account and open print paper-mode JSON", async () => {
    const { engine, store } = await paperEngine(mockFeed());
    try {
      const account = await runPaperCommand(engine, { name: "account" });
      expect(account).toMatchObject({ mode: "paper", name: "minh-paper", cash: "10000" });
      const opened = await runPaperCommand(engine, {
        name: "open",
        symbol: OPEN_LONG.symbol,
        side: OPEN_LONG.side,
        stopLoss: OPEN_LONG.stopLoss,
        takeProfit: OPEN_LONG.takeProfit,
        timeframes: OPEN_LONG.timeframes,
        riskPct: OPEN_LONG.riskPct,
      }) as { mode: string; position: { qty: string } };
      expect(opened.mode).toBe("paper");
      expect(opened.position.qty).toBe("0.1");
    } finally {
      store.close();
    }
  });
});
