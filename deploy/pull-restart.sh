#!/usr/bin/env bash
# On the Minh host: fast-forward main and restart the systemd unit.
# No Bybit keys. Does not start from GitHub Actions.
set -euo pipefail

ROOT="${MINH_ROOT:-/opt/minh-agent}"
UNIT="${MINH_UNIT:-bybit-tracker}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

cd "$ROOT"
git fetch origin
git checkout main
git pull --ff-only origin main
bun install --frozen-lockfile
sudo systemctl restart "$UNIT"
sudo systemctl --no-pager --full status "$UNIT"
