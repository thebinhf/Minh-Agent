import { EMPTY_BRIEF_PACK_PAPER } from "./feed/bb/brief-pack";
import { startBybitTracker } from "./feed/bb/index";
import { startPaper } from "./paper/index";
import { paperDesk } from "./paper/ops";

/**
 * Minh Agent composition root.
 * Live feature: Bybit public WS market cache (`src/feed/bb`) on :43180.
 * Paper feature: simulated ledger (`src/paper`) on :43181. No keys, no real orders.
 *
 * Feed HTTP never imports paper. brief-pack reads the in-process paper engine
 * via this callback (same SQLite `paper status` uses). If paper is down, paper
 * arrays are empty. Feed does not call :43181.
 */
let paperDeskFn: (() => ReturnType<typeof paperDesk>) | null = null;

const bb = await startBybitTracker({
  paperDesk: () => paperDeskFn?.() ?? EMPTY_BRIEF_PACK_PAPER,
});
const paper = await startPaper();
paperDeskFn = () => paperDesk(paper.engine);

const shutdown = () => {
  console.log("[minh] shutting down");
  paper.stop();
  bb.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
