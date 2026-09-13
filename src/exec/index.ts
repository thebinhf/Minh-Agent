import { ExecAuthError, createExecClient, type ExecClient } from "./client";
import { loadExecConfig, type ExecConfig } from "./config";
import { openExecDb, type ExecDb } from "./db";
import { startExecHttp } from "./http";
import { refreshSpec, specStale } from "./instruments";

export type ExecFeature = {
  store: ExecDb;
  client: ExecClient;
  url: string;
  refreshSpec: () => Promise<void>;
  stop: () => void;
};

/**
 * Fourth process (bun run exec, :43183, own sqlite). Read-only on testnet or
 * mainnet. Never starts from src/index.ts. Auth-class failures stop the
 * process: a rejected key is a hard stop, not a retry or a host rotation.
 */
export async function startExec(opts?: {
  config?: ExecConfig;
  client?: ExecClient;
  probe?: boolean;
  specRefreshMs?: number;
}): Promise<ExecFeature> {
  const config = opts?.config ?? (await loadExecConfig());
  const store = openExecDb(config.dbPath);
  const client = opts?.client ?? createExecClient(config);
  const maxAgeHours = config.specMaxAgeHours;

  async function refresh(): Promise<void> {
    await refreshSpec(store, client, { maxAgeHours });
  }

  if (opts?.probe !== false) {
    try {
      await client.walletBalance("USDT");
      store.recordEvent("auth.ok", { mode: config.mode, baseUrl: config.baseUrl });
    } catch (error) {
      if (error instanceof ExecAuthError) {
        store.recordEvent("auth.failed", { mode: config.mode, detail: error.message });
        store.close();
        throw error;
      }
      // Network-class boot probe failure is data, not a verdict: auth stays
      // unchecked and the process starts so /exec/health can report it.
      store.recordEvent("auth.probe_error", { detail: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    await refresh();
  } catch (error) {
    if (error instanceof ExecAuthError) {
      store.close();
      throw error;
    }
    store.recordEvent("spec.refresh_error", { detail: error instanceof Error ? error.message : String(error) });
  }

  const http = startExecHttp(config, store, client, { specMaxAgeHours: maxAgeHours });

  const refreshMs = opts?.specRefreshMs ?? 6 * 3_600_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (refreshMs > 0) {
    timer = setInterval(() => {
      const spec = store.loadSpec();
      if (spec && !specStale(spec, Date.now(), maxAgeHours)) return;
      refresh().catch((error) => {
        store.recordEvent("spec.refresh_error", { detail: error instanceof Error ? error.message : String(error) });
      });
    }, refreshMs);
    timer.unref?.();
  }

  console.log(`[minh:exec] http://${config.httpHost}:${http.port} db=${config.dbPath} mode=${config.mode}`);
  console.log(`[minh:exec] read-only skeleton — no order placement (Stage 3), keys from credential files`);

  return {
    store,
    client,
    url: `http://${config.httpHost}:${http.port}`,
    refreshSpec: refresh,
    stop() {
      if (timer) clearInterval(timer);
      http.stop(true);
      store.close();
    },
  };
}

export { loadExecConfig, type ExecConfig } from "./config";
export { createExecClient, ExecAuthError, type ExecClient } from "./client";
export { openExecDb } from "./db";
export { refreshSpec, specStale } from "./instruments";
