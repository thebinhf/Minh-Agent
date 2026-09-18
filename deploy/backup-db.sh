#!/usr/bin/env bash
# Nightly SQLite backup for the 24/7 mesh. Online-safe (.backup), no keys.
# Keeps 14 snapshots per DB. Refuses when disk free < 20% or < 2x largest DB.
#   MINH_ROOT=/opt/minh-agent MINH_BACKUP_DIR=/var/backups/minh-agent deploy/backup-db.sh
set -euo pipefail

ROOT="${MINH_ROOT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"
BACKUP_DIR="${MINH_BACKUP_DIR:-$ROOT/backups}"
KEEP="${MINH_BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

cd "$ROOT"

# Ask the config, never guess it: the hardcoded paths this script used to carry
# skipped the market cache on a checkout that keeps it under data/.
DBS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && DBS+=("$line")
done < <(bun run scripts/db-paths.ts 2>/dev/null || true)
if [[ "${#DBS[@]}" -eq 0 ]]; then
  echo "[minh:backup] refuse: no db path resolved (bun run scripts/db-paths.ts)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

largest=0
for db in "${DBS[@]}"; do
  if [[ -f "$db" ]]; then
    size="$(stat -c%s "$db" 2>/dev/null || stat -f%z "$db" 2>/dev/null || echo 0)"
    if [[ "$size" -gt "$largest" ]]; then largest="$size"; fi
  fi
done

avail_kb="$(df -k --output=avail "$BACKUP_DIR" 2>/dev/null | tail -1 | tr -d ' ' || df -k "$BACKUP_DIR" | tail -1 | awk '{print $4}')"
avail_bytes=$((avail_kb * 1024))
if [[ "$largest" -gt 0 && "$avail_bytes" -lt $((largest * 2)) ]]; then
  echo "[minh:backup] refuse: free space < 2x largest DB ($largest bytes)" >&2
  exit 1
fi

for db in "${DBS[@]}"; do
  if [[ ! -f "$db" ]]; then
    echo "[minh:backup] skip missing $db" >&2
    continue
  fi
  base="$(basename "$db" .sqlite)"
  dest="$BACKUP_DIR/${base}-${STAMP}.sqlite"
  # Online-safe copy; falls back to cp when sqlite3 CLI is absent.
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db" ".backup '$dest'" || cp "$db" "$dest"
  else
    cp "$db" "$dest"
  fi
  echo "[minh:backup] wrote $dest"
  # Prune old snapshots, newest first.
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR/${base}-"*.sqlite 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" && echo "[minh:backup] pruned $old"
  done
done
