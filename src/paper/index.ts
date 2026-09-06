import { loadConfig as loadFeedConfig } from "../feed/bb/config";
import { assertNoApiKeys, assertSeparateDb, loadPaperConfig } from "./config";
import { openPaperDb } from "./db";
import { createPaperEngine, type PaperEngine } from "./engine";
import { httpFeed } from "./feed";
import { startPaperHttp } from "./http";
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
}): Promise<PaperFeature> {
  assertNoApiKeys();
  const config = opts?.config ?? await loadPaperConfig();
  const feedCfg = await loadFeedConfig();
  assertSeparateDb(config.dbPath, feedCfg.dbPath);
  const store = openPaperDb(config.dbPath, config.account);
  const feed = opts?.feed ?? httpFeed(config.feedUrl);
  const universe = opts?.universe ?? { symbols: feedCfg.symbols, intervals: feedCfg.klineIntervals };
  const engine = createPaperEngine({ store, feed, config, universe });
  const http = startPaperHttp(config, engine, feed);

  console.log(`[minh:paper] http://${config.httpHost}:${http.port} db=${config.dbPath}`);
  console.log("[minh:paper] paper simulation only — no API keys, no real orders");

  return {
    engine,
    url: `http://${config.httpHost}:${http.port}`,
    stop() {
      http.stop();
      store.close();
    },
  };
}

export { assertNoApiKeys, loadPaperConfig } from "./config";
export { createPaperEngine } from "./engine";
export { httpFeed } from "./feed";
export { startPaperHttp } from "./http";
