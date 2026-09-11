import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applySqliteMemoryPragmas, reclaimWal } from "../sqlite";
import type { ZoneCard } from "../zones/card";
import { parseZoneCard } from "../zones/card";
import { zoneExpiresTs } from "../zones/ledger";

export type ShadowKind = "map_plan" | "arm_plan";

export type ShadowEvent = {
  id: number;
  ts: number;
  kind: ShadowKind;
  symbol: string;
  zoneId: string;
  allow: boolean;
  reason: string;
  last: string | null;
};

export type ShadowCard = {
  zoneId: string;
  symbol: string;
  card: ZoneCard;
  acceptedTs: number;
  expiresTs: number;
  status: "accepted" | "dropped";
  armedTs: number | null;
};

export type LiveDb = ReturnType<typeof openLiveDb>;

export function openLiveDb(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  applySqliteMemoryPragmas(db, true);
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_shadow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      allow INTEGER NOT NULL,
      reason TEXT NOT NULL,
      last TEXT,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS live_shadow_events_ts ON live_shadow_events (ts);
    CREATE TABLE IF NOT EXISTS live_shadow_cards (
      zone_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      card TEXT NOT NULL,
      accepted_ts INTEGER NOT NULL,
      expires_ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      armed_ts INTEGER
    );
  `);
  reclaimWal(db);

  const insertEvent = db.prepare(`
    INSERT INTO live_shadow_events (ts, kind, symbol, zone_id, allow, reason, last, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertCard = db.prepare(`
    INSERT INTO live_shadow_cards (zone_id, symbol, card, accepted_ts, expires_ts, status, armed_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(zone_id) DO UPDATE SET
      symbol = excluded.symbol,
      card = excluded.card,
      accepted_ts = excluded.accepted_ts,
      expires_ts = excluded.expires_ts,
      status = excluded.status,
      armed_ts = COALESCE(live_shadow_cards.armed_ts, excluded.armed_ts)
  `);
  const markArmed = db.prepare(`UPDATE live_shadow_cards SET armed_ts = ? WHERE zone_id = ? AND armed_ts IS NULL`);
  const dropCard = db.prepare(`UPDATE live_shadow_cards SET status = 'dropped' WHERE zone_id = ?`);
  const expireDue = db.prepare(`UPDATE live_shadow_cards SET status = 'dropped' WHERE status = 'accepted' AND expires_ts <= ?`);
  const listAccepted = db.prepare(`SELECT zone_id, symbol, card, accepted_ts, expires_ts, status, armed_ts FROM live_shadow_cards WHERE status = 'accepted'`);
  const countAcceptedSymbol = db.prepare(`SELECT COUNT(*) AS n FROM live_shadow_cards WHERE status = 'accepted' AND symbol = ?`);
  const listEvents = db.prepare(`SELECT id, ts, kind, symbol, zone_id, allow, reason, last FROM live_shadow_events ORDER BY id DESC LIMIT ?`);
  const countKind = db.prepare(`SELECT COUNT(*) AS n FROM live_shadow_events WHERE kind = ? AND allow = 1`);

  function asCard(row: {
    zone_id: string;
    symbol: string;
    card: string;
    accepted_ts: number;
    expires_ts: number;
    status: string;
    armed_ts: number | null;
  }): ShadowCard {
    return {
      zoneId: row.zone_id,
      symbol: row.symbol,
      card: parseZoneCard(JSON.parse(row.card) as unknown),
      acceptedTs: row.accepted_ts,
      expiresTs: row.expires_ts,
      status: row.status === "dropped" ? "dropped" : "accepted",
      armedTs: row.armed_ts,
    };
  }

  return {
    dbPath,
    close() {
      reclaimWal(db);
      db.close();
    },
    recordEvent(row: {
      ts: number;
      kind: ShadowKind;
      symbol: string;
      zoneId: string;
      allow: boolean;
      reason: string;
      last?: number;
      payload?: unknown;
    }) {
      insertEvent.run(
        row.ts,
        row.kind,
        row.symbol,
        row.zoneId,
        row.allow ? 1 : 0,
        row.reason,
        row.last != null && Number.isFinite(row.last) ? String(row.last) : null,
        row.payload == null ? null : JSON.stringify(row.payload),
      );
    },
    acceptCard(card: ZoneCard, ts: number) {
      upsertCard.run(
        card.zoneId,
        card.symbol,
        JSON.stringify(card),
        ts,
        zoneExpiresTs(card, ts),
        "accepted",
        null,
      );
    },
    drop(zoneId: string) {
      dropCard.run(zoneId);
    },
    markArmed(zoneId: string, ts: number) {
      markArmed.run(ts, zoneId);
    },
    expire(now: number) {
      expireDue.run(now);
    },
    accepted(now?: number): ShadowCard[] {
      const rows = listAccepted.all() as Array<{
        zone_id: string;
        symbol: string;
        card: string;
        accepted_ts: number;
        expires_ts: number;
        status: string;
        armed_ts: number | null;
      }>;
      const out = rows.map(asCard);
      if (now == null) return out;
      return out.filter((row) => row.expiresTs > now);
    },
    acceptedForSymbol(symbol: string): number {
      const row = countAcceptedSymbol.get(symbol) as { n: number };
      return Number(row?.n ?? 0);
    },
    events(limit = 50): ShadowEvent[] {
      const rows = listEvents.all(limit) as Array<{
        id: number;
        ts: number;
        kind: ShadowKind;
        symbol: string;
        zone_id: string;
        allow: number;
        reason: string;
        last: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: row.kind,
        symbol: row.symbol,
        zoneId: row.zone_id,
        allow: row.allow === 1,
        reason: row.reason,
        last: row.last,
      }));
    },
    counts() {
      const map = countKind.get("map_plan") as { n: number };
      const arm = countKind.get("arm_plan") as { n: number };
      return { mapAllow: Number(map?.n ?? 0), armAllow: Number(arm?.n ?? 0) };
    },
  };
}
