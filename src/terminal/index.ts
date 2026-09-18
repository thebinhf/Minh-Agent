/**
 * Trading Terminal (T3) — read-only live view of the mesh.
 *
 * Viewer only, per the ROADMAP lock: this file issues `GET` and nothing else.
 * It never imports the paper engine, never opens a store, and never posts, so
 * it cannot place, arm, accept or cancel anything. Ports come from the same
 * configs the daemons boot from; `--feed` / `--paper` override.
 *
 *   bun run term                 # redraw every 5s (TTY)
 *   bun run term --interval 15
 *   bun run term --once          # single snapshot, exit 1 if the feed is down
 */
import { buildTerminalModel, renderTerminal, type TerminalModel } from "./view";
import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { liveShadowObserveUrl } from "../feed/bb/observe";
import { loadPaperConfig } from "../paper/config";

type Args = {
  feedUrl: string | null;
  paperUrl: string | null;
  intervalSec: number;
  once: boolean;
  help: boolean;
};

const USAGE = `usage: bun run term [--once] [--interval <sec>] [--feed <url>] [--paper <url>]
       read-only viewer — it never sends a command to the desk
`;

export function parseTerminalArgs(argv: string[]): Args {
  const out: Args = { feedUrl: null, paperUrl: null, intervalSec: 5, once: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") out.once = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--interval") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 1) throw new Error(`--interval needs a whole number of seconds >= 1`);
      out.intervalSec = Math.floor(n);
      i += 1;
    } else if (arg === "--feed") {
      out.feedUrl = requireUrl(argv[++i], "--feed");
    } else if (arg === "--paper") {
      out.paperUrl = requireUrl(argv[++i], "--paper");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function requireUrl(raw: string | undefined, flag: string): string {
  if (!raw || !/^https?:\/\/\S+$/.test(raw)) throw new Error(`${flag} needs an http(s) URL`);
  return raw.replace(/\/+$/, "");
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function resolveUrls(args: Args): Promise<{ feed: string; paper: string }> {
  const [feed, paper] = await Promise.all([loadFeedConfig(), loadPaperConfig()]);
  return {
    feed: args.feedUrl ?? `http://127.0.0.1:${feed.httpPort}`,
    paper: args.paperUrl ?? `http://127.0.0.1:${paper.httpPort}`,
  };
}

/**
 * The single-process host embeds the desk in feed `/observe`; the split host
 * (paper on its own port) does not. Both shapes end up as one model.
 *
 * `/zones` and the shadow body are the two extra reads the verdict panel needs:
 * the detector's current MAP and the policy's per-card answer. Both are fail-soft.
 */
async function readModel(
  urls: { feed: string; paper: string },
  shadowUrl: string | null,
  now: number,
): Promise<TerminalModel> {
  const observe = await getJson(`${urls.feed}/observe`, 2_000);
  const body = observe && typeof observe === "object" ? observe as Record<string, unknown> : null;
  let paper = body?.paper;
  if (paper === null || paper === undefined) {
    paper = await getJson(`${urls.paper}/paper/observe`, 2_000);
  }
  const [cardBody, shadowBody] = await Promise.all([
    getJson(`${urls.feed}/zones?interval=240`, 2_000),
    shadowUrl ? getJson(shadowUrl, 1_000) : Promise.resolve(null),
  ]);
  return buildTerminalModel(
    { ...(body ?? {}), paper: paper ?? null, cardBody: cardBody ?? null, shadowBody: shadowBody ?? null },
    now,
  );
}

function paint(model: TerminalModel, first: boolean): void {
  const text = renderTerminal(model);
  if (process.stdout.isTTY && !first) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
  process.stdout.write(text);
}

export async function runTerminal(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  const args = parseTerminalArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const urls = await resolveUrls(args);
  const shadowUrl = liveShadowObserveUrl();
  let first = true;
  for (;;) {
    const now = Date.now();
    let model: TerminalModel;
    try {
      model = await readModel(urls, shadowUrl, now);
    } catch (error) {
      process.stderr.write(`[minh:term] ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    paint(model, first);
    first = false;
    process.stdout.write(
      `SOURCES feed=${urls.feed} · desk=${urls.paper}/paper · shadow=${shadowUrl ?? "off (LIVE_SHADOW_URL unset)"}\n`,
    );
    if (args.once) return model.feed === null ? 1 : 0;
    await Bun.sleep(args.intervalSec * 1000);
  }
}

if (import.meta.main) {
  process.exitCode = await runTerminal();
}
