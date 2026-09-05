# Bybit (BB) — public market cache

Local SQLite cache of Bybit **public linear** market data. Minh can read prices from localhost instead of Bybit MCP (avoids Usage quota). The WebSocket feed also works where Bybit REST is geo-blocked.

**Not a trading bot:** no API keys, no private topics, no order placement.

Adapter path: `src/feed/bb/`.

## Design

| Item | Value |
| --- | --- |
| Runtime | Bun + TypeScript + `bun:sqlite` |
| Endpoint | `wss://stream.bybit.com/v5/public/linear` |
| Symbols | BTCUSDT ETHUSDT SOLUSDT ENAUSDT BNBUSDT XRPUSDT DOGEUSDT AVAXUSDT LINKUSDT |
| Kline intervals | 5, 15, 60, 240 |
| Orderbook | depth 50 for BTC / ETH / SOL |
| Topics | `tickers.{symbol}`, `kline.{interval}.{symbol}`, `orderbook.50.{symbol}` |
| HTTP | read-only `127.0.0.1:43180` |
| Auth | none |

Topic names match Bybit V5 public docs: [connect](https://bybit-exchange.github.io/docs/v5/ws/connect), [ticker](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker), [kline](https://bybit-exchange.github.io/docs/v5/websocket/public/kline), [orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook).

Linear tickers are snapshot-then-delta (missing field = unchanged). Orderbook.50 is snapshot-then-delta; size `0` deletes a level; `u=1` means the book service restarted and the payload replaces the local book. Heartbeat is a client `ping` about every 20s.

## Recovery

| Step | Behavior |
| --- | --- |
| Stale pong | After `watchdogGraceMs` (30s), if no pong for `pongStaleMs` (60s), close the socket so reconnect/backoff runs. |
| Gap-fill | After subscribe succeeds, REST `GET /v5/market/kline` backfills each symbol×interval from `MAX(start_ts)` (or `klinesDays` lookback). Failures are logged; WS stays up. Disable with `BYBIT_GAP_FILL=0`. |
| Orderbook | `books.clear()` on every connect. Deltas are ignored until a snapshot or `u=1`. |
| Retry | Subscribe in chunks of 10 with ack timeout + 3 retries. REST kline uses the same retry helper. |

REST is **best-effort**. In regions where Bybit REST is blocked, the WS cache still runs; kline holes from an outage stay until REST works again.

## Quick start

```bash
bun install
bun test
bun run start
```

HTTP (read-only):

- `GET /health`
- `GET /tickers?symbol=BTCUSDT`
- `GET /orderbooks?symbol=ETHUSDT`
- `GET /klines?symbol=SOLUSDT&interval=15&limit=50`
- `GET /meta`

CLI against the same SQLite file:

```bash
bun run query health
bun run query tickers BTCUSDT
bun run query orderbooks ETHUSDT
bun run query klines SOLUSDT 15 --limit 20
bun run query meta
```

## Config and env overrides

Defaults live in `src/feed/bb/config.json`. Environment variables win when set:

| Env | Maps to |
| --- | --- |
| `BYBIT_CONFIG` | path to config JSON |
| `BYBIT_WS_ENDPOINT` | WebSocket URL |
| `BYBIT_HTTP_HOST` / `BYBIT_HTTP_PORT` | bind address (default `127.0.0.1:43180`) |
| `BYBIT_DB_PATH` | SQLite file |
| `BYBIT_SYMBOLS` | comma-separated symbols |
| `BYBIT_KLINE_INTERVALS` | comma-separated intervals |
| `BYBIT_ORDERBOOK_SYMBOLS` | comma-separated L50 symbols |
| `BYBIT_ORDERBOOK_DEPTH` | book depth |
| `BYBIT_PING_INTERVAL_MS` | heartbeat interval |
| `BYBIT_REST_ENDPOINT` | REST base (`https://api.bybit.com`) |
| `BYBIT_PONG_STALE_MS` | watchdog stale-pong threshold |
| `BYBIT_GAP_FILL` | `0` disables REST kline gap-fill |

SQLite tables: `ticker_latest`, `ticker_snapshots`, `orderbook_latest`, `orderbook_snapshots`, `klines`, `connection_health`, `meta`.

Retention prune drops old snapshot rows and confirmed klines on a timer (`retention` in `config.json`).

## Deploy

Unit file: [`deploy/bybit-tracker.service`](../../deploy/bybit-tracker.service). Copy it to `/etc/systemd/system/`, set `WorkingDirectory` to the Minh Agent checkout (`/opt/minh-agent`), set `BYBIT_DB_PATH`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bybit-tracker
```

The process reconnects with exponential backoff and keeps WAL-mode SQLite updated for local readers.
