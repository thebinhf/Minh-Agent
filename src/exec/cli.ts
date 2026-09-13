import { ExecAuthError } from "./client";
import { startExec } from "./index";
import { ExecSafetyError } from "../exec-mode";

/**
 * Exec daemon. Own bind :43183. Own sqlite. Keys from credential files.
 * Read-only skeleton (Stage 2): wallet, positions, open orders, fees,
 * instrument spec. Order placement does not exist until Stage 3.
 */
try {
  const exec = await startExec();
  const shutdown = () => {
    console.log("[minh:exec] shutting down");
    exec.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  if (error instanceof ExecSafetyError || error instanceof ExecAuthError) {
    console.error(`[minh:exec] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
