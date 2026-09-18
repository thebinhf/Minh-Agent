#!/usr/bin/env bash
# Host ops check: feed + paper + shadow health, kline lag, disk, lab freshness.
# Designed for cron/systemd timer every 5m. Exit 0 = ok, 1 = page the operator.
# Paging reuses PAPER_NOTIFY=telegram|webhook; log-only otherwise.
set -uo pipefail

FEED="${MINH_FEED_URL:-http://127.0.0.1:43180}"
PAPER="${MINH_PAPER_URL:-http://127.0.0.1:43181}"
SHADOW="${MINH_SHADOW_URL:-http://127.0.0.1:43182}"
LAB_DIR="${MINH_LAB_DIR:-/opt/minh-agent/lab}"
DISK_WARN="${MINH_DISK_WARN_PCT:-80}"
LAB_MAX_AGE_H="${MINH_LAB_MAX_AGE_H:-30}"

fail=()
warn_msg=""

check() {
  local name="$1" url="$2"
  if ! curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
    fail+=("$name down ($url)")
  fi
}

check "feed" "$FEED/health"
check "paper" "$PAPER/paper/health"
# Shadow is fail-soft by design: warn, do not page.
if ! curl -fsS --max-time 5 "$SHADOW/live/health" >/dev/null 2>&1; then
  warn_msg="live-shadow down ($SHADOW/live/health)"
fi

# klineLag gate: tradingAllowed=false while ticker live = STAND ASIDE, page.
lag="$(curl -fsS --max-time 5 "$FEED/health" 2>/dev/null | grep -o '"ok":false' | head -1 || true)"
if [[ -n "$lag" ]]; then
  fail+=("klineLag ok=false on $FEED/health")
fi

# Disk: page when use% >= threshold on the DB filesystem.
usepct="$(df --output=pcent /var/lib/bybit-ws-tracker 2>/dev/null | tail -1 | tr -dc '0-9' || df / 2>/dev/null | tail -1 | awk '{print $5}' | tr -dc '0-9')"
if [[ -n "$usepct" && "$usepct" -ge "$DISK_WARN" ]]; then
  fail+=("disk ${usepct}% >= ${DISK_WARN}%")
fi

# Lab freshness: warn (not page) when the nightly walk is stale.
if [[ -d "$LAB_DIR" ]]; then
  latest="$(ls -1t "$LAB_DIR"/review-*.json 2>/dev/null | head -1 || true)"
  if [[ -z "$latest" ]]; then
    warn_msg="$warn_msg; no lab review yet in $LAB_DIR"
  elif [[ "$(find "$latest" -mmin +$((LAB_MAX_AGE_H * 60)) 2>/dev/null)" != "" ]]; then
    warn_msg="$warn_msg; lab stale: $latest older than ${LAB_MAX_AGE_H}h"
  fi
fi

if [[ "${#fail[@]}" -gt 0 ]]; then
  msg="[minh:ops] FAIL: ${fail[*]}${warn_msg:+ | warn:$warn_msg}"
  echo "$msg" >&2
  if [[ "${PAPER_NOTIFY:-log}" == "telegram" && -n "${PAPER_TELEGRAM_BOT_TOKEN:-}" && -n "${PAPER_TELEGRAM_CHAT_ID:-}" ]]; then
    curl -fsS --max-time 10 "https://api.telegram.org/bot${PAPER_TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${PAPER_TELEGRAM_CHAT_ID}" -d "text=${msg}" >/dev/null 2>&1 || true
  elif [[ "${PAPER_NOTIFY:-log}" == "webhook" && -n "${PAPER_NOTIFY_URL:-}" ]]; then
    curl -fsS --max-time 10 -X POST "${PAPER_NOTIFY_URL}" -d "${msg}" >/dev/null 2>&1 || true
  fi
  exit 1
fi

if [[ -n "$warn_msg" ]]; then
  echo "[minh:ops] warn:$warn_msg" >&2
fi
echo "[minh:ops] ok"
