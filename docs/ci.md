# CI / CD — Minh Agent

Paper week. **No live orders. No Bybit keys in GitHub.**

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main`, every pull request, and `workflow_dispatch`.

1. Bun from [`.bun-version`](../.bun-version) (binary cache is setup-bun default)
2. Restore `~/.bun/install/cache` keyed on `bun.lock`
3. `bun install --frozen-lockfile --ignore-scripts`
4. `bun run ci` → typecheck + test

Check name stays **test** (branch protection). Checkout does not persist credentials. No daemon, no `data/`, no private Bybit routes.

Local: `bun run ci`.

## CD

There is no cloud deploy. The host is the box running [`deploy/bybit-tracker.service`](../deploy/bybit-tracker.service).

After a green merge:

```bash
# on the Minh host
deploy/pull-restart.sh
```

`MINH_ROOT` defaults to `/opt/minh-agent`. Fast-forward only (`git pull --ff-only`). Restart is systemd, not GitHub SSH.

Do **not** put `BYBIT_API_KEY` / `BYBIT_API_SECRET` in Actions secrets. Paper refuses to start if those env names are set.
