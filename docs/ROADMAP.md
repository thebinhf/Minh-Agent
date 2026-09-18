# Roadmap — Minh (明)

Paper week. **MVP frozen** on this loop. You observe.

## Locks (do not regress)

- Keys and order placement exist only in `src/exec/` ([live-execution.md](live-execution.md)). `src/feed`, `src/agent`, `src/paper`, `src/zones`, `src/ta`, `src/features`, `src/live` never mention `/v5/order`, signing, or key env names. Paper stays the default.
- Missing tape ≠ 0. Do not invent historical `publicTrade` / liq. `summarizeFlow(0,0)` is an empty window.
- Event-once. No Auto S/D. No ICT-as-signal. No auto-arm of `GET /zones`.
- No Terminal/UI as a command source. LLM does not pick zones.
- Features live under `src/`, not `apps/*`.
- Venue rules stay venue rules (lot/tick/notional). One book unless `--one-book` is explicit.

Live-shadow (P4) is a **separate process**. It does not share the paper ledger and does not start in `bun run start`.

## MVP (in)

| Slice | What | Default |
| --- | --- | --- |
| Feed | Public Bybit linear WS + REST failover. Tape = full watchlist | On |
| MAP / zones | 4H close → S/D + breakout + reversal cards → policy accept | `PAPER_SETUPS` all three |
| ARM / EVENT | Proximal + 15m confirm → post-only OCO. Tick fill / SL/TP | On. `PAPER_ARM_MAX=2` |
| Observer | Host `PAPER_OBSERVE=1`. `GET /observe` (feed + gates + MAP + tape + shadow + paper) | systemd |
| Mesh | `minh.target` → tracker + live-shadow + nightly lab | `enable-mesh.sh` |
| Quant | Cascade / crowded / OI / CVD veto. Missing ≠ veto | On |
| Overlay | `GET /ta` 22 methods. `signal: false`. Does not arm | Overlay only |

P7 TA gates (`PAPER_TA_FIB` / `AGENT_TA_OSC` / vol / shock / rev) stay **off** until a host 180d one-flag A/B. Not MVP. Signal-quality filters `AGENT_ZONE_FRESH` (deny touched/penetrated zones) and `AGENT_ZONE_IMPULSE_MIN` (deny shallow impulses) join the same queue: off by default, one flag per walk, counted in `skipReasons` (`zone_fresh` / `zone_impulse`). P9 EVENT manage (`PAPER_BE_R`) and realized-RR rank (`PAPER_ZONE_SCORE_RR`) are the same discipline: off, one flag per walk. BE is not a skipReason — it is a stop move on an open (`position.managed`).

## Shipped this cycle (P0–P4, P6 overlay, P7 flags, P8 setups, P9 flags, T3 terminal)

| Slice | What | Default |
| --- | --- | --- |
| **P0 lab** | `bun run paper review FILE.json` compact QC (`skipReasons`, `quantCoverage`, flags). [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) + optional systemd timer | Operator enable |
| **P1 honesty** | `quantCoverage` on every as-of read. `BYBIT_TAPE_SYMBOLS` opt-in (`watchlist` / `*` / comma / `0`) | Tape default = full watchlist. `0` = none |
| **P2 flags** | `AGENT_BIAS_CHOP` (`deny` / `0` / `proximal`). `PAPER_FAMILY_FLOOR_MIN_TRADES` (RR floor sample). 1H chop does not override 4H | Chop kill = 4H mixed only. Floor min trades = 2 |
| **P3 A/B** | `bun run paper ab BASE.json VARIANT.json`. [`deploy/replay-map-ab.sh`](../deploy/replay-map-ab.sh). 180d: chop0/proximal/floor1 losers; `PAPER_ARM_MAX=2` winner; skip-HYPE not additive under ARM=2 | ARM max = 2. Skip default none |
| **P4 live-shadow** | `bun run live` (`src/live/`). Own sqlite, bind `:43182`. Mirrors MAP/ARM without orders. Family always cold. [`deploy/live-shadow.service`](../deploy/live-shadow.service) | Operator enable. `LIVE_SHADOW=0` off |
| **P6 overlay** | `GET /ta` 22 methods. Not a signal. Does not arm. ICT confirm only | Off the MAP path |
| **P7 TA gates** | Opt-in flags: `PAPER_TA_FIB=arm`, `AGENT_TA_OSC=accept`, `PAPER_TA_VOL=arm`, `PAPER_TA_SHOCK=arm`, `PAPER_TA_REV=arm`. Setup-aware (`src/agent/strategy.ts`): fib/rev = S/D only; shock = S/D+breakout; vol = all; reversal cards skip rev. `--one-book` applies osc. ARM waits count once per card in `skipReasons` (`ta_fib`/`ta_vol`/`ta_shock`/`ta_rev`). Missing tape is not a veto. One flag / one 180d A/B | All **off** — **not MVP** |
| **P8 setups** | Breakout retest + reversal candle emit zone-cards (same MAP/ARM/EVENT). `PAPER_SETUPS` default `sd,breakout,reversal`. `0` = S/D only. GET `/ta` still `signal: false`. ICT/discretionary do not emit | On. A/B: `sd` vs default |
| **Observer** | `PAPER_OBSERVE=1` GET-only mutations. `GET /observe` machine snapshot | Host unit |

