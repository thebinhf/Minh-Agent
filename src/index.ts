import { startBybitTracker } from "./feed/bb/index";
import { startPaper } from "./paper/index";

/**
 * Minh Agent composition root.
 * Live feature: Bybit public WS market cache (`src/feed/bb`) on :43180.
 * Paper feature: simulated ledger (`src/paper`) on :43181. No keys, no real orders.
 */
const bb = await startBybitTracker();
const paper = await startPaper();

const shutdown = () => {
  console.log("[minh] shutting down");
  paper.stop();
  bb.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
