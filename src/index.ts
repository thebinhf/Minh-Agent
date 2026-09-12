import { loadFeedHealth, onMapCloseAccept } from "./agent/policy";
import { EMPTY_BRIEF_PACK_PAPER } from "./feed/bb/brief-pack";
import { startBybitTracker } from "./feed/bb/index";
import { startPaper, type PaperFeature } from "./paper/index";
import { paperDesk } from "./paper/ops";
import { paperObserve } from "./paper/observe";
import { taOscFromMap } from "./ta/arm-tape";

/**
 * Minh Agent composition root — autonomous paper desk.
 * Observer: GET /observe (feed) and GET /paper/observe. No operator arm.
 * 4H map.close → policy → acceptZone → proximity ARM → OCO tick.
 */
let paperDeskFn: (() => ReturnType<typeof paperDesk>) | null = null;
let paperRef: PaperFeature | null = null;

const bb = await startBybitTracker({
  paperDesk: () => paperDeskFn?.() ?? EMPTY_BRIEF_PACK_PAPER,
  observe: () => paperRef ? paperObserve(paperRef.engine) : {
    mode: "observe",
    observer: true,
    paper: null,
    note: "paper starting",
  },
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
