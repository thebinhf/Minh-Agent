# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week. You observe. HTTP: [http.md](http.md).

## Three states

| State | When | Engine | You |
| --- | --- | --- | --- |
| **MAP** | 1H/4H close | Dump `/map`. **4H** MAP_ACCEPT pick → agent policy → ledger | `GET /observe`. Do not `paper zone accept` on the host (`PAPER_OBSERVE=1`) |
| **ARM** | Last in proximal → entry on an **accepted** card + confirmed 15m same direction | Tick rests post-only OCO | Quiet. Notify `zone.armed` |
| **EVENT** | Pending limit / open position | Tick: OCO / SL/TP | `GET /paper/event` or notify fill/invalid/close |

## Watch

```bash
bun run term                 # redraws every 5s
bun run term --interval 15
bun run term --once          # one snapshot; exit 1 if the feed is down (scriptable)
```

One text screen answers the whole loop: is the feed connected and are klines
advancing, do the gates allow trading and why not, when did MAP last dump, how
much of the quant tape is actually there (`ok` vs `missing` per field), equity
and Δ% against starting cash, how many cards are accepted / resting / open /
armed, **every card the detector sees right now and what stopped it** (see
below), each open with unrealised PnL as a multiple of **original** risk (so
`-0.5R` means half your risk, comparable across symbols), each resting OCO,
whether the mutation lock is on, what shadow would have armed, and the last
events.

`MAPCARDS` joins three already-published reads: feed `GET /zones?interval=240`
(the detector's current MAP), the desk's standing cards, and
`$LIVE_SHADOW_URL`'s `map_plan` events (the policy's per-card answer). Each row
prints `paper=open|armed|accepted` for the stage the **desk** reached, and
`shadow=allow|arm|deny <reason>` for what the **shadow** policy said. They are
different ledgers with different inputs — the shadow runs a cold family floor and
no paper history — so `paper=accepted shadow=deny family_floor` is a real,
readable state, not a contradiction. `shadow=—` means the shadow never answered;
`no-verdict=N` means it answered and has no judgement for those cards (it plans
on 4H closes only). The first 12 rows print; the rest are counted and point at
the endpoint. A card the desk still holds but the detector dropped reads
`undetected`.

It is a **viewer, never a command source** (locked in [ROADMAP.md](ROADMAP.md)):
no engine, no store, `GET` only — you still accept, reject and arm through the
CLI below. A daemon that is not answering renders `down` and a missing tape
field renders `—` / `N miss`, so an outage can never read as "nothing to do".
Commands stay raw JSON on purpose (`paper status` / `event` / `day` / `week`),
which is what `--once` and a pipe consume.

**If the shadow column looks empty:** every `map_plan` event carries the
wall-clock `ts` of the cycle that wrote it and the panel prints it as
`plan=... (Nm ago)`, so read that first — a plan older than the newest 4H close
means the shadow did not evaluate that bar. It does not need a restart to recover:
a bar is consumed only by a cycle that actually evaluated its cards, so a
gate-denied one (feed down, a boot race with it) runs again on the next map poll
(`LIVE_MAP_POLL_MS`, default 30s).
When there is no plan age at all, the cause is upstream: `shadow off` /
`shadow down` means no shadow is wired or reachable, and `MAP_ACCEPT=0` plans
nothing.

## MAP

Read `ticker` + `klines.240` + `klines.60` + **`klineLag`** from **`GET /map`** (daily `klines.D` if backfilled). No query → feed watchlist (10, cap 10) as `{ maps, klineLag }`. Do **not** dump `/brief` 15m into chat. `/brief` is unchanged and is **not** the MAP candle source.

`GET /brief-pack` is optional (desk: pending / alerts / positions + `gates` + accepted ledger). Positions have no `unrealizedPnl`. If `gates.tradingAllowed` is false, STAND ASIDE — new arm/open/limit reject. Existing paper positions stay open.

Check `klineLag.ok` before drawing (1H/4H on `/map`; 15m lag is scalp-only). Stale/formingStuck while ticker is live → STAND ASIDE, do not invent candles.

**`GET /zones`** (`bun run zones`) is suggest-only: it does **not** arm. Families: S/D, breakout retest, reversal (`PAPER_SETUPS`; `0` = S/D only). 4H close: MAP_ACCEPT pick (not deep/invalid) **then** agent policy **before** `acceptZone`.

