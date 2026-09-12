#!/usr/bin/env bash
# One-flag paper A/B walk. Does not combine flags. Does not invent CVD/liq.
# Paper-only. Does not touch the live ledger. Not GitHub Actions.
#
#   deploy/replay-map-ab.sh baseline|chop0|floor1|arm2|arm5|arm0|skiphype|fib|osc|vol|shock|rev
#   deploy/replay-map-ab.sh compare BASE.json VARIANT.json
set -euo pipefail

ROOT="${MINH_ROOT:-/opt/minh-agent}"
OUT_DIR="${MINH_LAB_DIR:-$ROOT/lab}"
DAYS="${PAPER_LAB_DAYS:-180}"
NAME="${1:-}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if [[ -n "${BYBIT_API_KEY:-}" || -n "${BYBIT_API_SECRET:-}" ]]; then
  echo "[minh:ab] refuse: Bybit key env is set" >&2
  exit 1
fi

cd "$ROOT"

if [[ "$NAME" == "compare" ]]; then
  bun run paper ab "${2:?base json}" "${3:?variant json}"
  exit 0
fi

# Clear A/B knobs, then set exactly one. Default = current main (ARM_MAX=2).
unset AGENT_BIAS_CHOP PAPER_FAMILY_FLOOR_MIN_TRADES PAPER_MAP_SKIP PAPER_ARM_MAX \
  PAPER_TA_FIB AGENT_TA_OSC PAPER_TA_VOL PAPER_TA_SHOCK PAPER_TA_REV
case "$NAME" in
  baseline) ;;
  chop0) export AGENT_BIAS_CHOP=0 ;;
  floor1) export PAPER_FAMILY_FLOOR_MIN_TRADES=1 ;;
  arm2) export PAPER_ARM_MAX=2 ;;
  arm5) export PAPER_ARM_MAX=5 ;;
  arm0) export PAPER_ARM_MAX=0 ;;
  skiphype) export PAPER_MAP_SKIP=HYPEUSDT ;;
  fib) export PAPER_TA_FIB=arm ;;
  osc) export AGENT_TA_OSC=accept ;;
  vol) export PAPER_TA_VOL=arm ;;
  shock) export PAPER_TA_SHOCK=arm ;;
  rev) export PAPER_TA_REV=arm ;;
  *)
    echo "usage: $0 baseline|chop0|floor1|arm2|arm5|arm0|skiphype|fib|osc|vol|shock|rev" >&2
    echo "       $0 compare BASE.json VARIANT.json" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
JSON="$OUT_DIR/ab-${NAME}-${DAYS}-${STAMP}.json"
REVIEW="$OUT_DIR/ab-${NAME}-${DAYS}-${STAMP}.review.json"

echo "[minh:ab] $NAME days=$DAYS one-book" >&2
bun run paper replay-map --days "$DAYS" --one-book > "$JSON"
bun run paper review "$JSON" | tee "$REVIEW"

if [[ -n "${PAPER_AB_BASE:-}" ]]; then
  bun run paper ab "$PAPER_AB_BASE" "$REVIEW"
fi
