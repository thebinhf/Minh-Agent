import { loadConfig } from "./config";
import { openDb } from "./db";
import { startHttp } from "./http";
import { startPruner } from "./prune";
import { startTracker } from "./ws";

export type BybitTrackerFeature = {
  stop: () => void;
};

/** Bybit public linear WS → SQLite cache. No API keys, no trading. */
export async function startBybitTracker(): Promise<BybitTrackerFeature> {
  const config = await loadConfig();
  const store = openDb(config.dbPath);
  const http = startHttp(config, store);
  const tracker = startTracker(config, store);
  const pruner = startPruner(config, store);

  console.log(
    `[minh:bb] http://${config.httpHost}:${config.httpPort} db=${config.dbPath}`,
  );
  console.log("[minh:bb] public linear market data only — no API keys, no trading");

  return {
    stop() {
      tracker.stop();
      pruner.stop();
      http.stop();
      store.close();
    },
  };
}

export { buildBrief } from "./brief";
export { buildMap } from "./map";
export { loadConfig } from "./config";
export { openDb } from "./db";
export { buildChart, buildDepth, buildHeatmap, buildMarket, stitchBars } from "./view";