Bias (from `/map` klines, not a `/map` field): 4H HH/HL = bull, LH/LL = bear, mixed = chop. 1H must not oppose 4H. 1H chop does **not** override 4H — mid-range still STAND ASIDE. Accept: bull → demand only; bear → supply only. Drop RR < account `minRr`, `deep_mitigate`, `htf_break`, expiry. Cap 2 accepted/symbol. **Two floors, in order:** detection draws the card's TP at `ZONE_MIN_RR` (default 2R, unset = 2, garbage rejected at boot), so a detected card sits exactly on it unless a measured target is further; the account `minRr` then only ever rejects *tighter*. That means `minRr` below the drawn floor is dead config — `paper`/`live` boot prints `account.min_rr=X can never bind` rather than pretending. Family paper score ranks before the cap; after a sample (`PAPER_FAMILY_FLOOR_MIN_TRADES` default 2), families below score `0.5` or with `avgRealizedRr ≤ 0` are skipped (`family_floor`). Missing/cold history is not a veto (`PAPER_ZONE_SCORE=0` off). 4H mixed chop is a MAP deny (`bias_chop`; `AGENT_BIAS_CHOP=0` off, `proximal` = allow only in proximal→entry). Optional `PAPER_MAP_SKIP` (comma symbols; unset / `0` / blank = none). Feed watchlist is 10 including HYPEUSDT; HYPE has a linear spec in the paper catalog. Mid-range: last between nearest swing H/L **and** not in proximal→entry of a same-direction card → STAND ASIDE (does **not** close open positions). Stale `klineLag` / `tradingAllowed=false` → no accept / no new arm.

`MAP_ACCEPT=0` turns off the **old accept path** (no auto-copy). `AGENT_MAP=0` is a **policy no-op** — ungated P5 `runMapAccept` still copies if `MAP_ACCEPT` is on. Manual: `bun run paper zone accept <zoneId>` or `POST /paper/zones` (bypasses agent policy). `/zones` itself does **not** arm.

Quant is a **single in-process veto** (`quantVeto`). Cascade and crowded at MAP **accept**, proximity **ARM**, and **pending fill**. Opposing OI add (`short_add` vs demand / `long_add` vs supply) and opposing CVD (`sell_dom` vs demand / `buy_dom` vs supply on `/map.flow`) are **MAP accept only** — at ARM / while the OCO rests that add/flow is the zone fill. Same-side add is never a veto. `cover`/`flush` confirm cascade; they are not a second veto. Cascade `active` with `side: null` is not a veto. Demand + `liq.cascade.active && side=long` → wait reclaim (do not reject the zone; skip the fill this tick, keep the pending). Crowded long blocks demand, not a short signal. `AGENT_QUANT=0` skips. Missing tape / missing `flow.reading` is not a veto. `GET /liq-model` is a labeled estimate — do not arm from it. `/heatmap` is the book grid, not CVD. `GET /ta` is an overlay pack (fib, S/R, oscillators, FVG/BOS/CHOCH labels, moon calendar). **Do not arm from it.** Setup methods emit cards on `/zones` (S/D, breakout, reversal) — still not from `/ta`. ICT stays confirm after the zone + HTF already passed. Opt-in gates (default **off**, one flag / one A/B): `AGENT_TA_OSC=accept` MAP deny (`ta_osc`) when RSI/div opposes the zone; `PAPER_TA_FIB=arm` / `PAPER_TA_VOL=arm` / `PAPER_TA_SHOCK=arm` / `PAPER_TA_REV=arm` wait at ARM (`ta_fib` / `ta_vol` / `ta_shock` / `ta_rev` counted once per card in replay-map `skipReasons`). Fib/rev apply to S/D cards only; shock to S/D+breakout; vol to every setup; reversal cards skip the rev wait. Missing overlay tape is not a veto. `--one-book` applies osc the same as single-symbol.

5M scalp only after HTF bias is set — `GET /confirm?symbol=&interval=5`. Not in `/brief` / `/brief-pack` / `/map`.

Depth/heatmap only when price is **at the zone**, not on a timer.

## ARM

