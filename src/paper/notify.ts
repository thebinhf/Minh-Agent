import type { EventView, NotifyChannel, NotifyConfig } from "./types";

/** Event-once pings. Not mid-watch PnL. */
export const NOTIFY_KINDS = [
  "alert.fired",
  "order.filled",
  "order.invalidated",
  "position.closed",
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifyFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export type NotifyResult = {
  sent: boolean;
  skipped?: string;
  error?: string;
  attempts?: number;
};

const NOTIFY_TIMEOUT_MS = 5_000;
const NOTIFY_RETRY_DELAY_MS = 400;

export function parseNotifyChannel(raw: string | undefined): NotifyChannel {
  const channel = (raw ?? "log").trim().toLowerCase();
  if (channel === "telegram" || channel === "webhook" || channel === "off" || channel === "log") {
    return channel;
  }
  return "log";
}

export function normalizeNotifyKinds(raw: unknown): NotifyKind[] {
  const allowed = new Set<string>(NOTIFY_KINDS);
  const list = Array.isArray(raw) ? raw.map((item) => String(item)) : [...NOTIFY_KINDS];
  const kinds = list.filter((kind): kind is NotifyKind => allowed.has(kind));
  return kinds.length > 0 ? kinds : [...NOTIFY_KINDS];
}

export function shouldNotify(config: NotifyConfig, kind: string): boolean {
  if (config.channel === "off" || config.channel === "log") return false;
  return config.kinds.includes(kind as NotifyKind);
}

export function formatNotifyText(event: EventView): string {
  const symbol = event.symbol ?? "";
  const payload = event.payload;
  if (event.kind === "alert.fired") {
    return `[minh:paper] alert.fired ${symbol} ${payload.op ?? ""} ${payload.price ?? ""} last=${payload.last ?? ""}`.trim();
  }
  if (event.kind === "order.filled") {
    return `[minh:paper] order.filled ${symbol} @ ${payload.limitPrice ?? ""} qty=${payload.qty ?? ""}`.trim();
  }
  if (event.kind === "order.invalidated") {
    return `[minh:paper] order.invalidated ${symbol} invalidate=${payload.invalidate ?? ""} last=${payload.last ?? ""}`.trim();
  }
  if (event.kind === "position.closed") {
    return `[minh:paper] position.closed ${symbol} ${payload.closeReason ?? ""} @ ${payload.closePrice ?? ""} pnl=${payload.realizedPnl ?? ""}`.trim();
  }
  return `[minh:paper] ${event.kind} ${symbol}`.trim();
}

export function describeNotify(config: NotifyConfig): string {
  if (config.channel === "off") return "off";
  if (config.channel === "telegram") {
    if (!config.telegramBotToken || !config.telegramChatId) {
      return "log (telegram missing PAPER_TELEGRAM_BOT_TOKEN / PAPER_TELEGRAM_CHAT_ID)";
    }
    return `telegram ${config.kinds.join(",")}`;
  }
  if (config.channel === "webhook") {
    if (!config.webhookUrl) return "log (webhook missing PAPER_NOTIFY_URL)";
    return `webhook ${config.kinds.join(",")}`;
  }
  return "log";
}

/** Strip tokens / basic-auth so logs never echo secrets. */
export function redactNotifyText(raw: string, config: NotifyConfig): string {
  let out = raw.replace(/\/bot[^/]+/gi, "/bot***");
  for (const secret of [config.telegramBotToken, config.telegramChatId]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  if (config.webhookUrl) {
    out = out.split(config.webhookUrl).join("***");
    try {
      const parsed = new URL(config.webhookUrl);
      if (parsed.username) out = out.split(parsed.username).join("***");
      if (parsed.password) out = out.split(parsed.password).join("***");
    } catch {
      /* ignore invalid URL */
    }
  }
  return out;
}

export function notifyRetryable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PostResult = { ok: true } | { ok: false; status?: number; error: string };

async function postOnce(
  fetchImpl: NotifyFetch,
  url: string,
  init: RequestInit,
): Promise<PostResult> {
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, error: String(res.status) };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "TimeoutError" || /timeout|aborted/i.test(message)) {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: `network ${message}` };
  }
}

async function postWithRetry(
  fetchImpl: NotifyFetch,
  url: string,
  init: RequestInit,
  retryDelayMs: number,
): Promise<PostResult & { attempts: number }> {
  let last: PostResult = { ok: false, error: "network" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await postOnce(fetchImpl, url, init);
    if (last.ok) return { ...last, attempts: attempt };
    if (!notifyRetryable(last.status) || attempt === 2) return { ...last, attempts: attempt };
    if (retryDelayMs > 0) await sleep(retryDelayMs);
  }
  return { ...last, attempts: 2 };
}

function telegramRequest(config: NotifyConfig, text: string): { url: string; init: RequestInit } | NotifyResult {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return { sent: false, skipped: "missing_telegram" };
  }
  return {
    url: `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  };
}

function webhookRequest(config: NotifyConfig, event: EventView, text: string): { url: string; init: RequestInit } | NotifyResult {
  if (!config.webhookUrl) return { sent: false, skipped: "missing_webhook" };
  return {
    url: config.webhookUrl,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: event.kind,
        symbol: event.symbol,
        payload: event.payload,
        ts: event.ts,
        text,
      }),
    },
  };
}

export async function dispatchNotify(
  config: NotifyConfig,
  event: EventView,
  fetchImpl: NotifyFetch = fetch,
  retryDelayMs = NOTIFY_RETRY_DELAY_MS,
): Promise<NotifyResult> {
  if (config.channel === "off" || config.channel === "log") {
    return { sent: false, skipped: config.channel };
  }
  if (!config.kinds.includes(event.kind as NotifyKind)) {
    return { sent: false, skipped: "kind" };
  }
  const text = formatNotifyText(event);
  const request = config.channel === "telegram"
    ? telegramRequest(config, text)
    : webhookRequest(config, event, text);
  if ("sent" in request) return request;

  const result = await postWithRetry(fetchImpl, request.url, request.init, retryDelayMs);
  if (result.ok) return { sent: true, attempts: result.attempts };
  return {
    sent: false,
    attempts: result.attempts,
    error: redactNotifyText(
      `${config.channel} ${result.error}${result.attempts > 1 ? ` after ${result.attempts} attempts` : ""}`,
      config,
    ),
  };
}

export function bindPaperNotify(
  config: NotifyConfig,
  fetchImpl: NotifyFetch = fetch,
): (event: EventView) => void {
  let warnedMissing = false;
  return (event) => {
    void dispatchNotify(config, event, fetchImpl).then((result) => {
      if (result.skipped === "missing_telegram" || result.skipped === "missing_webhook") {
        if (warnedMissing) return;
        warnedMissing = true;
        console.error(`[minh:paper] notify ${result.skipped} — further events stay log-only`);
        return;
      }
      if (result.error) {
        console.error(
          `[minh:paper] notify failed kind=${event.kind} symbol=${event.symbol ?? ""} ${result.error}`,
        );
      }
    });
  };
}
