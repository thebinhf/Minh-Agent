import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { createPaperEngine, type PaperEngine } from "./engine";
import { PaperReject } from "./errors";
import { httpFeed } from "./feed";
import { startPaperHttp } from "./http";
import { bindPaperNotify, describeNotify } from "./notify";
import { observerMode } from "./observe";
import type { PaperConfig, PaperFeed } from "./types";
import type { PaperUniverse } from "./engine";

export type PaperFeature = {
  stop: () => void;
  engine: PaperEngine;
  url: string;
};

export async function startPaper(opts?: {
  config?: PaperConfig;
  feed?: PaperFeed;
  universe?: PaperUniverse;
  tick?: boolean;
}): Promise<PaperFeature> {
  assertNoApiKeys();
  const config = opts?.config ?? await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  assertSeparateDb(config.dbPath, feedCfg.dbPath);
  const store = openPaperDb(config.dbPath, config.account);
  const feed = opts?.feed ?? httpFeed(config.feedUrl);
  const universe = opts?.universe ?? { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals };
  const engine = createPaperEngine({
    store,
    feed,
    config,
    universe,
    onEvent: bindPaperNotify(config.notify),
  });
  const http = startPaperHttp(config, engine, feed);
  const tick = opts?.tick !== false;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (tick && config.tickMs > 0) {
    timer = setInterval(() => {
      engine.evaluate().then((result) => {
        for (const event of result.events) {
          console.log(`[minh:paper] ${event.kind} ${event.symbol ?? ""} ${JSON.stringify(event.payload)}`);
        }
      }).catch((error) => {
        if (error instanceof PaperReject) return;
        console.error("[minh:paper] tick", error instanceof Error ? error.message : error);
      });
    }, config.tickMs);
    timer.unref?.();
  }

  console.log(`[minh:paper] http://${config.httpHost}:${http.port} db=${config.dbPath}`);
  console.log("[minh:paper] paper simulation only — no API keys, no real orders");
  console.log(`[minh:paper] notify ${describeNotify(config.notify)}`);
  if (observerMode()) {
    console.log("[minh:paper] observer — POST mutations blocked; MAP/ARM/EVENT in-process");
  }
  if (tick) {
    console.log(`[minh:paper] tick ${config.tickMs}ms — alerts/limits/SL-TP; events only, no PnL spam`);
  }

  return {
    engine,
    url: `http://${config.httpHost}:${http.port}`,
    stop() {
      if (timer) clearInterval(timer);
      http.stop();
      store.close();
    },
  };
}

export { assertNoApiKeys, loadPaperConfig } from "./config";
export { createPaperEngine } from "./engine";
export { httpFeed } from "./feed";
export { startPaperHttp } from "./http";
export { paperDesk } from "./ops";
