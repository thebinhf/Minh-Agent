# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week.

## Three states

| State | When | Minh-Agent | Agent output |
| --- | --- | --- | --- |
| **MAP** | 1H/4H candle close | One `GET /map` (watchlist + `klineLag`). `bun run map`. Optional `GET /zones` (suggest-only). Optional `GET /brief-pack` for `gates` + desk | 5 lines/symbol: bias 4H/1H · 0–2 zones · invalid. Mid-range → **STAND ASIDE**. If `klineLag.ok` or `gates.tradingAllowed` is false, do not trust SQLite candles and do not arm |
| **ARM** | Zone exists, same HTF bias, RR ≥ 1:2 | `paper arm` (limit + alert, post-only, OCO) | Then **quiet** |
| **EVENT** | `alert.fired` / `order.filled` / `order.invalidated` / `position.closed` | One `GET /confirm?interval=15` (scalp: `5`) | Confirm PA → keep limit. No confirm → `paper cancel`. One line, no PnL |

## MAP

Read `ticker` + `klines.240` + `klines.60` + **`klineLag`** from **`GET /map`** (daily `klines.D` if backfilled). No query → feed watchlist (10, cap 10) as `{ maps, klineLag }`. One name stays a single object. Do **not** dump `/brief` 15m into chat. `/brief` is unchanged and is **not** the MAP candle source.

`GET /brief-pack` is optional (desk: pending / alerts / positions + `gates`). Not required to draw zones. Positions have no `unrealizedPnl`. If `gates.tradingAllowed` is false (`kline_lag` and/or `feed_unhealthy`), STAND ASIDE — do not `paper arm` / `paper open`. Existing paper positions stay open; do not spam mid-range alerts.

Check `klineLag.ok` before drawing (1H/4H only on `/map`; 15m lag is EVENT). Stale/formingStuck while ticker is live → STAND ASIDE, do not invent candles.

Optional **`GET /zones`** (`bun run zones`) returns candidate zone-cards from local 4H (or `--interval 60`). Suggest-only: it does **not** arm, open, or limit. Check `klineLag` on that payload the same way as `/map`. Accept by id: `bun run paper zone accept <zoneId>` (pulls the card from `/zones`) or `POST /paper/zones` with `{ "zoneId": "…" }` / a full card. Then proximity ARM or `paper arm … --zone-id <zoneId>` — `/zones` itself does **not** auto-arm.

Quant is a veto, not a signal: `tickers[].fundingRate`, `tickers[].openInterest`, `tickers[].price24hPcnt`, `tickers[].highPrice24h` / `lowPrice24h`.

Open paper (`positions` / `pendingOrders` / `armedAlerts`) is on the brief-pack payload. Positions do **not** include `unrealizedPnl` — use `paper status` if you need PnL. `zones` on the pack is the **accepted ledger** (cap 2/symbol, expires with `expiryBars`). Suggestions stay on **`GET /zones`**. Engine does not auto-arm. Attach `--zone-id` when you `paper arm`.

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

Do not poll `/brief` every 30 minutes. Tick already evaluates alerts/limits/SL-TP.

On ping: **`GET /confirm?symbol=&interval=15`** (ticker + 20×15m). Scalp: `interval=5`. Do **not** pull `/chart` for EVENT. `/brief` unchanged.

Optional ping: `PAPER_NOTIFY=telegram` or `webhook`. Same four kinds. Log-only if unset.

```text
bun run paper status
bun run paper day
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

On confirmed **1H / 4H** bars the closer dumps `GET /map` to `map-latest.json` next to the feed DB (override `MAP_CLOSE_PATH`). Optional `MAP_CLOSE_WEBHOOK` POSTs `{ kind: "map.close", interval, map }` — same payload as `/map`, not a signal. `MAP_CLOSE=0` disables.

Then Agent **accepts** 0–2 cards into the ledger (`paper zone accept`). Tick **proximity-arms** when last is in the proximal band (post-only OCO). `PAPER_PROXIMITY_ARM=0` disables. Does **not** arm `GET /zones` suggestions.

`GET /map-latest` reads the last dump (404 before the first close).

`127.0.0.1:43180` public cache. Default watchlist is 10 linear symbols (BTC, ETH, SOL, ENA, BNB, XRP, DOGE, AVAX, LINK, HYPE). Stale ticker → paper rejects. Stale **klines** with a live ticker → `klineLag.ok=false` on `/health` and `/brief-pack`, and `gates.tradingAllowed=false`. Paper **open/limit/arm** reject with `kline_lag`. Do not invent a price or a candle. Do not auto-close existing paper positions.