180d one-book QA after #64 is the baseline: `flow_bars=0` / `liquidations=0` flagged, not zeroed. ARM cap ranks. `skipReasons` counts floor vs skip vs chop. After #65, `PAPER_MAP_SKIP` default is none (HYPE has a venue spec). Combined ARM=2 + skip-HYPE lost −216 vs ARM=2 HYPE-on.

## After MVP (research, not product)

### P7 — 180d A/B on the host

One flag / one walk: `fib` first (`PAPER_TA_FIB=arm`). Then osc / vol / shock / rev. Do not combine with P8 A/B on the first walk. Replay does not invent CVD. Do not turn a flag on in systemd until that walk wins.

### P8 A/B

`deploy/replay-map-ab.sh sd` vs `baseline` (all three families). Same honesty: missing flow/liq stays missing.

### P9 — EVENT manage + realized-RR rank

One flag / one walk: `be` first (`PAPER_BE_R=0.5` — after MFE ≥ 0.5R, SL → entry). The 11/28 SLs-ran-then-died figure came from a walk whose JSON records `days: 180`, `oneBook: true` and **no** `trainDays` — its accept set was picked with an in-sample family floor, so treat the figure as a hint, not a verdict. `paper review` now carries `trainDays` and `paper ab` prints `NOT COMPARABLE` when base and variant differ on `days` / `one-book` / `train-days` / slippage. `deploy/replay-map-ab.sh` defaults to a frozen 90d floor; decide on that walk. Then `scorerr` (`PAPER_ZONE_SCORE_RR=1`). Do not combine with P7/P8 on the first walk. Do not turn a flag on in systemd until that walk wins.

### T3 — Trading Terminal (viewer)

`bun run term` — one looping text screen over feed `GET /observe`, for the split host falling back to `:43181/paper/observe`. It holds no engine, no store and no key, and issues `GET` only: **a viewer, never a command source** (lock above). Accept / reject / arm stay CLI or HTTP POST. A daemon that is not answering renders `down` and a missing tape field renders `—` / `N miss`, so an outage cannot read as "nothing to do".

### P5 — multi-venue

Second public cache (not Bybit) behind the same zone-card + paper desk. After a P7 winner.

## Host ops (MVP)

```text
deploy/enable-mesh.sh
# minh.target → tracker (PAPER_OBSERVE=1) + live-shadow + lab.timer
# GET http://127.0.0.1:43180/observe

# after a green merge
deploy/pull-restart.sh
```

`klinesDays` is already 180. OI/funding REST backfill is public (failover if api.bybit.com 403). Flow/liq only exist after WS collection starts — there is no REST backfill for either, so the tracker unit sets `BYBIT_FLOW_HOURS=4320` / `BYBIT_LIQ_HOURS=4320` (180d, matching `klinesDays`) and coverage accrues forward from the day that lands. Widening retention is not inventing history: everything before collection started stays missing. Walks are operator (`deploy/replay-map-ab.sh`), not CI. Do not invent CVD.

REST geo-block is a venue constraint, not a product bug.

## Explicit non-goals

ICT-as-signal, auto-arm `GET /zones`, keys in `src/paper`, UI as command source, LLM zone picking, inventing CVD=0, merging without a review, arming from `GET /ta`, Volume Profile / footprint as a fourth setup, order placement outside `src/exec/`.
