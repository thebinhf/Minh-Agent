import { EMPTY_BRIEF_PACK_PAPER } from "./feed/bb/brief-pack";
import { startBybitTracker } from "./feed/bb/index";
import { startPaper, type PaperFeature } from "./paper/index";
import { fetchZoneCards, lastPricesFromMap, mapAcceptEnabled, runMapAccept } from "./paper/map-accept";
import { paperDesk } from "./paper/ops";

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
 */
let paperDeskFn: (() => ReturnType<typeof paperDesk>) | null = null;
let paperRef: PaperFeature | null = null;

const bb = await startBybitTracker({
  paperDesk: () => paperDeskFn?.() ?? EMPTY_BRIEF_PACK_PAPER,
  onMapClose: async ({ interval, map }) => {
    if (interval !== "240") return;
    if (!mapAcceptEnabled() || !paperRef) return;
    try {
      const cards = await fetchZoneCards("http://127.0.0.1:43180");
      const result = runMapAccept(paperRef.engine, cards, lastPricesFromMap(map));
      if (result.accepted.length) {
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
