import { startBybitTracker } from "./feed/bb/index";

/**
 * Minh Agent composition root.
 * First live feature: Bybit public WS market cache (`src/feed/bb`).
 * Read-only HTTP (started with the tracker) includes GET /brief — same JSON as `bun run brief`.
 */
const bb = await startBybitTracker();

const shutdown = () => {
  console.log("[minh] shutting down");
  bb.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
