#!/usr/bin/env bash
# Nightly paper lab: 180d one-book replay-map, then compact QC.
# Paper-only. Does not touch the live ledger. Does not invent CVD/liq.
# Does not run in GitHub Actions.
set -euo pipefail

ROOT="${MINH_ROOT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"
OUT_DIR="${MINH_LAB_DIR:-$ROOT/lab}"
DAYS="${PAPER_LAB_DAYS:-180}"
# Same house method as deploy/replay-map-ab.sh: freeze the family floor on the
# first 90d so a nightly number stays comparable with an A/B holdout. `0` / "" = no freeze.
TRAIN="${PAPER_LAB_TRAIN_DAYS-90}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if [[ -n "${BYBIT_API_KEY:-}" || -n "${BYBIT_API_SECRET:-}" ]]; then
  echo "[minh:lab] refuse: Bybit key env is set" >&2
  exit 1
fi

cd "$ROOT"
mkdir -p "$OUT_DIR"
# A nightly must be the default method: drop any A/B knob still in the shell.
unset AGENT_BIAS_CHOP PAPER_FAMILY_FLOOR_MIN_TRADES PAPER_MAP_SKIP PAPER_ARM_MAX \
  PAPER_TA_FIB AGENT_TA_OSC PAPER_TA_VOL PAPER_TA_SHOCK PAPER_TA_REV PAPER_SETUPS \
  AGENT_ZONE_FRESH AGENT_ZONE_IMPULSE_MIN PAPER_ZONE_SCORE_RR PAPER_BE_R MINH_DECISION_LOG
JSON="$OUT_DIR/replay-map-${DAYS}d-t${TRAIN:-none}-${STAMP}.json"
REVIEW="$OUT_DIR/review-${DAYS}d-t${TRAIN:-none}-${STAMP}.json"
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
