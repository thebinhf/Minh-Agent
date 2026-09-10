import type { TrackerDb } from "./db";
import type { TrackerConfig } from "./types";

export function startPruner(config: TrackerConfig, store: TrackerDb) {
  const run = () => {
    const result = store.prune(Date.now(), config.retention);
    console.log(
      `[minh:bb] prune ticker=${result.tickerDeleted} book=${result.bookDeleted} kline=${result.klineDeleted} oi=${result.oiDeleted} funding=${result.fundingDeleted} liq=${result.liqDeleted}` +
        (result.vacuumed ? " vacuum=1" : "") +
        ` wal=${result.walTruncated ? "trunc" : "passive"} busy=${result.walBusy} log=${result.walLog}`,
    );
  };

  run();
  const timer = setInterval(run, config.retention.pruneIntervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
