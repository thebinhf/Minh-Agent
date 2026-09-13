import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecAuthError, createExecClient, type ExecClient } from "../../src/exec/client";
import { loadExecConfig, type ExecConfig } from "../../src/exec/config";
import { openExecDb } from "../../src/exec/db";
import { refreshSpec, specStale } from "../../src/exec/instruments";
import { startExec } from "../../src/exec/index";
import { ExecSafetyError } from "../../src/exec-mode";
import { loadPaperConfig } from "../../src/paper/config";
import { PaperSafetyError } from "../../src/paper/errors";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "minh-exec-"));
}

// Plain files plus closed sqlite dbs: rmSync can still lose a race with the
// handle release on Windows, and that is known noise, not a failure.
function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function writeKeys(dir: string): { keyFile: string; secretFile: string } {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, "bybit_api_key");
  const secretFile = join(dir, "bybit_api_secret");
  writeFileSync(keyFile, "test-key\n");
  writeFileSync(secretFile, "test-secret\n");
  return { keyFile, secretFile };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("exec config", () => {
  test("refuses implicit or ambiguous mode before anything else", async () => {
    await expect(loadExecConfig({})).rejects.toThrow(ExecSafetyError);
    await expect(loadExecConfig({ EXEC_MODE: "off" })).rejects.toThrow(/EXEC_MODE/);
  });

  test("refuses plaintext key env even though exec is the key process", async () => {
    await expect(
      loadExecConfig({ EXEC_MODE: "testnet", BYBIT_API_KEY: "x", BYBIT_API_SECRET: "y" }),
    ).rejects.toThrow(/credential files, never plaintext env/);
  });

  test("requires credential files", async () => {
    await expect(loadExecConfig({ EXEC_MODE: "testnet" })).rejects.toThrow(/credential files/);
  });

  test("EXEC_BASE_URL is testnet-only", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const { keyFile, secretFile } = writeKeys(dir);
    await expect(
      loadExecConfig({
        EXEC_MODE: "mainnet",
        EXEC_MAINNET_CONFIRM: "1",
        EXEC_KEY_FILE: keyFile,
        EXEC_KEY_SECRET_FILE: secretFile,
        EXEC_BASE_URL: "http://127.0.0.1:9",
      }),
    ).rejects.toThrow(/testnet-only/);
  });

  test("valid testnet config uses the official testnet host and :43183", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const { keyFile, secretFile } = writeKeys(dir);
    const config = await loadExecConfig({
      EXEC_MODE: "testnet",
      EXEC_KEY_FILE: keyFile,
      EXEC_KEY_SECRET_FILE: secretFile,
      EXEC_DB_PATH: join(dir, "exec.sqlite"),
    });
    expect(config.mode).toBe("testnet");
    expect(config.baseUrl).toBe("https://api-testnet.bybit.com");
    expect(config.httpPort).toBe(43183);
    expect(config.accountType).toBe("UNIFIED");
    expect(config.specMaxAgeHours).toBe(168);
  });

  test("exec db must differ from feed, paper and live dbs", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const { keyFile, secretFile } = writeKeys(dir);
    const paper = await loadPaperConfig();
    await expect(
      loadExecConfig({
        EXEC_MODE: "testnet",
        EXEC_KEY_FILE: keyFile,
        EXEC_KEY_SECRET_FILE: secretFile,
        EXEC_DB_PATH: paper.dbPath,
      }),
    ).rejects.toThrow(PaperSafetyError);
  });
});

describe("exec auth hard stop", () => {
  test("a rejected key is an auth-class error, latches, and never re-hosts", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(new URL(req.url).pathname);
        return Response.json({ retCode: 10003, retMsg: "API key invalid" }, { status: 401 });
      },
    });
    try {
      const client = createExecClient({
        mode: "testnet",
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "wrong",
        apiSecret: "wrong",
        accountType: "UNIFIED",
      });
      await expect(client.walletBalance()).rejects.toThrow(ExecAuthError);
      expect(client.authState()).toBe("failed");
      expect(seen).toEqual(["/v5/account/wallet-balance"]);
      // The latch: later signed calls fail locally, no second request leaves.
      await expect(client.positions()).rejects.toThrow(/refusing further signed calls/);
      await expect(client.walletBalance()).rejects.toThrow(ExecAuthError);
      expect(seen.length).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

function fakeClient(overrides: Partial<ExecClient> = {}): ExecClient {
  return {
    mode: "testnet",
    baseUrl: "https://api-testnet.bybit.com",
    accountType: "UNIFIED",
    authState: () => "ok",
    walletBalance: async () => ({ list: [{ totalEquity: "1000" }] }) as never,
    positions: async () => ({ list: [] }) as never,
    openOrders: async () => ({ list: [] }) as never,
    feeRate: async () => ({ list: [] }),
    instrumentsInfo: async () => ({
      list: [
        {
          symbol: "BTCUSDT",
          priceFilter: { tickSize: "0.10" },
          lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "5" },
          leverageFilter: { minLeverage: "1", maxLeverage: "150.00" },
        },
      ],
    }),
    ...overrides,
  };
}