Accepted ledger cards rest themselves when last enters **proximal → entry** (demand last dropping in; supply last lifting in) **and** the last confirmed 15m closes with the zone (demand bull, supply bear) still inside that band. Forming / opposite / doji → wait (do not reject). Through entry → wait (no chase). ≥50% into the zone → `deep_mitigate`. Through SL → `htf_break`. Already pending/open on that symbol → skip. At most **2** symbols with pending/open (`PAPER_ARM_MAX=0` unlimited). Under the cap, ready-to-arm cards rank by family score (cold/`null` last), then card `rr`, then `zoneId`. `PAPER_ZONE_SCORE_RR=1` (default **off**) inserts sampled `avgRealizedRr` ahead of score. Occupied slots stay — a better family does not steal a pending/open book. If IM at `defaultLeverage` (seed **10**) does not fit remaining cash, paper raises leverage to the minimum that fits, capped at `min(account.leverageMax, spec.maxLeverage)` (seed max **150**; BTC 150, ENA 50, HYPE 75). Still-short → `insufficient_margin` skip this tick. `rr_below_min` after tick snap rejects the card with `rr_fail` (does not retry every print). `PAPER_PROXIMITY_ARM=0` disables ARM. `PAPER_CONFIRM_15=0` skips the 15m gate. `PAPER_TA_FIB=arm` waits unless last is nearest fib 0.5/0.618. `PAPER_TA_VOL=arm` waits on kline climax. `PAPER_TA_SHOCK=arm` waits on 4H impulse/vol_spike. `PAPER_TA_REV=arm` waits unless 15m reversal agrees. Missing overlay = not a wait.

Manual still works:

```text
bun run paper arm BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --zone-id btc-4h-d-20260908-01
```

Long → alert `--below` at `--price`. Short → `--above`. Override with `--alert-price`. Then **quiet**.

Supply / short: `--above` + `--side short`. Invalidation = structure break (`--sl`; OCO cancels pending if last prints through before fill). `--no-oco` only if you mean it.

Account seed: risk 2%, `minRr` **2** (config, not an engine constant). Engine still has no magic `2`.

## EVENT

EVENT is **OCO + tick**. Do not poll `/confirm` / `/brief` / 30-minute scan. Pending limit invalidates itself; fill/SL/TP fire as events. `PAPER_BE_R` (move SL to entry after last runs ≥ N× original risk, `position.managed` / `be`) is **off and measured off**: on a 180d one-book frozen-floor walk, 0.5R turned 68 trades into 0-R scratches but took TP exits from 36 to 19 — net −4 770.6 equity. The scratches are real; the forfeited right tail is bigger. Do not enable it, and do not re-argue it from the −1R side of the ledger alone. See [ROADMAP.md](ROADMAP.md).

Bound pending (`zoneId` on an accepted ledger card) dies with the zone: expiry, `deep_mitigate` (≥50% into the zone after rest), `htf_break` (through SL), or operator `paper zone reject` cancel the resting limit **and** the matching armed alert (`order.invalidated` carries that `cancelCode`). Cascade/crowded still **wait** — skip fill this tick, keep the pending, do not reject the card. Unzoned `paper limit` / `--no-oco` unchanged. Do not auto-close opens.

```text
bun run paper event
GET /paper/event
```

`/confirm?interval=15` is **optional scalp** after HTF is already armed — not required to hold the zone.

Optional ping: `PAPER_NOTIFY=telegram` or `webhook`. Same four kinds. Log-only if unset.

```text
bun run paper status
bun run paper day
bun run paper week
bun run paper metrics --days 7
bun run paper events --limit 20
bun run paper cancel ID
```

## REPLAY

Same ARM, on **backfilled** klines. Does not touch the live paper ledger. Slippage 0 (no L50 tape).

```text
bun run backfill --symbol BTCUSDT --days 30
bun run paper replay BTCUSDT --from 2026-08-01 --to 2026-09-01 \
  --side long --price 117500 --sl 116200 --tp 120800 --tf 240,60,15
bun run paper replay-batch ./zones.json
bun run paper replay-map --days 180 --one-book
bun run paper review ./lab/replay-map.json
bun run paper ab ./lab/base.review.json ./lab/chop0.review.json
MINH_DECISION_FILE=./data/decisions.jsonl bun run paper replay-map --days 180 --one-book --train-days 90
bun run agent corpus --file ./data/decisions.jsonl --days 180
```

Optional `--interval 15` (walk), `--funding-rate` if you want 8h settlements (kline cache has no funding tape). Auto S/D stays in MAP — replay only receives the zone.

Batch file: operator-picked zones (`symbol/side/price/sl/tp/tf` + `from`/`to`). Output is a table (fill / OCO / SL / TP). One bad row does not stop the rest.

`replay-map` is the method walk (detect → policy → ARM). `paper review FILE.json` is compact QC: skipReasons, `quantCoverage` (ok vs missing per field), flags (`hype_accepted`, `flow_missing`, `cascade_missing`, `tape_skipped`). Missing CVD/liq is a flag, not a zero. Does not walk bars. `paper ab BASE.json VARIANT.json` is variant minus base — one flag at a time. Nightly: [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh). A/B: [`deploy/replay-map-ab.sh`](../deploy/replay-map-ab.sh).

