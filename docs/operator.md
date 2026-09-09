# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week.

## Three states

| State | When | Minh-Agent | Agent output |
| --- | --- | --- | --- |
| **MAP** | 1H/4H candle close | `GET /map?symbols=` (HTF candles) + `GET /brief-pack` (lag + desk). `bun run map BTCUSDT ETHUSDT` / `brief-pack` | 5 lines/symbol: bias 4H/1H · 0–2 zones · invalid. Mid-range → **STAND ASIDE**. If `klineLag.ok` is false, do not trust SQLite candles |
| **ARM** | Zone exists, same HTF bias, RR ≥ 1:2 | `paper arm` (limit + alert, post-only, OCO) | Then **quiet** |
| **EVENT** | `alert.fired` / `order.filled` / `order.invalidated` / `position.closed` | One `GET /confirm?interval=15` (scalp: `5`) | Confirm PA → keep limit. No confirm → `paper cancel`. One line, no PnL |

## MAP

Read `ticker` + `klines.240` + `klines.60` from **`GET /map`** (daily `klines.D` if backfilled). Several names: `GET /map?symbols=BTCUSDT,ETHUSDT,SOLUSDT` → `{ maps: [...] }`. One name stays a single object. Do **not** dump `/brief` 15m into chat. `/brief` is unchanged (full 15/60/240 dump) and is **not** the MAP candle source.

Read `tickers` + `klineLag` + open paper from **`GET /brief-pack`**. Additive only — it does **not** replace `/map`. Check `klineLag.rows` before drawing. Stale/formingStuck while ticker is live means the cache is not advancing — STAND ASIDE, do not invent candles.

Quant is a veto, not a signal: `tickers[].fundingRate`, `tickers[].openInterest`, `tickers[].price24hPcnt`, `tickers[].highPrice24h` / `lowPrice24h`.

Open paper (`positions` / `pendingOrders` / `armedAlerts`) is on the brief-pack payload. Positions do **not** include `unrealizedPnl` — use `paper status` if you need PnL. `zones` is `[]` until a store exists — Agent draws S/D, engine does not.

5M scalp only after HTF bias is set — `GET /confirm?symbol=&interval=5`. Not in `/brief` / `/brief-pack` / `/map`.

Depth/heatmap only when price is **at the zone**, not on a timer.

## ARM

```text
bun run paper arm BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --risk-pct 0.02
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

## Feed

`127.0.0.1:43180` public cache. Default watchlist is 10 linear symbols (BTC, ETH, SOL, ENA, BNB, XRP, DOGE, AVAX, LINK, HYPE). Stale ticker → paper rejects. Stale **klines** with a live ticker → `klineLag.ok=false` on `/health` and `/brief-pack`. Do not invent a price or a candle.
