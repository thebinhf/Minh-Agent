# Bybit (BB) — public market cache

Local SQLite cache of Bybit **public linear** market data. Minh can read prices from localhost instead of Bybit MCP (avoids Usage quota). The WebSocket feed also works where Bybit REST is geo-blocked.

**Not a trading bot:** no API keys, no private topics, no order placement.

Adapter path: `src/feed/bb/`.

## Design

| Item | Value |
| --- | --- |
| Runtime | Bun + TypeScript + `bun:sqlite` |
| Endpoint | `wss://stream.bybit.com/v5/public/linear` |
| Symbols | BTCUSDT ETHUSDT SOLUSDT ENAUSDT BNBUSDT XRPUSDT DOGEUSDT AVAXUSDT LINKUSDT HYPEUSDT |
| Kline intervals | Live WS: 5, 15, 60, 240. REST/backfill also accept Bybit v5 `1`,`3`,`5`,`15`,`30`,`60`,`120`,`240`,`360`,`720`,`D`,`W`,`M` |
| Orderbook | depth 50 for the full watchlist (10). `BYBIT_ORDERBOOK_SYMBOLS` intersects the watchlist |
| Topics | `tickers.{symbol}`, `kline.{interval}.{symbol}`, `orderbook.50.{symbol}` (watchlist), `allLiquidation.{symbol}` / `publicTrade.{symbol}` (default = watchlist; `BYBIT_TAPE_SYMBOLS=0` none) |
| HTTP | read-only `127.0.0.1:43180` |
| Auth | none |

