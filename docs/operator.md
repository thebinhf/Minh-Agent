# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week. HTTP: [http.md](http.md).

## Three states

| State | When | Engine | Operator |
| --- | --- | --- | --- |
| **MAP** | 1H/4H close | Dump `/map`. **4H** MAP_ACCEPT pick → agent policy → ledger (`MAP_ACCEPT=0` = no copy; `AGENT_MAP=0` = policy no-op, old copy still runs). Family paper score ranks when history exists | Override: `paper zone accept` / `reject`. Mid-range → stand aside (do not close opens). Stale `klineLag` / `gates.tradingAllowed` false → no accept / no new arm |
| **ARM** | Last in proximal → entry on an **accepted** card + confirmed 15m same direction | Tick rests post-only OCO (`PAPER_PROXIMITY_ARM=0` / `PAPER_CONFIRM_15=0` off) | Manual `paper arm` still works. Then **quiet** |
| **EVENT** | Pending limit / open position | Tick: zone-bind pending (expire / deep / HTF), OCO invalidate-before-fill, cascade/crowded hold fill, then SL/TP | `paper event`. Do not poll `/confirm`. Optional scalp `/confirm?interval=15` |

## MAP

Read `ticker` + `klines.240` + `klines.60` + **`klineLag`** from **`GET /map`** (daily `klines.D` if backfilled). No query → feed watchlist (10, cap 10) as `{ maps, klineLag }`. Do **not** dump `/brief` 15m into chat. `/brief` is unchanged and is **not** the MAP candle source.

`GET /brief-pack` is optional (desk: pending / alerts / positions + `gates` + accepted ledger). Positions have no `unrealizedPnl`. If `gates.tradingAllowed` is false, STAND ASIDE — new arm/open/limit reject. Existing paper positions stay open.

Check `klineLag.ok` before drawing (1H/4H on `/map`; 15m lag is scalp-only). Stale/formingStuck while ticker is live → STAND ASIDE, do not invent candles.

**`GET /zones`** (`bun run zones`) is suggest-only: it does **not** arm. 4H close: MAP_ACCEPT pick (not deep/invalid) **then** agent policy **before** `acceptZone`.

Bias (from `/map` klines, not a `/map` field): 4H HH/HL = bull, LH/LL = bear, mixed = chop. 1H must not oppose 4H; 1H chop → stand aside. Accept: bull → demand only; bear → supply only. Drop RR < account `minRr`, `deep_mitigate`, `htf_break`, expiry. Cap 2 accepted/symbol. Mid-range: last between nearest swing H/L **and** not in proximal→entry of a same-direction card → STAND ASIDE (does **not** close open positions). Stale `klineLag` / `tradingAllowed=false` → no accept / no new arm.

`MAP_ACCEPT=0` turns off the **old accept path** (no auto-copy). `AGENT_MAP=0` is a **policy no-op** — ungated P5 `runMapAccept` still copies if `MAP_ACCEPT` is on. Manual: `bun run paper zone accept <zoneId>` or `POST /paper/zones` (bypasses agent policy). `/zones` itself does **not** arm.

Quant is a **single in-process veto** (`quantVeto`). Cascade and crowded at MAP **accept**, proximity **ARM**, and **pending fill**. Opposing OI add (`short_add` vs demand / `long_add` vs supply) and opposing CVD (`sell_dom` vs demand / `buy_dom` vs supply on `/map.flow`) are **MAP accept only** — at ARM / while the OCO rests that add/flow is the zone fill. Same-side add is never a veto. `cover`/`flush` confirm cascade; they are not a second veto. Cascade `active` with `side: null` is not a veto. Demand + `liq.cascade.active && side=long` → wait reclaim (do not reject the zone; skip the fill this tick, keep the pending). Crowded long blocks demand, not a short signal. `AGENT_QUANT=0` skips. Missing tape / missing `flow.reading` is not a veto. `GET /liq-model` is a labeled estimate — do not arm from it. `/heatmap` is the book grid, not CVD.

