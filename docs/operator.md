# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week.

## Three states

| State | When | Engine | Operator |
| --- | --- | --- | --- |
| **MAP** | 1H/4H close | Dump `/map`. **4H** copies `/zones` into the ledger (`MAP_ACCEPT=0` off) | Override: `paper zone reject`. Mid-range → stand aside. If `klineLag.ok` / `gates.tradingAllowed` is false, do not trust candles |
| **ARM** | Last in proximal → entry on an **accepted** card | Tick rests post-only OCO (`PAPER_PROXIMITY_ARM=0` off) | Manual `paper arm` still works. Then **quiet** |
| **EVENT** | Pending limit / open position | Tick: OCO invalidate-before-fill, then SL/TP | `paper event`. Do not poll `/confirm`. Optional scalp `/confirm?interval=15` |

## MAP

Read `ticker` + `klines.240` + `klines.60` + **`klineLag`** from **`GET /map`** (daily `klines.D` if backfilled). No query → feed watchlist (10, cap 10) as `{ maps, klineLag }`. Do **not** dump `/brief` 15m into chat. `/brief` is unchanged and is **not** the MAP candle source.

`GET /brief-pack` is optional (desk: pending / alerts / positions + `gates` + accepted ledger). Positions have no `unrealizedPnl`. If `gates.tradingAllowed` is false, STAND ASIDE — new arm/open/limit reject. Existing paper positions stay open.

Check `klineLag.ok` before drawing (1H/4H on `/map`; 15m lag is scalp-only). Stale/formingStuck while ticker is live → STAND ASIDE, do not invent candles.

**`GET /zones`** (`bun run zones`) is suggest-only: it does **not** arm. 4H MAP-accept copies those cards into the paper ledger. Manual: `bun run paper zone accept <zoneId>` or `POST /paper/zones` `{ "zoneId" }` / full card / `FILE.json`. Cap 2/symbol. Expires with `expiryBars`. `/zones` itself does **not** arm.

Quant is a veto, not a signal: `tickers[].fundingRate`, `tickers[].openInterest`, `tickers[].price24hPcnt`.

5M scalp only after HTF bias is set — `GET /confirm?symbol=&interval=5`. Not in `/brief` / `/brief-pack` / `/map`.

Depth/heatmap only when price is **at the zone**, not on a timer.

## ARM

Accepted ledger cards rest themselves when last enters **proximal → entry** (demand last dropping in; supply last lifting in). Through entry → wait (no chase). ≥50% into the zone → `deep_mitigate`. Through SL → `htf_break`. Already pending/open on that symbol → skip. `insufficient_margin` (1x on a tight BTC stop) skips; raise account `defaultLeverage`. `PAPER_PROXIMITY_ARM=0` disables.

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

On confirmed **1H / 4H** bars the closer dumps `GET /map` to `map-latest.json`. On **4H** the composition root copies `GET /zones` cards into the paper ledger (`MAP_ACCEPT=0` disables). Tick **proximity-arms** when last is in the proximal band. `PAPER_PROXIMITY_ARM=0` disables. `/zones` itself still does not arm.

Review: `bun run paper week` (7-day funnel detected→accepted→armed→touched→filled). Override: `paper zone reject`.

`GET /map-latest` reads the last dump (404 before the first close).

`127.0.0.1:43180` public cache. Default watchlist is 10 linear symbols (BTC, ETH, SOL, ENA, BNB, XRP, DOGE, AVAX, LINK, HYPE). Stale ticker → paper rejects. Stale **klines** with a live ticker → `klineLag.ok=false` on `/health` and `/brief-pack`, and `gates.tradingAllowed=false`. Paper **open/limit/arm** reject with `kline_lag`. Do not invent a price or a candle. Do not auto-close existing paper positions.