Topic names match Bybit V5 public docs: [connect](https://bybit-exchange.github.io/docs/v5/ws/connect), [ticker](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker), [kline](https://bybit-exchange.github.io/docs/v5/websocket/public/kline), [orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook), [public trade](https://bybit-exchange.github.io/docs/v5/websocket/public/trade).

Linear tickers are snapshot-then-delta (missing field = unchanged). Orderbook.50 is snapshot-then-delta; size `0` deletes a level; `u=1` means the book service restarted and the payload replaces the local book. Heartbeat is a client `ping` about every 20s.

## Recovery

| Step | Behavior |
| --- | --- |
| Stale pong | After `watchdogGraceMs` (30s), if no pong for `pongStaleMs` (60s), close the socket so reconnect/backoff runs. |
| Kline lag | After subscribe, `GET /health` `klineLag` compares 15/60/240 `recv_ts` / `start_ts` to ticker freshness. Default `klineLagMs` = 180000 (3 min). Logs once when a series goes stale while ticker WS is still live, and once on recover. Not a price-watch ping. |
| Gap-fill | After subscribe succeeds, REST `GET /v5/market/kline` backfills each symbol×interval from `MAX(start_ts)` (or `klinesDays` lookback). Failures are logged; WS stays up. Disable with `BYBIT_GAP_FILL=0`. |
| Historical backfill | One-shot `bun run backfill` walks a full window (default 15/60/240) via REST failover or a JSON/CSV dump. Interval list is Bybit v5 ids (minutes or `D`/`W`/`M`). Does not start WS. |
| Orderbook | `books.clear()` on every connect. Deltas are ignored until a snapshot or `u=1`. |
| Retry | Subscribe in chunks of 10 with ack timeout + 3 retries. REST kline uses the same retry helper. |

REST is **best-effort**. Official `api.bybit.com` / `api.bytick.com` return CloudFront HTTP 403 from many US cloud IPs. The tracker still runs on public linear WS. On 401/403/404, kline fetch tries `restFallbacks` (default `https://api.manepa.jp`, Bybit's documented Japan public host). That host served `/v5/market/kline` from a US AWS VM on 2026-09-06; treat it as opportunistic. If every REST host fails, import a dump (below) — live WS is unchanged.

`public.bybit.com/kline_for_metatrader4/` is also reachable from US cloud (S3 listing + `.csv.gz`). Those monthly files currently stop at 2025, so they are for older history, not the open 2026 candles.

## Quick start

```bash
bun install
bun test
bun run start
```

HTTP (read-only `127.0.0.1:43180`; full contract: [http.md](../http.md)):

- `GET /health` — WS + ticker ages + `klineLag` (15/60/240 per symbol)
- `GET /brief?symbol=BTCUSDT` — one snapshot for Minh (ticker + 15/60/240)
- `GET /map` — HTF MAP for the feed watchlist (`{ maps, klineLag }`, cap 10)
- `GET /map-latest` — last HTF-close dump (`404` until the first 1H/4H confirm)
- `GET /map?symbol=BTCUSDT` — one symbol (ticker + 4H/1H + D + klineLag 60/240)
- `GET /map?symbols=BTCUSDT,ETHUSDT,SOLUSDT` — `{ maps, klineLag }`
- `GET /confirm?symbol=BTCUSDT&interval=15` — optional LTF (ticker + 20×15m; scalp `interval=5`)
- `GET /zones` — suggest-only zone-cards (default 4H; `?interval=60`)
- `GET /oi?symbol=BTCUSDT&interval=240` — OI history (quant veto, not a signal)
- `GET /funding?symbol=BTCUSDT` — funding history (quant veto, `crowded`)
- `GET /flow?symbol=BTCUSDT` — taker CVD 4H/15m (quant veto, `buy_dom`/`sell_dom`; not `/heatmap`)
- `GET /liq-heatmap?symbol=BTCUSDT` — actual liquidation prints (not Coinglass; not `/heatmap` book)
- `GET /liq-model?symbol=BTCUSDT` — estimated isolated map (OI-capped; `model — not exchange data`)
- `ws://127.0.0.1:43180/ws` — local relay (`ticker.*` / `kline.240.*` / `liq.*`). Not a Bybit proxy.
- `GET /brief-pack` — tickers + kline lag + `gates` + paper desk + accepted ledger
- `GET /chart?symbol=BTCUSDT&interval=15&limit=200` — stitched kline OHLCV for a chart
- `GET /depth?symbol=ETHUSDT` — live L50 ladder with cumulative size
- `GET /heatmap?symbol=BTCUSDT&limit=120&bucket=10` — liquidity grid from book snapshots (+ live book)
- `GET /market?symbol=BTCUSDT&interval=15` — one payload: ticker + chart + depth + heatmap
- `GET /tickers?symbol=BTCUSDT`
- `GET /orderbooks?symbol=ETHUSDT`
- `GET /klines?symbol=SOLUSDT&interval=15&limit=50&start=&end=`
- `GET /kline-stats?symbol=BTCUSDT&interval=15`
- `GET /meta`

CLI against the same SQLite file:

```bash
bun run brief BTCUSDT
bun run map
bun run confirm BTCUSDT
bun run brief-pack
bun run brief-pack BTCUSDT
bun run query health
bun run query tickers BTCUSDT
bun run query orderbooks ETHUSDT
bun run query klines SOLUSDT 15 --limit 20
bun run query klines BTCUSDT 15 --start 2026-08-01 --end 2026-09-01 --limit 2000
bun run query kline-stats BTCUSDT 15
bun run query chart BTCUSDT 15 --limit 200
bun run query depth ETHUSDT
bun run query heatmap BTCUSDT --limit 120 --bucket 10
bun run query market BTCUSDT 15 --bucket 10
bun run query meta
```

`--start` / `--end` on `query klines` are Unix epoch **milliseconds** (13-digit), ISO-8601, or `YYYY-MM-DD`. Seconds (10-digit) are not accepted. `--from` is a `backfill` flag (REST keyword or dump PATH/URL), not a query flag.

### Historical klines for PA (15 / 60 / 240) and higher TFs (`D` / `W`)

Live WS only writes candles while the process is up. Deeper history is a separate, one-shot job. It writes the same `klines` table; Minh never talks to a trading API.

`--interval` is a comma-separated list of Bybit v5 public kline ids. Numeric values are minutes. Named values: `D` (daily), `W` (weekly), `M` (monthly). Defaults stay `15,60,240`. Mix is allowed (`5,15,30,60,120,240,360,720,D,W`).

```bash
# Probe which public REST hosts answer from this machine
bun run backfill --probe

# REST: try official host, then restFallbacks. Default intervals 15,60,240
bun run backfill --days 14
bun run backfill --symbol BTCUSDT,ETHUSDT --interval 15,60,240 --days 30
bun run backfill --symbol BTCUSDT --interval 5,15,30,60,120,240,360,720 --days 14
bun run backfill --symbol BTCUSDT --interval D,W --days 365

# Offline / dump import (JSON REST envelope, tuple array, or MT4 CSV; gzip ok)
bun run backfill --from ./btc-15.json --symbol BTCUSDT --interval 15
bun run backfill --from https://public.bybit.com/kline_for_metatrader4/BTCUSDT/2025/BTCUSDT_15_2025-01-01_2025-01-31.csv.gz
```

Read what landed:

| Surface | How |
| --- | --- |
| Snapshot brief | `bun run brief SYMBOL` or `GET /brief?symbol=` — ticker + last 80×15m / 48×1h / 30×4h |
| HTF map | `bun run map` or `GET /map` — watchlist (cap 10). Ticker + 20×4h / 24×1h / 30×D + klineLag 60/240 + `oi` |
| Open interest | `bun run query oi SYMBOL [INTERVAL]` or `GET /oi` — REST `/v5/market/open-interest` cache. Quant veto. |
| Funding | `bun run query funding SYMBOL` or `GET /funding` — REST `/v5/market/funding/history` cache. Quant veto. |
| Flow | `bun run query flow SYMBOL` or `GET /flow` — WS `publicTrade` 1m CVD. Quant veto. |
| Liquidation | `bun run query liq-heatmap SYMBOL` or `GET /liq-heatmap` — WS `allLiquidation` prints. Quant veto. |
| Liq model | `bun run query liq-model SYMBOL` or `GET /liq-model` — estimated, inventory-capped. Not a signal. |
| Zone suggest | `bun run zones` or `GET /zones` — candidate zone-cards from local 4H/1H. Suggest-only; no auto-arm. Paper ledger is `/brief-pack.zones` |
| LTF confirm | `bun run confirm SYMBOL` or `GET /confirm?symbol=&interval=15` — optional scalp snapshot |
| Brief pack | `bun run brief-pack [SYMBOL]` or `GET /brief-pack` — tickers + kline lag + `gates` + paper desk + accepted zones |
| Chart / depth / heatmap | `bun run query chart\|depth\|heatmap\|market` or `GET /chart` `/depth` `/heatmap` `/market` |
| CLI | `bun run query klines SYMBOL INTERVAL --start TIME --end TIME --limit N` (cap 20000) |
| HTTP | `GET /klines?symbol=BTCUSDT&interval=15&start=&end=&limit=1000` and `GET /kline-stats` |
| SQL | `SELECT * FROM klines WHERE symbol=? AND interval=? AND start_ts>=? ORDER BY start_ts` |

## Snapshot brief

Minh should read **one** local payload instead of stitching `/tickers` + `/klines` (or MCP). CLI and HTTP share the same JSON:

```json
{
  "symbol": "BTCUSDT",
  "ts": 0,
  "ticker": {
    "lastPrice": null,
    "markPrice": null,
    "bid1Price": null,
    "ask1Price": null,
    "fundingRate": null,
    "nextFundingTime": null,
    "openInterest": null,
    "openInterestValue": null,
    "recvTs": null
  },
  "klines": { "15": [], "60": [], "240": [] },
  "meta": { "db": "...", "limits": { "15": 80, "60": 48, "240": 30 } }
}
```

- Default symbol is `BTCUSDT`.
- Missing ticker / candles → `null` / `[]`. The endpoint does not 404 for an unknown symbol.
- Kline rows: `start_ts`, `open`, `high`, `low`, `close`, `volume`, `turnover`, `confirm` (boolean).
- Arrays are **oldest-first (newest last)**. The last row is the most recent candle and may be unconfirmed.
- Read-only against local SQLite. No API keys, no private WS, no orders.

## Health / kline lag

`GET /health` (and `bun run query health`) keeps the existing WS fields. `ok` is still ticker/WS freshness (paper uses this). Kline lag is a nested object so MAP can see a stuck 15/60/240 series without treating SQLite as live.

```json
{
  "ok": true,
  "connected": true,
  "tickers": [{ "symbol": "BTCUSDT", "lastPrice": "100", "ageMs": 120 }],
  "klineLag": {
    "ok": false,
    "staleMs": 180000,
    "intervals": ["15", "60", "240"],
    "rows": [
      {
        "symbol": "BTCUSDT",
        "interval": "15",
        "startTs": 0,
        "recvTs": 0,
        "confirm": false,
        "klineLagMs": 240000,
        "tickerAgeMs": 120,
        "tickerLive": true,
        "formingStuck": true,
        "stale": true
      }
    ]
  }
}
```

A row is `stale` only while the ticker is live (`tickerAgeMs` < 15s) **and** an existing 15/60/240 candle has not advanced for `klineLagMs` (old `recv_ts`, forming candle stuck, or confirmed bar that never opened the current interval). Missing klines (`startTs: null`) stay visible as nulls and do **not** trip the watchdog — that avoids boot spam before the first WS kline. Watchdog logs once on trip and once on recover — not a mid-range price watch.

## Brief pack

Additive MAP helper: tickers + kline lag + open paper desk. It does **not** replace `GET /map` (HTF candles) and is **not** a candle dump. CLI and HTTP share the same JSON. `/brief` is unchanged.

```json
{
  "ts": 0,
  "symbols": ["BTCUSDT"],
  "tickers": [
    {
      "symbol": "BTCUSDT",
      "lastPrice": null,
      "price24hPcnt": null,
      "highPrice24h": null,
      "lowPrice24h": null,
      "volume24h": null,
      "turnover24h": null,
      "fundingRate": null,
      "nextFundingTime": null,
      "openInterest": null,
      "openInterestValue": null,
      "recvTs": null
    }
  ],
  "klineLag": { "ok": true, "staleMs": 180000, "intervals": ["15", "60", "240"], "rows": [] },
  "gates": { "tradingAllowed": true, "reasons": [] },
  "paper": { "source": null, "positions": [], "pendingOrders": [], "armedAlerts": [] },
  "zones": [],
  "meta": { "db": "...", "klinesDays": 180, "paperSource": null }
}
```

- Default: every configured feed symbol. `?symbol=` / CLI positional filters one pair.
- Missing ticker / kline / paper → `null` / `[]`. Unknown symbol does not 404.
- `klineLag` is the same object as `GET /health`.
- `gates` is additive: `tradingAllowed` is false when feed `/health` `ok` is false (`feed_unhealthy`) or `klineLag.ok` is false (`kline_lag`). Paper open/limit/arm reject with those codes. Does not auto-close existing paper positions and does not send extra alerts.
- `paper` is the **local** paper desk (open positions, pending limits, armed alerts). `paper.source` is `http://127.0.0.1:43181` when the daemon injects the in-process engine (paper HTTP bind; no hop), or `sqlite:<PAPER_DB_PATH>` for `bun run brief-pack`. Missing paper → `source: null` and empty arrays. Feed does not import `src/paper`.
- Paper row shapes are slim: positions (`id, symbol, side, entryPrice, stopLoss, takeProfit, qty, leverage, riskPct, status, openedTs` — no `unrealizedPnl`; use `paper status` for PnL), pendingOrders (`id, symbol, side, type, limitPrice, qty, stopLoss, takeProfit, status, createdTs`), armedAlerts (`id, symbol, op, price, status, createdTs`). Missing fields are `null`.
- `zones` is always `[]`. Suggest-only cards live on `GET /zones`; this pack does not auto-detect or auto-arm.

## Chart, depth, heatmap

These are **read models** on the same public cache. They do not start a browser UI and they do not invent prices.

```text
kline.{interval}.{symbol}  ──upsert (symbol, interval, start)──►  GET /chart
                               volume = kline.volume
                               last bar may be confirm=false

orderbook.50.{symbol}      ──snapshot, then delta; u=1 reset──►  GET /depth
                               size 0 deletes a level
                               snapshots every orderbookEveryMs ──►  GET /heatmap
                               + orderbook_latest as last column when newer

GET /market  = ticker + /chart + /depth + /heatmap   (one local JSON)
```

**Nối nến (correct):** subscribe each interval (`5` / `15` / `60` / `240`) and upsert by `start`. The forming candle is the same `start` row mutating until `confirm=true`. After reconnect, REST gap-fill writes the same table; `/chart` sorts oldest-first and lists missing steps in `gaps`.

**Incorrect:** building OHLC from `tickers.lastPrice`, using `volume24h` as bar volume, or aggregating 5m into 15m in application code while 15m is already on the wire.

| View | Source | Not this |
| --- | --- | --- |
| `/chart` | `klines` (`source: "kline"`, `volumeSource: "kline.volume"`) | ticker last / volume24h |
| `/depth` | `orderbook_latest` (bids desc, asks asc, `cumSize` from the touch) | mid blend, trades |
| `/heatmap` | `orderbook_snapshots` + live `orderbook_latest` (`live: true` when the last column is current) | trade footprint / CVD (needs `publicTrade`, not subscribed) |
| `/market` | ticker + `/chart` + `/depth` + `/heatmap` | stitching those four endpoints by hand |

`/heatmap?bucket=10` rounds prices to a step before summing size. Default snapshot cadence is 5s; retention is `orderbookSnapshotsHours` (6h). If `orderbook_latest.recv_ts` is newer than the last snapshot, that book is appended as the last column. Empty cache returns empty arrays, not a fake series.

Ticker history snapshots are **off** by default (`snapshot.tickerEveryMs: 0`) — nothing reads `ticker_snapshots`. `ticker_latest` still upserts every tick. Set `tickerEveryMs` > 0 only if you want a 24h ticker tape. Orderbook snapshots still write on the timer only (not on every WS snapshot / reconnect `u=1`).

HTTP stays `Bun.serve` on localhost. No Elysia / Express.

Confirmed klines older than `retention.klinesDays` (default 180) are pruned by the live tracker. If `--days` is larger, set `BYBIT_KLINES_DAYS` (or `retention.klinesDays`) to the same window **before** starting the daemon, or the extra history will be deleted.

Prune PASSIVE-checkpoints first, then TRUNCATE only if no reader holds the WAL (`wal=trunc|passive busy=N log=N` in the log). Then `PRAGMA shrink_memory`. If free pages are ≥15% of the file (and at least an hour since the last vacuum), it `VACUUM`s so the file actually shrinks. Page cache is capped at 4 MiB (`cache_size = -4096`); `mmap_size = 0` so a large file is not mapped into RSS; WAL autocheckpoints at ~2 MiB and is hard-capped at 8 MiB. Feed and paper share `src/sqlite.ts`. The extra `klines(symbol, interval, start_ts DESC)` index is dropped — the primary key already covers that lookup.

## Config and env overrides

Defaults live in `src/feed/bb/config.json`. Environment variables win when set:

| Env | Maps to |
| --- | --- |
| `BYBIT_CONFIG` | path to config JSON |
| `BYBIT_WS_ENDPOINT` | WebSocket URL |
| `BYBIT_HTTP_HOST` / `BYBIT_HTTP_PORT` | bind address (default `127.0.0.1:43180`) |
| `BYBIT_DB_PATH` | SQLite file |
| `BYBIT_SYMBOLS` | comma-separated symbols |
| `BYBIT_KLINE_INTERVALS` | comma-separated live WS intervals (same Bybit v5 ids as backfill: minutes or `D`/`W`/`M`) |
| `BYBIT_ORDERBOOK_SYMBOLS` | comma-separated L50 symbols (intersected with the watchlist) |
| `BYBIT_ORDERBOOK_DEPTH` | book depth |
| `BYBIT_PING_INTERVAL_MS` | heartbeat interval |
| `BYBIT_REST_ENDPOINT` | REST base (`https://api.bybit.com`) |
| `BYBIT_REST_FALLBACKS` | comma-separated extra REST bases; empty string disables fallbacks |
| `BYBIT_KLINES_DAYS` | confirmed-kline retention (also the default `backfill --days`) |
| `BYBIT_PONG_STALE_MS` | watchdog stale-pong threshold |
| `BYBIT_KLINE_LAG_MS` | 15/60/240 kline-lag threshold while ticker is live (default 180000) |
| `BYBIT_GAP_FILL` | `0` disables REST kline gap-fill |

SQLite tables: `ticker_latest`, `ticker_snapshots` (opt-in), `orderbook_latest`, `orderbook_snapshots`, `klines`, `connection_health`, `meta`.

Retention prune drops old snapshot rows and confirmed klines on a timer (`retention` in `config.json`), then checkpoints WAL and vacuums when the freelist is large.

## Deploy

Unit file: [`deploy/bybit-tracker.service`](../../deploy/bybit-tracker.service). Copy it to `/etc/systemd/system/`, set `WorkingDirectory` to the Minh Agent checkout (`/opt/minh-agent`), set `BYBIT_DB_PATH`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bybit-tracker
```

After a green CI merge on the host: [`deploy/pull-restart.sh`](../../deploy/pull-restart.sh) (`git pull --ff-only` + `systemctl restart`). GitHub Actions never SSH and never hold Bybit keys. See [ci.md](../ci.md).

The process reconnects with exponential backoff and keeps WAL-mode SQLite updated for local readers.
