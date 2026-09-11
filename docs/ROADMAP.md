# Roadmap — Minh (明)

Paper week. This is the research loop, not a live desk.

## Locks (do not regress)

- Paper only. No Bybit keys, no `/v5/order`, no paper→live, no keys in `src/paper`.
- Missing tape ≠ 0. Do not invent historical `publicTrade` / liq. `summarizeFlow(0,0)` is an empty window.
- Event-once. No Auto S/D. No ICT-as-signal. No auto-arm of `GET /zones`.
- No Terminal/UI as a command source. LLM does not pick zones.
- Features live under `src/`, not `apps/*`.
- Venue rules stay venue rules (lot/tick/notional). One book unless `--one-book` is explicit.

Live-shadow (P4) is a **separate process**. It does not share the paper ledger and does not start in this cycle.

## Shipped this cycle (P0–P2 flags)

| Slice | What | Default |
| --- | --- | --- |
| **P0 lab** | `bun run paper review FILE.json` compact QC (`skipReasons`, `quantCoverage`, flags). [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) + optional systemd timer | Operator enable |
| **P1 honesty** | `quantCoverage` on every as-of read. `BYBIT_TAPE_SYMBOLS` opt-in (`watchlist` / `*` / comma / `0`) | Tape stays BTC ETH SOL |
| **P2 flags** | `AGENT_BIAS_CHOP` (`deny` / `0` / `proximal`). `PAPER_FAMILY_FLOOR_MIN_TRADES` (RR floor sample). 1H chop does not override 4H | Chop kill = 4H mixed only. Floor min trades = 2 |

180d one-book QA after #64 is the baseline: `flow_bars=0` / `liquidations=0` flagged, not zeroed. ARM cap ranks. `skipReasons` counts floor vs skip vs chop. After #65, `PAPER_MAP_SKIP` default is none (HYPE has a venue spec).

## Next

### P3 — A/B walks (same tape, one flag at a time)

Compare against the #64 one-book rolling baseline. One change per walk. `paper review` is the QC table.

1. Chop A/B (same 180d tape): `AGENT_BIAS_CHOP=0` lost ~3130 equity — keep 4H mixed as deny. 1H chop no longer collapses 4H (playbook stand-aside; equity −32, noise). `proximal` (4H mixed only in-band) lost ~2964 vs that default — keep deny. Flag stays for reruns.
2. `PAPER_FAMILY_FLOOR_MIN_TRADES=1` — 180d vs keep-1H: accepted 175 vs 264, W/L 14/26 vs 23/37, equity **9992 vs 11427 (−1435)**. 1-loss floor also kills families that later win (LINK supply 4t/75% → 1 loss). Keep default 2.
3. `PAPER_ARM_MAX` 180d vs keep-1H ARM=3: **2 = 12460 (+1033)**, 3 = 11427, 5 = 11057 (−369), 0 unlimited = 10536 (−891). Tighter cap, fewer losing fills, `family_floor` 2272 vs 3756. Default **2**.
4. `PAPER_MAP_SKIP=HYPEUSDT` — skip HYPE again vs default none (watch for `hype_accepted`).

Do **not** combine flags until each A/B has a review JSON. Do not invent CVD for the historical window — live tape must accrue first.

### P4 — live shadow (separate process)

`src/live/` (new). Subscribe public tape only. Mirror MAP/ARM decisions **without** sending orders. Compare shadow vs paper vs later fills. Own SQLite. Own bind. Paper still refuses keys.

Not this PR. Not a paper CLI flag.

### P5 — multi-venue

Second public cache (not Bybit) behind the same zone-card + paper desk. Venue adapter owns lot/tick/funding. Policy stays venue-agnostic.

Not this PR.

## Host ops (when the box is up)

```text
# collect CVD/liq on the watchlist going forward (does not backfill history)
BYBIT_TAPE_SYMBOLS=watchlist

# nightly lab (does not touch the live paper ledger)
deploy/replay-map-lab.sh
sudo systemctl enable --now replay-map-lab.timer
```

`klinesDays` is already 180. OI/funding REST backfill is public. Flow/liq only exist after WS collection starts.

## Explicit non-goals

ICT-as-signal, auto-arm `GET /zones`, keys in `src/paper`, UI as command source, LLM zone picking, inventing CVD=0, merging without a review.
