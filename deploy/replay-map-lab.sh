#!/usr/bin/env bash
# Nightly paper lab: 180d one-book replay-map, then compact QC.
# Paper-only. Does not touch the live ledger. Does not invent CVD/liq.
# Does not run in GitHub Actions.
set -euo pipefail

ROOT="${MINH_ROOT:-/opt/minh-agent}"
OUT_DIR="${MINH_LAB_DIR:-$ROOT/lab}"
DAYS="${PAPER_LAB_DAYS:-180}"
TRAIN="${PAPER_LAB_TRAIN_DAYS:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if [[ -n "${BYBIT_API_KEY:-}" || -n "${BYBIT_API_SECRET:-}" ]]; then
  echo "[minh:lab] refuse: Bybit key env is set" >&2
  exit 1
fi

cd "$ROOT"
mkdir -p "$OUT_DIR"
JSON="$OUT_DIR/replay-map-${DAYS}-${STAMP}.json"
REVIEW="$OUT_DIR/review-${DAYS}-${STAMP}.json"
VERIFY="$OUT_DIR/verify-${STAMP}.log"

# Protect the live ledger before the walk, then record data honesty alongside results.
if [[ -x "$ROOT/deploy/backup-db.sh" ]]; then
  "$ROOT/deploy/backup-db.sh" || echo "[minh:lab] warn: backup failed, continuing" >&2
fi
# Verify is advisory (venue REST may be geo-blocked): log it, do not gate the lab.
bun run verify > "$VERIFY" 2>&1 || echo "[minh:lab] warn: verify-data failed, see $VERIFY" >&2

args=(replay-map --days "$DAYS" --one-book)
if [[ -n "$TRAIN" ]]; then
  args+=(--train-days "$TRAIN")
fi

if ! bun run paper "${args[@]}" > "$JSON"; then
  echo "[minh:lab] FAIL: replay-map failed (see $JSON)" >&2
  exit 1
fi
bun run paper review "$JSON" | tee "$REVIEW"
