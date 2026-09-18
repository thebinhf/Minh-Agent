#!/usr/bin/env bash
# On the Minh host: fast-forward main and restart the 24/7 mesh.
# No Bybit keys. Does not start from GitHub Actions.
set -euo pipefail

ROOT="${MINH_ROOT:-/opt/minh-agent}"
UNIT="${MINH_UNIT:-bybit-tracker}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

cd "$ROOT"
ORIG_SHA="$(git rev-parse HEAD)"
git fetch origin
git checkout main
git pull --ff-only origin main
NEW_SHA="$(git rev-parse HEAD)"
bun install --frozen-lockfile
# Typecheck before touching systemd: fail fast without restarting.
bun run typecheck
sudo systemctl daemon-reload
sudo systemctl restart bybit-tracker.service
sudo systemctl restart live-shadow.service || true
sudo systemctl try-restart replay-map-lab.timer || true

# Post-restart healthcheck: feed + paper + shadow must answer within the window.
# On failure, roll back to ORIG_SHA and restart (never leave a bad build live).
HEALTH_OK=1
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:43180/health >/dev/null 2>&1; then
    HEALTH_OK=0
    break
  fi
  sleep 2
done
if [[ "$HEALTH_OK" -ne 0 ]]; then
  echo "[minh:deploy] feed unhealthy after $NEW_SHA; rolling back to $ORIG_SHA" >&2
  git reset --hard "$ORIG_SHA"
  bun install --frozen-lockfile
  sudo systemctl daemon-reload
  sudo systemctl restart bybit-tracker.service
  sudo systemctl restart live-shadow.service || true
  exit 1
fi
curl -fsS --max-time 5 http://127.0.0.1:43181/paper/health >/dev/null 2>&1 \
  || echo "[minh:deploy] warn: paper :43181 not ok (check PAPER_OBSERVE/journal)" >&2
curl -fsS --max-time 5 http://127.0.0.1:43182/live/health >/dev/null 2>&1 \
  || echo "[minh:deploy] warn: live-shadow :43182 not ok (fail-soft observer)" >&2
echo "[minh:deploy] live on $NEW_SHA (was $ORIG_SHA)"
sudo systemctl --no-pager --full status bybit-tracker.service live-shadow.service replay-map-lab.timer
