import { startBybitTracker } from "./feed/bb/index";

/**
 * Minh Agent composition root.
 * First live feature: Bybit public WS market cache (`src/feed/bb`).
 */
const bb = await startBybitTracker();

const shutdown = () => {
  console.log("[minh] shutting down");
  bb.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
