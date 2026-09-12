# CI / CD — Minh Agent

Paper week. **No live orders. No Bybit keys in GitHub.**

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main`, every pull request, and `workflow_dispatch`.

1. Bun from [`.bun-version`](../.bun-version) (binary cache is setup-bun default)
2. Restore `~/.bun/install/cache` keyed on `bun.lock`
3. `bun install --frozen-lockfile --ignore-scripts`
4. `bash scripts/ci.sh` → typecheck ∥ test (one install)

Check name stays **test** (branch protection). Checkout does not persist credentials (`fetch-depth: 1`). No daemon, no `data/`, no private Bybit routes.

Local: `bun run ci` (typecheck then test). CI runs them in parallel after install.

## CD

There is no cloud deploy. The host is the box running [`deploy/bybit-tracker.service`](../deploy/bybit-tracker.service).

After a green merge:

```bash
# on the Minh host
deploy/pull-restart.sh
```

`MINH_ROOT` defaults to `/opt/minh-agent`. Fast-forward only (`git pull --ff-only`). Restart is systemd, not GitHub SSH.

Optional paper lab (not CI): [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) + [`deploy/replay-map-lab.timer`](../deploy/replay-map-lab.timer). Walks 180d one-book then `paper review`. Does not touch the live ledger. Do not run it in Actions.

Do **not** put `BYBIT_API_KEY` / `BYBIT_API_SECRET` in Actions secrets. Paper and live-shadow refuse to start if those env names are set.

Live-shadow is a host unit ([`deploy/live-shadow.service`](../deploy/live-shadow.service)), not CI. Do not start it in Actions.
