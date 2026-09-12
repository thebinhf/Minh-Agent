import { afterEach, describe, expect, test } from "bun:test";
import { PaperSafetyError } from "../../src/paper/errors";
import { assertNoApiKeys } from "../../src/paper/config";
import {
  describeNotify,
  dispatchNotify,
  formatNotifyText,
  normalizeNotifyKinds,
  notifyBackoffMs,
  notifyRetryable,
  parseNotifyChannel,
  parseRetryAfter,
  redactNotifyText,
  shouldNotify,
} from "../../src/paper/notify";
import type { EventView, NotifyConfig } from "../../src/paper/types";
import { mockFeed, paperEngine } from "./helpers";

const TELEGRAM = ["PAPER_NOTIFY", "PAPER_TELEGRAM_BOT_TOKEN", "PAPER_TELEGRAM_CHAT_ID", "PAPER_NOTIFY_URL"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const name of TELEGRAM) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
    delete saved[name];
  }
});

function event(kind: string, payload: Record<string, unknown> = {}): EventView {
  return { id: 1, kind, symbol: "BTCUSDT", payload, ts: 1_700_000_000_000, zoneId: null };
}

const telegramCfg: NotifyConfig = {
  channel: "telegram",
  kinds: ["alert.fired", "order.filled", "order.invalidated", "position.closed"],
  telegramBotToken: "bot-token",
  telegramChatId: "12345",
};

