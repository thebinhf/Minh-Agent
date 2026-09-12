import type { BriefPackPaperSource } from "./brief-pack";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { startKlineLagWatchdog } from "./health";
import { startHttp } from "./http";
import { createRelay } from "./relay";
import { startMapCloser, type MapCloseTick } from "./map-close";
import { startPruner } from "./prune";
import { startTracker } from "./ws";

export type BybitTrackerFeature = {
  stop: () => void;
};

export type BybitTrackerOpts = {
  /** Optional paper desk snapshot from the composition root (same process). */
  paperDesk?: BriefPackPaperSource;
  /** Observer snapshot. Feed does not import paper. */
  observe?: () => unknown | Promise<unknown>;
  /** After a 1H/4H MAP dump. Feed still does not import paper. */
  onMapClose?: (info: {
    interval: NonNullable<MapCloseTick["interval"]>;
    path: string;
    map: unknown;
  }) => Promise<void>;
};

/** Bybit public linear WS → SQLite cache. No API keys, no trading. */
export async function startBybitTracker(opts?: BybitTrackerOpts): Promise<BybitTrackerFeature> {
  const config = await loadConfig();
  const store = openDb(config.dbPath);
  const relay = createRelay();
  const http = startHttp(config, store, {
    paperDesk: opts?.paperDesk,
    observe: opts?.observe,
    relay,
  });
  const tracker = startTracker(config, store, { onRelay: (msg) => relay.publish(msg) });
  const pruner = startPruner(config, store);
  const klineLag = startKlineLagWatchdog(config, store);
  const mapClose = startMapCloser(config, store, { onClose: opts?.onMapClose });

  console.log(
    `[minh:bb] http://${config.httpHost}:${config.httpPort} ws://${config.httpHost}:${config.httpPort}/ws db=${config.dbPath}`,
  );
  console.log("[minh:bb] public linear market data only — no API keys, no trading");

  return {
    stop() {
      mapClose.stop();
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
export { buildZones } from "./zones";
export { loadConfig } from "./config";
export { openDb } from "./db";
export { buildFeedHealth, buildKlineLag } from "./health";
export { buildChart, buildDepth, buildHeatmap, buildMarket, stitchBars } from "./view";
