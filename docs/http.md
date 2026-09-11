# HTTP API

Two localhost binds. JSON, `cache-control: no-store`, CORS `*`. No auth. No live orders.

| Bind | Process | Methods |
| --- | --- | --- |
| `http://127.0.0.1:43180` | Feed — public market cache | `GET`, `OPTIONS` |
| `http://127.0.0.1:43181` | Paper — simulated broker | `GET`, `POST`, `OPTIONS` |

Unknown path → `404` `{ "error": "not found" }`. Wrong method → `405` `{ "error": "method not allowed" }`.

Prices, qty, and money are **decimal strings**. Timestamps are epoch **ms**.

Local push: `ws://127.0.0.1:43180/ws` (same bind). Not a Bybit proxy. `BYBIT_RELAY=0` off.

---

## Feed (`:43180`)

Read-only SQLite cache. Does not arm paper.

### `GET /health`

WS + ticker ages + kline lag (15/60/240).

`ok` is ticker/WS freshness, **not** kline lag. Use `klineLag.ok` (and paper `gates.tradingAllowed`) before drawing HTF.

### `GET /map`

HTF MAP. No 15m.

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` / `symbols` | watchlist (10) | Cap 10. Over cap → `400` `{ "error": "map_symbols", "cap": 10 }` |

One symbol → a single map object. Several / watchlist → `{ ts, maps, klineLag, meta }`.

Each map: `ticker` + `klines.240` (20) + `klines.60` (24) + `klines.D` (30 if backfilled) + `klineLag` (60/240) + `oi` (4H/1H + `deltaPct` + `trend` + `reading`) + `funding` (last 21 rates + `crowded`) + `liq` (4H prints: `below`/`above` + `cascade`) + `flow` (CVD 4H/15m: `delta` + `reading` buy_dom/sell_dom). `cascade` is `{ active, side, intensity, walk, fuel }` — not a boolean burst. `oi.note` / `funding.note` / `liq.note` / `flow.note` is always `quant veto — not a signal`. `/map.flow` 15m is a quant window, not 15m klines.

```bash
curl -sS http://127.0.0.1:43180/map
curl -sS 'http://127.0.0.1:43180/map?symbol=BTCUSDT'
```

### `GET /map-latest`

Last 1H/4H dump (`map-latest.json`). `404` `{ "error": "map_latest_missing" }` until the first confirmed close.

### `GET /zones`

Suggest-only zone-cards from local HTF klines. **Does not arm.**

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` / `symbols` | watchlist | Cap 10 → `400` `map_symbols` |
| `interval` | `240` | `240` or `60`. Else `400` `{ "error": "zones_interval", "allowed": ["240","60"] }` |

Body: `{ ts, symbols, interval, zones, klineLag, meta }`. `meta.suggestOnly` is `true`. Cap 2 cards/symbol from the detector.

```bash
curl -sS 'http://127.0.0.1:43180/zones?interval=240'
```

### `GET /confirm`

Optional LTF snapshot (scalp). Not required to hold an OCO zone.

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` | `BTCUSDT` | |
| `interval` | `15` | `15` or `5`. Else `400` `{ "error": "confirm_interval", "allowed": ["15","5"] }` |

Ticker + 20 klines. No depth, no HTF, no S/D.

### `GET /oi`

Open-interest history from public REST (`/v5/market/open-interest`), cached in SQLite. Not a signal.

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` | `BTCUSDT` | |
| `interval` | `240` | `5` `15` `60` `240` `D`. Else `400` `{ "error": "oi_interval" }` |
| `limit` | 50 | Cap 200 |

Bars oldest→newest. `deltaPct` is (last − first) / first × 100, or `null`. `trend` is `rising` / `falling` / `flat` when `|deltaPct|` is compared to `BYBIT_OI_EXTREME` (default `2` = 2%). `/map.oi.reading` adds the price matrix: `long_add` `short_add` `cover` `flush`. Live spot OI stays on `tickers[].openInterest`. `BYBIT_OI=0` skips REST fill.

```bash
curl -sS 'http://127.0.0.1:43180/oi?symbol=BTCUSDT&interval=240'
```

### `GET /funding`

Funding-rate history from public REST (`/v5/market/funding/history`), 8h settlements, cached in SQLite. Not a signal.

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` | `BTCUSDT` | |
| `limit` | 21 | Cap 200 |

Bars oldest→newest. `latest` prefers live ticker. `crowded` is `long` / `short` / `null` when `|latest| >= extreme` (default `0.0003`, env `BYBIT_FUNDING_EXTREME`). Positive rate = longs pay = crowded long. `BYBIT_FUNDING=0` skips REST fill.

```bash
curl -sS 'http://127.0.0.1:43180/funding?symbol=BTCUSDT'
```

### `GET /flow`

Taker buy/sell CVD from public WS `publicTrade.{symbol}` (BTC/ETH/SOL), aggregated into 1-minute bars. Not a signal. Not the book `/heatmap`. L50 is the full watchlist.

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` | `BTCUSDT` | |

