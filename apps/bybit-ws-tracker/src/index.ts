import { loadConfig } from "./config";
import { openDb } from "./db";
import { startHttp } from "./http";
import { startPruner } from "./prune";
import { startTracker } from "./ws";

const config = await loadConfig();
const store = openDb(config.dbPath);
const http = startHttp(config, store);
const tracker = startTracker(config, store);
const pruner = startPruner(config, store);

console.log(`[bybit-ws] http://${config.httpHost}:${config.httpPort} db=${config.dbPath}`);
console.log("[bybit-ws] public linear market data only — no API keys, no trading");

const shutdown = () => {
  console.log("[bybit-ws] shutting down");
  tracker.stop();
  pruner.stop();
  http.stop();
  store.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
