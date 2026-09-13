export type ExecMode = "testnet" | "mainnet";

export class ExecSafetyError extends Error {}

/** Refuses to start without an explicit EXEC_MODE; mainnet needs a second flag. */
export function assertExecMode(env: NodeJS.ProcessEnv = process.env): ExecMode {
  const mode = env.EXEC_MODE;
  if (mode !== "testnet" && mode !== "mainnet") {
    throw new ExecSafetyError(
      `EXEC_MODE must be set to "testnet" or "mainnet" (got ${
        mode === undefined ? "unset" : JSON.stringify(mode)
      }); exec refuses to start implicitly`,
    );
  }
  if (mode === "mainnet" && env.EXEC_MAINNET_CONFIRM !== "1") {
    throw new ExecSafetyError("EXEC_MODE=mainnet also requires EXEC_MAINNET_CONFIRM=1");
  }
  return mode;
}
