# CI / CD — Minh Agent

Paper week. **No live orders. No Bybit keys in GitHub.**

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request:

1. `bun install --frozen-lockfile`
2. `bun run typecheck`
3. `bun test`

Does **not** start the WS daemon, does **not** open SQLite under `data/`, does **not** call private Bybit routes. Required check name: **test**.

Turn on branch protection for `main`: require the `test` status, no admin bypass if you can.

## CD

There is no cloud deploy. The host is the box running [`deploy/bybit-tracker.service`](../deploy/bybit-tracker.service).

After a green merge:

```bash
# on the Minh host
deploy/pull-restart.sh
```

`MINH_ROOT` defaults to `/opt/minh-agent`. Fast-forward only (`git pull --ff-only`). Restart is systemd, not GitHub SSH.

Do **not** put `BYBIT_API_KEY` / `BYBIT_API_SECRET` in Actions secrets. Paper refuses to start if those env names are set.