5M scalp only after HTF bias is set — `GET /confirm?symbol=&interval=5`. Not in `/brief` / `/brief-pack` / `/map`.

Depth/heatmap only when price is **at the zone**, not on a timer.

## ARM

Accepted ledger cards rest themselves when last enters **proximal → entry** (demand last dropping in; supply last lifting in) **and** the last confirmed 15m closes with the zone (demand bull, supply bear) still inside that band. Forming / opposite / doji → wait (do not reject). Through entry → wait (no chase). ≥50% into the zone → `deep_mitigate`. Through SL → `htf_break`. Already pending/open on that symbol → skip. `insufficient_margin` (1x on a tight BTC stop) skips; raise account `defaultLeverage`. `PAPER_PROXIMITY_ARM=0` disables ARM. `PAPER_CONFIRM_15=0` skips the 15m gate.

Manual still works:

```text
bun run paper arm BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --zone-id btc-4h-d-20260908-01
```

Long → alert `--below` at `--price`. Short → `--above`. Override with `--alert-price`. Then **quiet**.

Supply / short: `--above` + `--side short`. Invalidation = structure break (`--sl`; OCO cancels pending if last prints through before fill). `--no-oco` only if you mean it.

Account seed: risk 2%, `minRr` **2** (config, not an engine constant). Engine still has no magic `2`.

## EVENT

EVENT is **OCO + tick**. Do not poll `/confirm` / `/brief` / 30-minute scan. Pending limit invalidates itself; fill/SL/TP fire as events.

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

Same ARM, on **backfilled** klines. Does not touch the live paper ledger. Slippage 0.

```text
bun run backfill --symbol BTCUSDT --days 30
bun run paper replay BTCUSDT --from 2026-08-01 --to 2026-09-01 \
  --side long --price 117500 --sl 116200 --tp 120800 --tf 240,60,15
bun run paper replay-batch ./zones.json
```

Optional `--interval 15` (walk), `--funding-rate` if you want 8h settlements (kline cache has no funding tape). Auto S/D stays in MAP — replay only receives the zone.

Batch file: operator-picked zones (`symbol/side/price/sl/tp/tf` + `from`/`to`). Output is a table (fill / OCO / SL / TP). One bad row does not stop the rest.

## Ban

- Scan on a timer while waiting
- Enter mid-range
- Fade HTF structure
- ICT/SMC unless the zone + HTF already passed
- Live keys, `/v5/order`, paper→live
- Mid-watch PnL

## 24/7 mesh

Daemon (`systemd`, `Restart=always`) already runs feed + paper tick + EVENT notify + kline-lag watchdog.

On confirmed **1H / 4H** bars the closer dumps `GET /map` to `map-latest.json`. On **4H**: MAP_ACCEPT pick → agent policy → `acceptZone`. Family score from 7-day paper metrics ranks before the per-symbol cap when a family has enough fills/trades; missing score is not a veto (`PAPER_ZONE_SCORE=0` off). `MAP_ACCEPT=0` disables the old auto-copy. `AGENT_MAP=0` disables this policy (no-op) — old copy still runs. Stale gates → no accept / no new arm; do not close opens. Tick **proximity-arms** when last is in the proximal band and the last confirmed 15m agrees. `PAPER_PROXIMITY_ARM=0` / `PAPER_CONFIRM_15=0` off. `/zones` itself still does not arm.

Review: `bun run paper week` (7-day funnel detected→accepted→armed→touched→filled + family scores). Override: `paper zone reject`.

`GET /map-latest` reads the last dump (404 before the first close).

`127.0.0.1:43180` public cache. Default watchlist is 10 linear symbols (BTC, ETH, SOL, ENA, BNB, XRP, DOGE, AVAX, LINK, HYPE). Stale ticker → paper rejects. Stale **klines** with a live ticker → `klineLag.ok=false` on `/health` and `/brief-pack`, and `gates.tradingAllowed=false`. Paper **open/limit/arm** reject with `kline_lag`. Do not invent a price or a candle. Do not auto-close existing paper positions.
