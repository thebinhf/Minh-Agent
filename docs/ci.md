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

`MINH_ROOT` defaults to `/opt/minh-agent`. Fast-forward only (`git pull --ff-only`). Typechecks **before** touching systemd, then restarts tracker + live-shadow + lab timer and probes `GET :43180/health` for up to 60s. If the feed never answers, it resets to the SHA it started from and restarts again — a bad build does not stay live. Paper `:43181` and shadow `:43182` are warn-only (both are fail-soft observers). A healthy process running the wrong strategy is still the operator's call.

DB backup: [`deploy/backup-db.sh`](../deploy/backup-db.sh) takes an online-safe (`.backup`) snapshot of every mesh SQLite DB — feed, paper, live-shadow, exec — into `MINH_BACKUP_DIR` (`$MINH_ROOT/backups` by default), keeping `MINH_BACKUP_KEEP` (14) stamped copies each and refusing when free space is under 2× the largest DB. `deploy/replay-map-lab.sh` runs it before each walk, so a lab accident cannot cost the ledger.

Host probe: [`scripts/ops-check.sh`](../scripts/ops-check.sh) — feed / paper / shadow health, `klineLag.ok`, DB disk use, lab freshness. Exit 1 and a `PAPER_NOTIFY` page on the first three; shadow and lab are warn-only. No unit ships: run it every 5m from cron (`*/5 * * * * /opt/minh-agent/scripts/ops-check.sh`) or your own timer. It checks; it never restarts.

Optional paper lab (not CI): [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) + [`deploy/replay-map-lab.timer`](../deploy/replay-map-lab.timer). Walks 180d one-book then `paper review`. Does not touch the live ledger. Do not run it in Actions.

Method change to expect: the lab now defaults `PAPER_LAB_TRAIN_DAYS=90` (family floor frozen before the holdout) and unsets every A/B knob inherited from the shell, so a nightly from before this change is **not** comparable with one after — the old number was partly in-sample. `PAPER_LAB_TRAIN_DAYS=0` restores the old walk. Artifacts carry the window in their name (`review-180d-t90-*.json`), and `paper ab` marks a pair non-comparable (`methodMismatch` + a `NOT COMPARABLE` stderr line) when the two walks differ on `days` / `oneBook` / `trainDays` / slippage.

Walk every arm of an A/B on **one pinned window**: export `PAPER_AB_FROM` / `PAPER_AB_TO` once, then run each arm. `--days N` is measured from the clock at each arm's own start, so arms walked 20 minutes apart do not even see the same window. Note that `ticks` is *not* a control variable: the per-bar print sequence comes from `walkSide()`, i.e. the side currently being walked, which follows open state — so arms legitimately differ in ticks and `quantCoverage.samples` once the flag changes anything. Pin the window, then compare bars (`htfBars` / `ltfBars`, which must match) and read `methodMismatch`; a tick delta on identical bars is the flag, not the harness. The `compare` mode of `replay-map-ab.sh` takes the two review JSONs it should subtract.

Do **not** put `BYBIT_API_KEY` / `BYBIT_API_SECRET` in Actions secrets. Paper and live-shadow refuse to start if those env names are set.

Live-shadow is a host unit ([`deploy/live-shadow.service`](../deploy/live-shadow.service)), not CI. Do not start it in Actions.