describe("paper notify", () => {
  test("parses channel and locks kinds to event-once set", () => {
    expect(parseNotifyChannel("TELEGRAM")).toBe("telegram");
    expect(parseNotifyChannel("nope")).toBe("log");
    expect(normalizeNotifyKinds(["alert.fired", "pnl.tick", "order.cancelled", "zone.accepted"]))
      .toEqual(["alert.fired", "zone.accepted"]);
    expect(shouldNotify(telegramCfg, "alert.fired")).toBe(true);
    expect(shouldNotify(telegramCfg, "order.cancelled")).toBe(false);
    expect(shouldNotify({ ...telegramCfg, channel: "log" }, "alert.fired")).toBe(false);
  });

  test("formats a one-line ping without PnL spam fields for idle marks", () => {
    expect(formatNotifyText(event("alert.fired", { op: "below", price: "117500", last: "117400" })))
      .toContain("alert.fired BTCUSDT below 117500");
    expect(formatNotifyText(event("order.filled", { limitPrice: "117500", qty: "0.15" })))
      .toContain("order.filled BTCUSDT @ 117500");
    expect(formatNotifyText(event("order.invalidated", { invalidate: "116200", last: "116000" })))
      .toContain("order.invalidated");
    expect(formatNotifyText(event("position.closed", { closeReason: "sl", closePrice: "116200", realizedPnl: "-30" })))
      .toContain("pnl=-30");
    expect(formatNotifyText(event("zone.accepted", { zoneId: "btc-4h-s-01", side: "supply", setup: "sd" })))
      .toContain("zone.accepted");
    expect(formatNotifyText(event("zone.armed", { zoneId: "btc-4h-s-01", limitPrice: "79200" })))
      .toContain("zone.armed");
  });

  test("telegram POSTs sendMessage; cancelled/rejected are skipped", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };
    const sent = await dispatchNotify(telegramCfg, event("alert.fired", { op: "below", price: "1", last: "1" }), fetchImpl);
    const skipped = await dispatchNotify(telegramCfg, event("order.cancelled", { orderId: 8 }), fetchImpl);
    expect(sent).toEqual({ sent: true, attempts: 1 });
    expect(skipped).toEqual({ sent: false, skipped: "kind" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(calls[0]?.body).toMatchObject({ chat_id: "12345" });
  });

  test("webhook POSTs JSON; fetch failure does not throw", async () => {
    const cfg: NotifyConfig = {
      channel: "webhook",
      kinds: telegramCfg.kinds,
      webhookUrl: "https://example.invalid/hook",
    };
    const ok = await dispatchNotify(cfg, event("order.filled", { limitPrice: "62000", qty: "0.1" }), async (url, init) => {
      expect(String(url)).toBe("https://example.invalid/hook");
      const body = JSON.parse(String(init?.body));
      expect(body.kind).toBe("order.filled");
      expect(body.text).toContain("order.filled");
      return new Response("ok", { status: 200 });
    });
    expect(ok).toEqual({ sent: true, attempts: 1 });
    const failed = await dispatchNotify(cfg, event("order.filled", {}), async () => {
      throw new Error("network down https://example.invalid/hook");
    }, { retryDelayMs: 0 });
    expect(failed.sent).toBe(false);
    expect(failed.attempts).toBe(3);
    expect(failed.error).toContain("webhook network");
    expect(failed.error).toContain("after 3 attempts");
    expect(failed.error).not.toContain("example.invalid/hook");
  });

  test("retries 5xx once; does not retry 4xx; redacts telegram token from errors", async () => {
    expect(notifyRetryable(500)).toBe(true);
    expect(notifyRetryable(429)).toBe(true);
    expect(notifyRetryable(401)).toBe(false);
    expect(redactNotifyText("https://api.telegram.org/botbot-token/sendMessage", telegramCfg))
      .toBe("https://api.telegram.org/bot***/sendMessage");

    let n = 0;
    const recovered = await dispatchNotify(
      { channel: "webhook", kinds: telegramCfg.kinds, webhookUrl: "https://hook.example/x" },
      event("alert.fired", { op: "below", price: "1", last: "1" }),
      async () => {
        n += 1;
        return new Response("nope", { status: n === 1 ? 503 : 200 });
      },
      { retryDelayMs: 0 },
    );
    expect(recovered).toEqual({ sent: true, attempts: 2 });

    const calls: number[] = [];
    const clientErr = await dispatchNotify(
      telegramCfg,
      event("alert.fired", { op: "below", price: "1", last: "1" }),
      async (url) => {
        calls.push(1);
        throw new Error(`fetch failed ${String(url)}`);
      },
      { retryDelayMs: 0 },
    );
    expect(calls).toHaveLength(3);
    expect(clientErr.error).not.toContain("bot-token");
    expect(clientErr.error).toContain("bot***");

    const unauthorized = await dispatchNotify(
      telegramCfg,
      event("alert.fired", { op: "below", price: "1", last: "1" }),
      async () => new Response("no", { status: 401 }),
      { retryDelayMs: 0 },
    );
    expect(unauthorized).toEqual({ sent: false, attempts: 1, error: "telegram 401" });
  });

  test("equal-jitter exponential backoff, cap, and Retry-After", async () => {
    expect(notifyBackoffMs(1, { jitter: 0 })).toBe(200);
    expect(notifyBackoffMs(1, { jitter: 1 })).toBe(400);
    expect(notifyBackoffMs(2, { jitter: 1 })).toBe(800);
    expect(notifyBackoffMs(3, { jitter: 1 })).toBe(1600);
    expect(notifyBackoffMs(8, { jitter: 1 })).toBe(4000);
    expect(notifyBackoffMs(1, { jitter: 1, retryAfterMs: 2500 })).toBe(2500);
    expect(notifyBackoffMs(1, { jitter: 1, retryAfterMs: 30_000 })).toBe(4000);
    expect(notifyBackoffMs(1, { baseMs: 0, retryAfterMs: 2000 })).toBe(0);
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("30")).toBe(4000);
    expect(parseRetryAfter("nope")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"))).toBe(2000);

    const slept: number[] = [];
    const rateLimited = await dispatchNotify(
      telegramCfg,
      event("alert.fired", { op: "below", price: "1", last: "1" }),
      async () => new Response(JSON.stringify({ parameters: { retry_after: 3 } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
      {
        random: () => 1,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(rateLimited.sent).toBe(false);
    expect(rateLimited.attempts).toBe(3);
    expect(slept).toEqual([3000, 3000]);
  });

  test("missing telegram secrets skip send; Bybit key refuse is unchanged", () => {
    expect(describeNotify({ channel: "telegram", kinds: telegramCfg.kinds })).toContain("missing");
    process.env.PAPER_TELEGRAM_BOT_TOKEN = "tg-token";
    expect(() => assertNoApiKeys()).not.toThrow(PaperSafetyError);
    process.env.BYBIT_API_KEY = "not-a-real-key";
    expect(() => assertNoApiKeys()).toThrow(PaperSafetyError);
    delete process.env.BYBIT_API_KEY;
  });

  test("engine onEvent fires for an immediate alert, not for a no-op mark", async () => {
    const seen: string[] = [];
    const feed = mockFeed({ lastPrice: "59000", markPrice: "59000" });
    const ctx = await paperEngine(feed);
    const engine = (await import("../../src/paper/engine")).createPaperEngine({
      store: ctx.store,
      feed,
      config: ctx.config,
      universe: { symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], intervals: ["5", "15", "60", "240"] },
      onEvent: (row) => {
        seen.push(row.kind);
      },
    });
    await engine.setAlert({ symbol: "BTCUSDT", op: "below", price: "60000" });
    await engine.mark();
    expect(seen).toEqual(["alert.fired"]);
    ctx.store.close();
  });
});