## CORPUS

Every MAP verdict with the as-of features that produced it, in SQLite. A live host answers *why not this card*; the corpus answers *how often does each rule fire, and on what kind of card* — which needs a walk, because this desk emits a few hundred labels a month. `bun run agent corpus` ingests the JSONL (one row per card per 4H close, re-ingest is a no-op) and prints rows, cards, span and accept-rate split by reason, setup, side, freshness, HTF bias and symbol, plus tape coverage as *known vs missing*.

Reads and counts only. It does not arm, accept or place — a viewer, like `bun run term`.

Two traps it will tell you about:

- `--days N` counts back from the **newest decision**, not from today. Walk rows carry past close times, so a wall-clock window prints `rows=0` on a corpus that is full.
- The key is `asof + zone_id`, so one row per card per close. A walk that re-evaluates a standing card in the same close keeps the **first** verdict, and the ingest line counts those as `WARNING N`. Two flag arms in one db take the same path silently — give each arm its own `--db`.

## LIVE-SHADOW

Observer only. Separate process (`bun run live`), own sqlite, bind `:43182`. Reads feed HTTP. **Does not** accept paper zones, rest OCO, or send orders. Family is always cold (`null` — not a veto). Compare `GET /live/shadow` against `GET /paper/event`. Not a command source.

```text
GET /live/health
GET /live/shadow
POST /live/map-close   # optional MAP_CLOSE_WEBHOOK from the feed
```

## Ban

- Scan on a timer while waiting
- Enter mid-range
- Fade HTF structure
- ICT/SMC unless the zone + HTF already passed (`GET /ta` labels, never a detector)
- Arm from `GET /ta` / fib / oscillator / moon / harmonic
- Live keys, `/v5/order`, paper→live
- Mid-watch PnL

## 24/7 mesh

Daemon (`systemd`, `Restart=always`) already runs feed + paper tick + EVENT notify + kline-lag watchdog.

On confirmed **1H / 4H** bars the closer dumps `GET /map` to `map-latest.json`. On **4H**: MAP_ACCEPT pick → agent policy → `acceptZone`. Family score from 7-day paper metrics ranks before the per-symbol cap when a family has enough fills/trades; missing score is not a veto (`PAPER_ZONE_SCORE=0` off). `MAP_ACCEPT=0` disables the old auto-copy. `AGENT_MAP=0` disables this policy (no-op) — old copy still runs. Stale gates → no accept / no new arm; do not close opens. Tick **proximity-arms** when last is in the proximal band and the last confirmed 15m agrees. `PAPER_PROXIMITY_ARM=0` / `PAPER_CONFIRM_15=0` off. `/zones` itself still does not arm.

Review: `bun run paper week` (7-day funnel detected→accepted→armed→touched→filled + family scores). Override: `paper zone reject`. Method walk (not live desk): `bun run paper replay-map --days 180` — watchlist, same detect/policy/ARM, no future bars, quant as-of (missing stays null), slippage 0. `--one-book` = one equity. `--train-days 90` freezes family floor after 90d. Then `bun run paper review FILE.json`. A/B: `deploy/replay-map-ab.sh chop0` then `paper ab BASE VARIANT`. Backfill first (`bun run backfill --days 180`). Host lab: `deploy/replay-map-lab.sh` (optional `replay-map-lab.timer`). CVD/liq collection is the watchlist unless `BYBIT_TAPE_SYMBOLS=0` — replay still cannot invent history. How much of the walk has real tape is set by `BYBIT_FLOW_HOURS` / `BYBIT_LIQ_HOURS` (180d on the tracker unit); at the 24h/48h defaults `quantCoverage.flow` is ~0.3%. Prune only moves forward, so the window starts accruing the day the knob is set.

`GET /map-latest` reads the last dump (404 before the first close).

`127.0.0.1:43180` public cache. Default watchlist is 10 linear symbols (BTC, ETH, SOL, ENA, BNB, XRP, DOGE, AVAX, LINK, HYPE). Stale ticker → paper rejects. Stale **klines** with a live ticker → `klineLag.ok=false` on `/health` and `/brief-pack`, and `gates.tradingAllowed=false`. Paper **open/limit/arm** reject with `kline_lag`. Do not invent a price or a candle. Do not auto-close existing paper positions.