`delta` is 4H signed notional (buy − sell). `reading` is `buy_dom` / `sell_dom` / `null` when `|imbalance|` ≥ `BYBIT_FLOW_EXTREME` (default `0.15`). Nested `"240"` / `"15"` are the same windows. Quant veto uses the 4H reading at MAP accept only (`sell_dom` vs demand / `buy_dom` vs supply). ARM skips it like opposing OI add. `BYBIT_FLOW=0` skips the WS subscribe; empty tape is not a veto.

```bash
curl -sS 'http://127.0.0.1:43180/flow?symbol=BTCUSDT'
```

### `GET /liq-heatmap`

Actual Bybit liquidation **prints**, not Coinglass estimates. Public WS `allLiquidation.{symbol}` (BTC/ETH/SOL). `Buy` = long liquidated.

| Query | Default | Notes |
| --- | --- | --- |
| `symbol` | `BTCUSDT` | |
| `hours` | 24 | Cap 48 (retention) |
| `bucket` | from last | BTC ~50, ETH ~5 |

Bins: `longSize` / `shortSize` / `count`. `cascade` is `{ active, side: long|short|null, intensity, walk, fuel }`:

- `side` — ≥70% of 5m burst size is `Buy` (long-liq) or `Sell` (short-liq)
- `intensity` — burst / baseline 5m average **outside** the burst (null if the tape was quiet)
- `walk` — same-side bankruptcy prices move with the forced flow (≥ 1 bucket)
- `active` — `side` set **and** (`intensity ≥ 3` **and** (`walk` **or** matching OI `flush`/`cover`)) **or** cold-start (no baseline, ≥8 walking prints)
- `fuel` — remaining `below` (long) / `above` (short) near last — not the burst

Quiet 3 prints do not trip. Mixed long/short bursts do not trip. Not a signal. `GET /heatmap` stays the orderbook grid. `BYBIT_LIQ=0` skips the stream.

```bash
curl -sS 'http://127.0.0.1:43180/liq-heatmap?symbol=BTCUSDT&hours=24'
```

### `GET /liq-model`

**Estimated** forward map — not prints, not Coinglass. Isolated MMR (risk-limit cache or `0.005`) × public mix `10x/20x/50x` (`0.50/0.35/0.15`) × VW 15m entries (48 bars) × ticker OI. Each side capped at `oiUsd/2`. `meta.note` is always `model — not exchange data`. `ok=false` + `broken` when last/OI/entries missing. Does not arm. `BYBIT_LIQ_MODEL=0` off. Do not mix with `/liq-heatmap`.

```bash
curl -sS 'http://127.0.0.1:43180/liq-model?symbol=BTCUSDT'
```

### `ws://127.0.0.1:43180/ws`

Local relay. Same process as the HTTP cache. Topics:

| Subscribe | Push |
| --- | --- |
| `ticker.BTCUSDT` / `ticker.*` | Thin last/mark/funding/OI, coalesced 1s (`BYBIT_RELAY_TICKER_MS`) |
| `kline.15.BTCUSDT` / `kline.240.*` | **Confirmed** bar only |
| `liq.BTCUSDT` / `liq.*` | Coalesced bins. 1s window; quiet (<3 prints) waits one extra window. Same-side burst (≥8, 70%) or 32 prints flush now. `BYBIT_RELAY_LIQ_MS` |

No orderbook stream (use `GET /depth`). Cascade stays on `GET /map`. Protocol: `{ op, args }` subscribe/unsubscribe/ping, same shape as Bybit. Cap 16 clients, 32 topics. `meta.note` is `local push — not Bybit`.

```js
const ws = new WebSocket("ws://127.0.0.1:43180/ws");
ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", args: ["ticker.BTCUSDT", "liq.*", "kline.240.BTCUSDT"] }));
```

### `GET /brief`

One-symbol snapshot for Minh: ticker + 15/60/240. Unchanged. Default symbol `BTCUSDT`. Not the MAP candle source.

### `GET /brief-pack`

Tickers + kline lag + `gates` + paper desk + **accepted** ledger zones.

| Query | Default |
| --- | --- |
| `symbol` | all watchlist tickers |

`gates.tradingAllowed` is false when WS is down and/or `klineLag.ok` is false. Positions have no `unrealizedPnl`. `zones` is the paper ledger, not `GET /zones`.

### `GET /chart`

Stitched OHLCV.

| Query | Notes |
| --- | --- |
| `symbol` | |
| `interval` | |
| `limit` | |
| `start` `end` | epoch ms |

### `GET /depth`

Live L50 ladder. Query: `symbol`. Paper taker fills (`paper open` / manual close / `--cross` immediate) walk this book. Not `/heatmap`.

### `GET /heatmap`

Book snapshots + live book. Query: `symbol`, `limit`, `start`, `end`, `bucket` (price bucket; omit = raw).

### `GET /market`

One payload: ticker + chart + depth + heatmap.

| Query | Notes |
| --- | --- |
| `symbol` `interval` `limit` | chart |
| `heatmapLimit` `bucket` | heatmap |

### Raw cache

