import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createPaperEngine } from "../../src/paper/engine";
import type { PaperFeed } from "../../src/paper/types";
import { mockFeed, tempStore } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("paper evaluation serialization", () => {
  test("overlapping evaluations queue instead of sharing tick state", async () => {
    const ctx = await tempStore();
    dirs.push(ctx.dir);

    // Gate the first evaluation inside feed.health(): a second evaluate must
    // queue behind it, not run its body concurrently against shared state.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const base = mockFeed();
    const feed: PaperFeed = {
      ...base,
      async health() {
        if (!gated) {
          gated = true;
          await gate;
        }
        return base.health();
      },
    };

    const engine = createPaperEngine({
      store: ctx.store,
      feed,
      config: ctx.config,
      universe: { symbols: ["BTCUSDT"], intervals: ["15", "60", "240"] },
    });

    const first = engine.evaluate(Date.now());
    const second = engine.evaluate(Date.now());
    release!();
    const a = (await first) as { mode: string };
    const b = (await second) as { mode: string };
    expect(a.mode).toBe("paper");
    expect(b.mode).toBe("paper");
    ctx.store.close();
  });
});
