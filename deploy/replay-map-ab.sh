#!/usr/bin/env bash
# One-flag paper A/B walk. Does not combine flags. Does not invent CVD/liq.
# Paper-only. Does not touch the live ledger. Not GitHub Actions.
#
#   deploy/replay-map-ab.sh baseline|chop0|floor1|arm2|arm5|arm0|skiphype|fib|osc|vol|shock|rev|sd|breakout|reversal|fresh|impulse|be|scorerr
#   deploy/replay-map-ab.sh compare BASE.json VARIANT.json
#
# Session knobs (export once, then walk every arm):
#   PAPER_AB_FROM / PAPER_AB_TO  ISO dates — pin the window so all arms walk the
#                              same bars. Without them `--days N` is relative to
#                              each arm's start clock.
#   PAPER_LAB_TRAIN_DAYS       family-floor window, default 90 (`0` = in-sample)
#   PAPER_AB_BASE              review JSON to subtract after this arm's walk
#   PAPER_AB_BE_R / PAPER_AB_IMPULSE_MIN  the float a given arm applies
set -euo pipefail

ROOT="${MINH_ROOT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"}"
OUT_DIR="${MINH_LAB_DIR:-$ROOT/lab}"
DAYS="${PAPER_LAB_DAYS:-180}"
# House method: freeze the family floor on the first 90d so the holdout is honest.
# `0` = score the floor on the walk window itself (numbers are then in-sample).
TRAIN="${PAPER_LAB_TRAIN_DAYS-90}"
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
  PAPER_TA_FIB AGENT_TA_OSC PAPER_TA_VOL PAPER_TA_SHOCK PAPER_TA_REV PAPER_SETUPS \
  AGENT_ZONE_FRESH AGENT_ZONE_IMPULSE_MIN PAPER_BE_R PAPER_ZONE_SCORE_RR MINH_DECISION_LOG
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
  sd) export PAPER_SETUPS=sd ;;
  breakout) export PAPER_SETUPS=breakout ;;
  reversal) export PAPER_SETUPS=reversal ;;
  fresh) export AGENT_ZONE_FRESH=1 ;;
  impulse) export AGENT_ZONE_IMPULSE_MIN="${PAPER_AB_IMPULSE_MIN:-1.0}" ;;
  be) export PAPER_BE_R="${PAPER_AB_BE_R:-0.5}" ;;
  scorerr) export PAPER_ZONE_SCORE_RR=1 ;;
  *)
    echo "usage: $0 baseline|chop0|floor1|arm2|arm5|arm0|skiphype|fib|osc|vol|shock|rev|sd|breakout|reversal|fresh|impulse|be|scorerr" >&2
    echo "       $0 compare BASE.json VARIANT.json" >&2
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# `--days N` is relative to the clock at start, so arms walked 20 minutes apart
# do not share a window. Set PAPER_AB_FROM + PAPER_AB_TO once per session and
# every arm walks the same bars.
WINDOW=(--days "$DAYS")
WINDOW_LABEL="${DAYS}d"
if [[ -n "${PAPER_AB_FROM:-}" || -n "${PAPER_AB_TO:-}" ]]; then
  if [[ -z "${PAPER_AB_FROM:-}" || -z "${PAPER_AB_TO:-}" ]]; then
    echo "[minh:ab] PAPER_AB_FROM and PAPER_AB_TO must both be set (or neither)" >&2
    exit 1
  fi
  WINDOW=(--from "$PAPER_AB_FROM" --to "$PAPER_AB_TO")
  WINDOW_LABEL="${PAPER_AB_FROM}_$PAPER_AB_TO"
fi
args=(replay-map --one-book "${WINDOW[@]}")
if [[ -n "$TRAIN" && "$TRAIN" != "0" ]]; then
  args+=(--train-days "$TRAIN")
fi
JSON="$OUT_DIR/ab-${NAME}-${WINDOW_LABEL}-t${TRAIN:-none}-${STAMP}.json"
REVIEW="$OUT_DIR/ab-${NAME}-${WINDOW_LABEL}-t${TRAIN:-none}-${STAMP}.review.json"

echo "[minh:ab] $NAME window=$WINDOW_LABEL one-book train=${TRAIN:-none}" >&2
bun run paper "${args[@]}" > "$JSON"
bun run paper review "$JSON" | tee "$REVIEW"

if [[ -n "${PAPER_AB_BASE:-}" ]]; then
  bun run paper ab "$PAPER_AB_BASE" "$REVIEW"
fi
