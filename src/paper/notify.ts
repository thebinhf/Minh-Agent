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
};

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

export async function dispatchNotify(
  config: NotifyConfig,
  event: EventView,
  fetchImpl: NotifyFetch = fetch,
): Promise<NotifyResult> {
  if (config.channel === "off" || config.channel === "log") {
    return { sent: false, skipped: config.channel };
  }
  if (!config.kinds.includes(event.kind as NotifyKind)) {
    return { sent: false, skipped: "kind" };
  }
  const text = formatNotifyText(event);
  try {
    if (config.channel === "telegram") {
      if (!config.telegramBotToken || !config.telegramChatId) {
        return { sent: false, skipped: "missing_telegram" };
      }
      const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { sent: false, error: `telegram ${res.status}` };
      return { sent: true };
    }
    if (!config.webhookUrl) return { sent: false, skipped: "missing_webhook" };
    const res = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: event.kind,
        symbol: event.symbol,
        payload: event.payload,
        ts: event.ts,
        text,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { sent: false, error: `webhook ${res.status}` };
    return { sent: true };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function bindPaperNotify(
  config: NotifyConfig,
  fetchImpl: NotifyFetch = fetch,
): (event: EventView) => void {
  return (event) => {
    void dispatchNotify(config, event, fetchImpl).then((result) => {
      if (result.error) console.error("[minh:paper] notify", result.error);
    });
  };
}
