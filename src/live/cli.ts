import { PaperSafetyError } from "../paper/errors";
import { startLive } from "./index";

/**
 * Live-shadow daemon. Own bind :43182. Own sqlite.
 * Reads the public feed. Never opens the paper ledger. Never sends orders.
 */
try {
  const live = await startLive();
  const shutdown = () => {
    console.log("[minh:live] shutting down");
    live.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  if (error instanceof PaperSafetyError) {
    console.error(`[minh:live] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
