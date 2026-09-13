import {
  BASE_URL_MAINNET,
  BASE_URL_TESTNET,
  BybitApiError,
  BybitAuthError,
  BybitClient,
  isAuthRetCode,
  type AccountType,
  type OpenOrdersResult,
  type PositionInfoResult,
  type WalletBalanceResult,
} from "bybit-official-ts-sdk";
import type { ExecMode } from "../exec-mode";

/** Auth-class failure: hard stop. Never retried, never re-hosted, no failover. */
export class ExecAuthError extends Error {}

export type ExecAuthState = "unchecked" | "ok" | "failed";

export type ExecClientConfig = {
  mode: ExecMode;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  accountType: string;
};

/**
 * The whole venue surface exec may touch, read-only. Order placement does not
 * exist yet (Stage 3). The SDK must not leak past src/exec/, so callers see
 * this interface only.
 */
export interface ExecClient {
  readonly mode: ExecMode;
  readonly baseUrl: string;
  readonly accountType: string;
  authState(): ExecAuthState;
  walletBalance(coin?: string): Promise<WalletBalanceResult>;
  positions(): Promise<PositionInfoResult>;
  openOrders(): Promise<OpenOrdersResult>;
  feeRate(symbol?: string): Promise<unknown>;
  instrumentsInfo(): Promise<unknown>;
}

export function bybitBaseUrl(mode: ExecMode): string {
  return mode === "mainnet" ? BASE_URL_MAINNET : BASE_URL_TESTNET;
}

function isAuthLike(error: unknown): boolean {
  if (error instanceof BybitAuthError) return true;
  if (error instanceof BybitApiError) return isAuthRetCode(error.retCode);
  // axios-shaped transport errors can carry a status the SDK did not classify;
  // 401/403 on a signed call is an auth verdict either way.
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

function messageOf(error: unknown): string {
  if (error instanceof BybitApiError) return `retCode ${error.retCode}: ${error.retMsg}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createExecClient(config: ExecClientConfig): ExecClient {
  const sdk = new BybitClient({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    testnet: config.mode === "testnet",
    baseUrl: config.baseUrl,
  });
  let auth: ExecAuthState = "unchecked";
  let authDetail = "";

  async function signed<T>(
    call: () => Promise<{ retCode: number; retMsg?: string; result: T }>,
  ): Promise<T> {
    if (auth === "failed") {
      throw new ExecAuthError(
        `exec auth already failed; refusing further signed calls: ${authDetail}`,
      );
    }
    try {
      const res = await call();
      if (isAuthRetCode(res.retCode)) {
        auth = "failed";
        authDetail = `retCode ${res.retCode}: ${res.retMsg ?? "auth rejected"}`;
        throw new ExecAuthError(
          `bybit rejected credentials (${config.mode}); hard stop, no retry, no host failover: ${authDetail}`,
        );
      }
      auth = "ok";
      return res.result;
    } catch (error) {
      if (isAuthLike(error)) {
        auth = "failed";
        authDetail = messageOf(error);
        throw new ExecAuthError(
          `bybit rejected credentials (${config.mode}); hard stop, no retry, no host failover: ${authDetail}`,
        );
      }
      throw error;
    }
  }

  const accountType = config.accountType as AccountType;
  return {
    mode: config.mode,
    baseUrl: config.baseUrl,
    accountType: config.accountType,
    authState: () => auth,
    walletBalance: (coin) => signed(() => sdk.account.getWalletBalance({ accountType, coin })),
    positions: () => signed(() => sdk.position.getPositionInfo({ category: "linear", settleCoin: "USDT" })),
    openOrders: () => signed(() => sdk.trade.getOpenOrders({ category: "linear", settleCoin: "USDT" })),
    feeRate: (symbol) =>
      signed(async () => {
        const res = await sdk.account.getFeeRate({ category: "linear", symbol });
        return { retCode: res.retCode, retMsg: res.retMsg, result: res.result as unknown };
      }),
    // instruments-info is a public endpoint: it must not mark auth as ok.
    instrumentsInfo: async () => (await sdk.market.getInstrumentsInfo({ category: "linear", limit: 1000 })).result,
  };
}
