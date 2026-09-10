import { existsSync } from "node:fs";
import { parseZoneCard, type ZoneCard } from "../zones/card";
import { PaperReject } from "./errors";

export function feedHttpBase(feedUrl: string): string {
  return feedUrl.replace(/\/$/, "").replace(/\/health$/, "");
}

export function pickZoneCard(payload: unknown, zoneId: string): ZoneCard | null {
  if (!payload || typeof payload !== "object") return null;
  const zones = (payload as { zones?: unknown }).zones;
  if (!Array.isArray(zones)) return null;
  const hit = zones.find((row) => (
    row && typeof row === "object" && String((row as { zoneId?: unknown }).zoneId) === zoneId
  ));
  if (!hit) return null;
  return parseZoneCard(hit);
}

export function isZoneCardBody(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && "zoneLow" in raw && "zoneId" in raw);
}

export function acceptTokenKind(token: string): "file" | "zoneId" {
  if (token.endsWith(".json") || token.includes("/") || existsSync(token)) return "file";
  return "zoneId";
}

export async function lookupSuggestedZone(
  feedUrl: string,
  zoneId: string,
  getJson: (url: string) => Promise<unknown> = fetchJson,
): Promise<ZoneCard> {
  const id = zoneId.trim();
  if (!id) throw new PaperReject("invalid_zone_id", "zoneId", { zoneId });
  const base = feedHttpBase(feedUrl);
  for (const interval of ["240", "60"] as const) {
    const payload = await getJson(`${base}/zones?interval=${interval}`);
    const card = pickZoneCard(payload, id);
    if (card) return card;
  }
  throw new PaperReject("not_found", "zoneId", { zoneId: id, source: "zones" });
}

export async function resolveAcceptPayload(
  raw: unknown,
  feedUrl: string,
  getJson?: (url: string) => Promise<unknown>,
): Promise<ZoneCard> {
  if (isZoneCardBody(raw)) return parseZoneCard(raw);
  const zoneId = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object"
      ? String((raw as { zoneId?: unknown }).zoneId ?? "")
      : "";
  if (!zoneId) throw new PaperReject("invalid_zone_id", "zoneId", { zoneId });
  return lookupSuggestedZone(feedUrl, zoneId, getJson);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new PaperReject("zones_lookup_failed", "feed", { url, status: res.status });
  return res.json();
}
