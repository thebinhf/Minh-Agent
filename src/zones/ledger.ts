import { parseCancelCode, parseZoneCard, type CancelCode, type ZoneCard } from "./card";
import { intervalMsForTf } from "./detect";

/** Standing accepted cards. Suggest `/zones` does not write here. No auto-arm. */
export const LEDGER_STATUSES = ["accepted", "rejected", "expired"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const LEDGER_CAP_PER_SYMBOL = 2;

export type ZoneLedgerRow = {
  zoneId: string;
  symbol: string;
  status: LedgerStatus;
  card: ZoneCard;
  acceptedTs: number;
  expiresTs: number;
  rejectedTs: number | null;
  rejectCode: CancelCode | null;
};

export function isLedgerStatus(raw: unknown): raw is LedgerStatus {
  return raw === "accepted" || raw === "rejected" || raw === "expired";
}

export function parseLedgerStatus(raw: unknown): LedgerStatus {
  if (isLedgerStatus(raw)) return raw;
  throw new Error("invalid_ledger_status");
}

export function zoneExpiresTs(card: ZoneCard, acceptedTs: number): number {
  return acceptedTs + card.expiryBars * intervalMsForTf(card.tf);
}

export function ledgerDue(row: Pick<ZoneLedgerRow, "status" | "expiresTs">, now: number): boolean {
  return row.status === "accepted" && now >= row.expiresTs;
}

export function assertLedgerCap(acceptedForSymbol: number, cap = LEDGER_CAP_PER_SYMBOL): void {
  if (acceptedForSymbol >= cap) {
    throw new Error("ledger_cap");
  }
}

export function parseLedgerCard(raw: unknown): ZoneCard {
  return parseZoneCard(raw);
}

export function parseRejectCode(raw: unknown): CancelCode {
  if (raw == null || raw === "") return "ops_cancel";
  return parseCancelCode(raw);
}