| Route | Query | Body |
| --- | --- | --- |
| `GET /tickers` | `symbol?` | `{ tickers }` |
| `GET /orderbooks` | `symbol?` | `{ orderbooks }` L50 |
| `GET /klines` | `symbol?` `interval?` `limit?` `confirm?` `start?` `end?` | `{ klines }` |
| `GET /kline-stats` | `symbol?` `interval?` | `{ stats }` |
| `GET /meta` | | `{ meta }` |

`confirm` is `1`/`true` or `0`/`false`.

---

## Paper (`:43181`)

Simulation only. Fills from `:43180`. `mode: "paper"` on mutating responses.

Rejects: `400` `{ "mode": "paper", "error", "gate", … }` except `not_found` → `404`, `already_closed` → `409`.

New open / limit / arm reject when feed WS is down (`feed_unhealthy`) or `klineLag.ok` is false (`kline_lag`). Open positions are **not** auto-closed.

### Health and desk

| Route | Notes |
| --- | --- |
| `GET /paper/health` | `{ ok, mode, feed, account, gates }` |
| `GET /paper/account` | Equity, cash, risk band, leverage |
| `GET /paper/status` | Account + pending + open + alerts + recent events |
| `GET /paper/event` | EVENT desk: pending OCO + armed alerts + open + accepted zones. Do not poll `/confirm` |
| `GET /paper/day?day=YYYY-MM-DD` | UTC session fills / OCO / closes (`day` default today) |
| `GET /paper/week` | 7-day metrics + standing ledger + `review.families` |
| `GET /paper/metrics?days=N` | Funnel detected→accepted→armed→touched→filled. `byFamily` / `score`. `days` 1–365, default 7 |
| `GET /paper/events?limit=N` | Default 50 |

### Zones (ledger)

`GET /zones` on the feed is suggest-only. This is the **accepted** paper list.

| Route | Body / query |
| --- | --- |
| `GET /paper/zones` | `status=accepted\|rejected\|expired\|all` (default `accepted`) |
| `POST /paper/zones` | `{ "zoneId": "btc-4h-s-…" }` (looks up feed `/zones`) **or** a full zone-card. `201` |
| `POST /paper/zones/:zoneId/reject` | optional `{ "code" }` default `ops_cancel` |

Cap 2 accepted / symbol. Duplicate → `duplicate_zone`. Does **not** arm.

### Arm / limit / alert

Shared open fields: `symbol`, `side` (`long`\|`short`), `stopLoss`, `takeProfit` or `takeProfits: [{ price, qtyPct }]`, `timeframes` (≥2), optional `riskPct`, `leverage`, `note`, `zoneId`.

| Route | Body | Notes |
| --- | --- | --- |
| `POST /paper/arm` | open fields + `limitPrice`; optional `postOnly`, `oco`, `invalidatePrice`, `alertPrice`, `alertOp` | Limit + fire-once alert. `201` |
| `POST /paper/orders` | same without alert | Resting GTC. `201` |
| `GET /paper/orders` | `status=pending\|filled\|cancelled\|rejected\|invalidated\|all` | Default `pending` |
| `POST /paper/orders/:id/cancel` | | |
| `POST /paper/alerts` | `{ symbol, op: above\|below, price, note? }` | `201` |
| `GET /paper/alerts` | `status=armed\|fired\|cancelled\|all` | Default `armed` |
| `POST /paper/alerts/:id/cancel` | | |

`postOnly` and `oco` default **true**. Long alert defaults `--below` at `limitPrice`; short `--above`.

OCO: last through `invalidatePrice` (default SL) **before** the limit → `order.invalidated`, no fill. Bound pending (`zoneId`) also dies with the ledger card (expire / deep / HTF / zone reject). After fill, SL/TP run on the position.

### Positions

| Route | Notes |
| --- | --- |
| `GET /paper/positions?status=open\|closed\|all` | Default `open` |
| `POST /paper/positions` | Market-style open. L50 VWAP when the book is fresh; else last. Response includes `slippage` / `fallback`. `201` |
| `POST /paper/positions/:id/close` | Manual close. L50 VWAP when the book is fresh; else last |
| `POST /paper/mark` | Tick: expire zones (cancel bound OCO), pending proximity, fire alerts, OCO, quant hold, fill limits, mark SL/TP/funding |

```bash
curl -sS http://127.0.0.1:43181/paper/event
curl -sS -X POST http://127.0.0.1:43181/paper/zones \
  -H 'content-type: application/json' \
  -d '{"zoneId":"btc-4h-s-20260908-01"}'
curl -sS http://127.0.0.1:43181/paper/week
```

---

## Loop → routes

| State | Feed | Paper |
| --- | --- | --- |
| MAP (4H close) | `GET /map`, `GET /zones` | `POST /paper/zones` (automatic: `MAP_ACCEPT` on; agent policy unless `AGENT_MAP=0`) |
| ARM | — | tick / `POST /paper/arm` |
| EVENT | optional `GET /confirm` | `GET /paper/event` |

Playbook: [operator.md](operator.md). Paper spec: [paper-trading.md](paper-trading.md). Feed internals: [exchanges/BB.md](exchanges/BB.md).
