# Operator loop — Minh Agent

Price Action + Supply/Demand. **No 30-minute scan. No live orders.** Paper week.

## Three states

| State | When | Minh-Agent | Agent output |
| --- | --- | --- | --- |
| **MAP** | 1H/4H candle close | `GET /brief?symbol=` or `bun run brief SYMBOL` | 5 lines: bias 4H/1H · 0–2 zones · invalid. Mid-range → **STAND ASIDE** |
| **ARM** | Zone exists, same HTF bias, RR ≥ 1:2 | `paper alert` + `paper limit` (post-only, OCO) | Then **quiet** |
| **EVENT** | `alert.fired` / `order.filled` / `order.invalidated` / `position.closed` | One `GET /chart?interval=15` (scalp: also `5`) | Confirm PA → keep limit. No confirm → `paper cancel`. One line, no PnL |

## MAP

Read `ticker` + `klines.240` + `klines.60` from `/brief`. Do **not** dump 80×15m into chat.

Quant is a veto, not a signal: `ticker.fundingRate`, `ticker.openInterest`.

5M scalp only after HTF bias is set — `GET /chart?symbol=&interval=5`. Not in `/brief`.

Depth/heatmap only when price is **at the zone**, not on a timer.

## ARM

```text
bun run paper alert set BTCUSDT --below 117500 --note "4H demand"
bun run paper limit BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --risk-pct 0.02
```

Supply / short: `--above` + `--side short`. Invalidation = structure break (`--sl`; OCO cancels pending if last prints through before fill). `--no-oco` only if you mean it.

Account seed: risk 2%, `minRr` **2** (config, not an engine constant). Engine still has no magic `2`.

## EVENT

Do not poll `/brief` every 30 minutes. Tick already evaluates alerts/limits/SL-TP.

Optional ping: `PAPER_NOTIFY=telegram` or `webhook`. Same four kinds. Log-only if unset.

```text
bun run paper events --limit 20
bun run paper orders --status pending
bun run paper cancel ID
```

## Ban

- Scan on a timer while waiting
- Enter mid-range
- Fade HTF structure
- ICT/SMC unless the zone + HTF already passed
- Live keys, `/v5/order`, paper→live
- Mid-watch PnL

## Feed

`127.0.0.1:43180` public cache. Stale ticker → paper rejects. Do not invent a price.
