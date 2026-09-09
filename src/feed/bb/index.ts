import type { BriefPackPaperSource } from "./brief-pack";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { startKlineLagWatchdog } from "./health";
import { startHttp } from "./http";
import { startPruner } from "./prune";
import { startTracker } from "./ws";

export type BybitTrackerFeature = {
  stop: () => void;
};

export type BybitTrackerOpts = {
  /** Optional paper desk snapshot from the composition root (same process). */
  paperDesk?: BriefPackPaperSource;
};

/** Bybit public linear WS → SQLite cache. No API keys, no trading. */
export async function startBybitTracker(opts?: BybitTrackerOpts): Promise<BybitTrackerFeature> {
  const config = await loadConfig();
  const store = openDb(config.dbPath);
  const http = startHttp(config, store, { paperDesk: opts?.paperDesk });
  const tracker = startTracker(config, store);
  const pruner = startPruner(config, store);
  const klineLag = startKlineLagWatchdog(config, store);

  console.log(
    `[minh:bb] http://${config.httpHost}:${config.httpPort} db=${config.dbPath}`,
  );
  console.log("[minh:bb] public linear market data only — no API keys, no trading");

  return {
    stop() {
      klineLag.stop();
      tracker.stop();
      pruner.stop();
      http.stop();
      store.close();
    },
  };
}

export { buildBrief } from "./brief";
export { buildBriefPack } from "./brief-pack";
export { buildConfirm } from "./confirm";
export { buildMap, buildMapBatch } from "./map";
export { loadConfig } from "./config";
export { openDb } from "./db";
export { buildFeedHealth, buildKlineLag } from "./health";
export { buildChart, buildDepth, buildHeatmap, buildMarket, stitchBars } from "./view";
