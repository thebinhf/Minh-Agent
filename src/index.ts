import { loadFeedHealth, onMapCloseAccept } from "./agent/policy";
import { EMPTY_BRIEF_PACK_PAPER } from "./feed/bb/brief-pack";
import { startBybitTracker } from "./feed/bb/index";
import { startPaper, type PaperFeature } from "./paper/index";
import { paperDesk } from "./paper/ops";
import { taOscFromMap } from "./ta/arm-tape";

/**
 * Minh Agent composition root.
 * Live feature: Bybit public WS market cache (`src/feed/bb`) on :43180.
 * Paper feature: simulated ledger (`src/paper`) on :43181. No keys, no real orders.
 *
 * Feed HTTP never imports paper. brief-pack reads the in-process paper engine
 * via this callback (same SQLite `paper status` uses). paper.source is the
 * paper HTTP bind (`http://127.0.0.1:43181`) so Minh knows the desk; arrays
 * still come from the in-process engine (no :43181 hop). If paper is down,
 * paper arrays are empty and source is null.
 *
 * 4H map.close → MAP_ACCEPT pick → agent policy → acceptZone.
 * AGENT_MAP=0: policy no-op; old MAP_ACCEPT path still copies if MAP_ACCEPT is on.
 * MAP_ACCEPT=0: old accept path off. Neither path arms or closes opens.
 */
let paperDeskFn: (() => ReturnType<typeof paperDesk>) | null = null;
let paperRef: PaperFeature | null = null;

const bb = await startBybitTracker({
  paperDesk: () => paperDeskFn?.() ?? EMPTY_BRIEF_PACK_PAPER,
  onMapClose: async ({ interval, map }) => {
    try {
      const health = await loadFeedHealth();
      const result = await onMapCloseAccept({ interval, map }, paperRef?.engine ?? null, {
        health,
        oscBySymbol: taOscFromMap(map),
      });
      if (result?.accepted.length) {
        console.log(`[minh] map accept ${result.accepted.join(",")}`);
      }
    } catch (error) {
      console.error("[minh] map accept", error instanceof Error ? error.message : error);
    }
  },
});
const paper = await startPaper();
paperRef = paper;
paperDeskFn = () => paperDesk(paper.engine, paper.url);

const shutdown = () => {
  console.log("[minh] shutting down");
  paper.stop();
  bb.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
