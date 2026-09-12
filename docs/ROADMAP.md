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

## Shipped this cycle (P0–P4, P6 overlay, P7 flags, P8 setups)

| Slice | What | Default |
| --- | --- | --- |
| **P0 lab** | `bun run paper review FILE.json` compact QC (`skipReasons`, `quantCoverage`, flags). [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) + optional systemd timer | Operator enable |
| **P1 honesty** | `quantCoverage` on every as-of read. `BYBIT_TAPE_SYMBOLS` opt-in (`watchlist` / `*` / comma / `0`) | Tape default = full watchlist. `0` = none |
| **P2 flags** | `AGENT_BIAS_CHOP` (`deny` / `0` / `proximal`). `PAPER_FAMILY_FLOOR_MIN_TRADES` (RR floor sample). 1H chop does not override 4H | Chop kill = 4H mixed only. Floor min trades = 2 |
| **P3 A/B** | `bun run paper ab BASE.json VARIANT.json`. [`deploy/replay-map-ab.sh`](../deploy/replay-map-ab.sh). 180d: chop0/proximal/floor1 losers; `PAPER_ARM_MAX=2` winner; skip-HYPE not additive under ARM=2 | ARM max = 2. Skip default none |
| **P4 live-shadow** | `bun run live` (`src/live/`). Own sqlite, bind `:43182`. Mirrors MAP/ARM without orders. Family always cold. [`deploy/live-shadow.service`](../deploy/live-shadow.service) | Operator enable. `LIVE_SHADOW=0` off |
| **P6 overlay** | `GET /ta` 22 methods. Not a signal. Does not arm. ICT confirm only | Off the MAP path |
| **P7 TA gates** | Opt-in flags: `PAPER_TA_FIB=arm`, `AGENT_TA_OSC=accept`, `PAPER_TA_VOL=arm`, `PAPER_TA_SHOCK=arm`, `PAPER_TA_REV=arm`. Setup-aware (`src/agent/strategy.ts`): fib/rev = S/D only; shock = S/D+breakout; vol = all; reversal cards skip rev. `--one-book` applies osc. ARM waits count once per card in `skipReasons` (`ta_fib`/`ta_vol`/`ta_shock`/`ta_rev`). Missing tape is not a veto. One flag / one 180d A/B | All **off** |
| **P8 setups** | Breakout retest + reversal candle emit zone-cards (same MAP/ARM/EVENT). `PAPER_SETUPS` default `sd,breakout,reversal`. `0` = S/D only. GET `/ta` still `signal: false`. ICT/discretionary do not emit | On. A/B: `sd` vs default |

180d one-book QA after #64 is the baseline: `flow_bars=0` / `liquidations=0` flagged, not zeroed. ARM cap ranks. `skipReasons` counts floor vs skip vs chop. After #65, `PAPER_MAP_SKIP` default is none (HYPE has a venue spec). Combined ARM=2 + skip-HYPE lost −216 vs ARM=2 HYPE-on.

## Next

### Observer desk (this PR)

One `GET /observe`: feed health + last MAP dump + paper desk. You do not poll three ports. P7 flags stay off.

### P7 — 180d A/B on the host (after mesh is up)

One flag / one walk: `fib` first (`PAPER_TA_FIB=arm`). Then osc / vol / shock / rev. Do not combine with P8 A/B on the first walk. Replay does not invent CVD.

### P5 — multi-venue

Second public cache (not Bybit) behind the same zone-card + paper desk. Venue adapter owns lot/tick/funding. Policy stays venue-agnostic.

After a P7 winner. Not this PR.

## Host ops (when the box is up)

```text
# 24/7 autonomous mesh — you observe
deploy/enable-mesh.sh
# tracker (PAPER_OBSERVE=1) + live-shadow + replay-map-lab.timer
# GET http://127.0.0.1:43180/observe

# after a green merge
deploy/pull-restart.sh
```

`klinesDays` is already 180. OI/funding REST backfill is public. Flow/liq only exist after WS collection starts. Walks are operator (`deploy/replay-map-ab.sh`), not CI. Do not invent CVD.

## Explicit non-goals

ICT-as-signal, auto-arm `GET /zones`, keys in `src/paper`, UI as command source, LLM zone picking, inventing CVD=0, merging without a review, arming from `GET /ta`.
