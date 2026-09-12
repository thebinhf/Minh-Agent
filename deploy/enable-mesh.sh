#!/usr/bin/env bash
# Enable the 24/7 autonomous mesh. You observe (GET /observe, notify).
# No Bybit keys. Does not run in GitHub Actions.
#   feed+paper (bybit-tracker, PAPER_OBSERVE=1) + live-shadow + nightly lab
set -euo pipefail

ROOT="${MINH_ROOT:-/opt/minh-agent}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if [[ -n "${BYBIT_API_KEY:-}" || -n "${BYBIT_API_SECRET:-}" ]]; then
  echo "[minh:mesh] refuse: Bybit key env is set" >&2
  exit 1
fi

cd "$ROOT"
sudo systemctl daemon-reload
sudo systemctl enable bybit-tracker.service live-shadow.service replay-map-lab.timer minh.target
sudo systemctl enable --now minh.target
sudo systemctl --no-pager --full status bybit-tracker.service live-shadow.service replay-map-lab.timer minh.target || true