function execConfig(dbPath: string): ExecConfig {
  return {
    mode: "testnet",
    baseUrl: "https://api-testnet.bybit.com",
    httpHost: "127.0.0.1",
    httpPort: 0,
    dbPath,
    apiKey: "test-key",
    apiSecret: "test-secret",
    accountType: "UNIFIED",
    specMaxAgeHours: 168,
  };
}

describe("instrument spec staleness", () => {
  test("missing spec refreshes; fresh spec does not refetch", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openExecDb(join(dir, "exec.sqlite"));
    try {
      const now = Date.now();
      let fetches = 0;
      const client = fakeClient({
        instrumentsInfo: async () => {
          fetches += 1;
          return fakeClient().instrumentsInfo();
        },
      });
      expect(store.loadSpec()).toBeNull();
      expect(specStale(store.loadSpec(), now, 168)).toBe(true);

      const first = await refreshSpec(store, client, { now, maxAgeHours: 168 });
      expect(first.refreshed).toBe(true);
      expect(first.reason).toBe("missing");
      expect(fetches).toBe(1);
      const saved = store.loadSpec();
      expect(saved).not.toBeNull();
      expect(specStale(saved, now, 168)).toBe(false);

      const again = await refreshSpec(store, client, { now, maxAgeHours: 168 });
      expect(again.refreshed).toBe(false);
      expect(again.reason).toBe("fresh");
      expect(fetches).toBe(1);

      const stale = await refreshSpec(store, client, {
        now: now + 169 * 3_600_000,
        maxAgeHours: 168,
      });
      expect(stale.refreshed).toBe(true);
      expect(stale.reason).toBe("stale");
      expect(fetches).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("exec http surface", () => {
  test("GET-only, health reports authenticated, and no order route exists", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const exec = await startExec({
      config: execConfig(join(dir, "exec.sqlite")),
      client: fakeClient(),
      specRefreshMs: 0,
    });
    try {
      const base = exec.url;

      const healthRes = await fetch(`${base}/exec/health`);
      const health = (await healthRes.json()) as Record<string, unknown>;
      expect(healthRes.status).toBe(200);
      expect(health.mode).toBe("exec");
      expect(health.execMode).toBe("testnet");
      expect(health.authenticated).toBe(true);
      expect(health.orders).toBe(false);
      const spec = health.spec as Record<string, unknown>;
      expect(spec.stale).toBe(false);
      expect(spec.symbols).toBe(1);

      const walletRes = await fetch(`${base}/exec/wallet`);
      expect(walletRes.status).toBe(200);

      const instrumentsRes = await fetch(`${base}/exec/instruments`);
      const instruments = (await instrumentsRes.json()) as Record<string, unknown>;
      expect(instrumentsRes.status).toBe(200);
      expect((instruments.symbols as Record<string, unknown>).BTCUSDT).toBeDefined();

      const post = await fetch(`${base}/exec/health`, { method: "POST" });
      expect(post.status).toBe(405);
      const put = await fetch(`${base}/exec/wallet`, { method: "PUT" });
      expect(put.status).toBe(405);

      const orderRoute = await fetch(`${base}/exec/order`, { method: "POST" });
      expect(orderRoute.status).toBe(405);
      const unknown = await fetch(`${base}/exec/nope`);
      expect(unknown.status).toBe(404);
    } finally {
      exec.stop();
    }
  });

  test("auth failure during boot stops the process with the auth error", async () => {
    const dir = tempDir();
    dirs.push(dir);
    let authState: "unchecked" | "ok" | "failed" = "unchecked";
    const client = fakeClient({
      authState: () => authState,
      walletBalance: async () => {
        authState = "failed";
        throw new ExecAuthError("bybit rejected credentials (testnet): retCode 10003");
      },
    });
    await expect(
      startExec({ config: execConfig(join(dir, "exec.sqlite")), client, specRefreshMs: 0 }),
    ).rejects.toThrow(ExecAuthError);
  });
});
