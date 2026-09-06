#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Minh-Agent (Bun + deps).
set -euo pipefail

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "[minh:env] Bun not found; installing to $BUN_INSTALL"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[minh:env] ERROR: bun missing after install (PATH=$PATH)" >&2
  exit 1
fi

echo "[minh:env] $(command -v bun) ($(bun --version))"
if [[ -f bun.lock || -f bun.lockb ]]; then
  bun install --frozen-lockfile
else
  bun install
fi
echo "[minh:env] install ok"
