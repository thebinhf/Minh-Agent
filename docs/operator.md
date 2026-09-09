# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week.

## Three states

| State | When | Minh-Agent | Agent output |
| --- | --- | --- | --- |
| **MAP** | 1H/4H candle close | `GET /map?symbol=` or `bun run map SYMBOL` | 5 lines: bias 4H/1H · 0–2 zones · invalid. Mid-range → **STAND ASIDE** |
| **ARM** | Zone exists, same HTF bias, RR ≥ 1:2 | `paper arm` (limit + alert, post-only, OCO) | Then **quiet** |
| **EVENT** | `alert.fired` / `order.filled` / `order.invalidated` / `position.closed` | One `GET /confirm?interval=15` (scalp: `5`) | Confirm PA → keep limit. No confirm → `paper cancel`. One line, no PnL |

## MAP

Read `ticker` + `klines.240` + `klines.60` from `/map` (daily `klines.D` if backfilled). Do **not** dump `/brief` 15m into chat. `/brief` unchanged for full 15/60/240.

Quant is a veto, not a signal: `ticker.fundingRate`, `ticker.openInterest`.

5M scalp only after HTF bias is set — `GET /chart?symbol=&interval=5`. Not in `/brief`.

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

On ping: `GET /confirm?symbol=&interval=15` (ticker + 20×15m). Scalp: `--interval 5`. Do **not** pull `/chart` heatmap. `/brief` unchanged.

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

`127.0.0.1:43180` public cache. Stale ticker → paper rejects. Do not invent a price.
