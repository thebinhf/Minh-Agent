# Roadmap — Minh (明)

Paper week. This is the research loop, not a live desk.

## Locks (do not regress)

- Paper only. No Bybit keys, no `/v5/order`, no paper→live, no keys in `src/paper`.
- Missing tape ≠ 0. Do not invent historical `publicTrade` / liq. `summarizeFlow(0,0)` is an empty window.
- Event-once. No Auto S/D. No ICT-as-signal. No auto-arm of `GET /zones`.
- No Terminal/UI as a command source. LLM does not pick zones.
- Features live under `src/`, not `apps/*`.
- Venue rules stay venue rules (lot/tick/notional). One book unless `--one-book` is explicit.

Live-shadow (P4) is a **separate process**. It does not share the paper ledger and does not start in `bun run start`.

## Shipped this cycle (P0–P4)

| Slice | What | Default |
| --- | --- | --- |
| **P0 lab** | `bun run paper review FILE.json` compact QC (`skipReasons`, `quantCoverage`, flags). [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) + optional systemd timer | Operator enable |
| **P1 honesty** | `quantCoverage` on every as-of read. `BYBIT_TAPE_SYMBOLS` opt-in (`watchlist` / `*` / comma / `0`) | Tape stays BTC ETH SOL. Host unit sets `watchlist` |
| **P2 flags** | `AGENT_BIAS_CHOP` (`deny` / `0` / `proximal`). `PAPER_FAMILY_FLOOR_MIN_TRADES` (RR floor sample). 1H chop does not override 4H | Chop kill = 4H mixed only. Floor min trades = 2 |
| **P3 A/B** | `bun run paper ab BASE.json VARIANT.json`. [`deploy/replay-map-ab.sh`](../deploy/replay-map-ab.sh). 180d: chop0/proximal/floor1 losers; `PAPER_ARM_MAX=2` winner; skip-HYPE not additive under ARM=2 | ARM max = 2. Skip default none |
| **P4 live-shadow** | `bun run live` (`src/live/`). Own sqlite, bind `:43182`. Mirrors MAP/ARM without orders. Family always cold. [`deploy/live-shadow.service`](../deploy/live-shadow.service) | Operator enable. `LIVE_SHADOW=0` off |

180d one-book QA after #64 is the baseline: `flow_bars=0` / `liquidations=0` flagged, not zeroed. ARM cap ranks. `skipReasons` counts floor vs skip vs chop. After #65, `PAPER_MAP_SKIP` default is none (HYPE has a venue spec). Combined ARM=2 + skip-HYPE lost −216 vs ARM=2 HYPE-on.

## Next

### P4 — live shadow (this PR)

`bun run live` (`src/live/`). Subscribe public tape only (feed HTTP `:43180`). Mirror MAP/ARM decisions **without** sending orders. Compare shadow vs paper vs later fills.

| Bind / file | Role |
| --- | --- |
| `:43182` | `GET /live/health`, `GET /live/shadow`, `POST /live/map-close` |
| `LIVE_DB_PATH` | Own sqlite (must not equal paper or feed) |
| Poll `/map-latest` | 4H fingerprint; 1H dumps do not re-plan |
| Webhook | Optional `MAP_CLOSE_WEBHOOK=http://127.0.0.1:43182/live/map-close` |

Policy-only: `planMapClose` / `planArm`. Never `acceptZone` / `paperArm` / `/v5/order`. Family is always cold (`null` — not a veto). ARM cap still ranks by `rr` then `zoneId`. Paper still refuses keys. Does not start a second Bybit WS.

Host: [`deploy/live-shadow.service`](../deploy/live-shadow.service). Feed unit sets `BYBIT_TAPE_SYMBOLS=watchlist` so CVD/liq accrue on the full list going forward (does not backfill history).

### P5 — multi-venue

Second public cache (not Bybit) behind the same zone-card + paper desk. Venue adapter owns lot/tick/funding. Policy stays venue-agnostic.

Not this PR.

## Host ops (when the box is up)

```text
# collect CVD/liq on the watchlist going forward (does not backfill history)
# bybit-tracker.service already sets BYBIT_TAPE_SYMBOLS=watchlist

# live-shadow observer (own sqlite, no orders)
sudo systemctl enable --now live-shadow

# nightly lab (does not touch the live paper ledger)
deploy/replay-map-lab.sh
sudo systemctl enable --now replay-map-lab.timer
```

`klinesDays` is already 180. OI/funding REST backfill is public. Flow/liq only exist after WS collection starts. Walks are operator (`deploy/replay-map-ab.sh`), not CI. Do not invent CVD.

## Explicit non-goals

ICT-as-signal, auto-arm `GET /zones`, keys in `src/paper`, UI as command source, LLM zone picking, inventing CVD=0, merging without a review.
