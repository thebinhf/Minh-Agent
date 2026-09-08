# Paper trading — MVP spec

**Tóm tắt:** Paper trading là tài khoản ảo (SQLite). Risk **1–10%** equity mỗi lệnh (không hardcode 2%). R:R **không hardcode** — tính từ SL/TP, sàn tối thiểu (nếu có) nằm ở config/account. **Đánh đa khung (MTF)** — mỗi lệnh gắn ≥2 timeframe từ cache local. Fill/mark lấy giá `127.0.0.1:43180`. Phase 2 thêm **fee / funding / multi-TP / leverage** từ account config (không hardcode `0.00055` / `10` trong engine). Không API key, không lệnh thật. Phase **M + 2** — implemented under `src/paper/`.

Simulated equity account for Minh. Fills and marks come from the **local** Bybit public cache (`src/feed/bb`), never from Bybit private API. This document is the locked product spec (An + Minh). Implementation lives under `src/paper/` (phase **M**). Do not add live orders in this module.

**Not a trading bot.** No API keys, no private WebSocket topics, no real orders, no auto-live bridge.

## 1. Goals / non-goals

### Goals (MVP)

| Goal | Lock |
| --- | --- |
| Virtual USDT equity in a **paper** SQLite file | Isolated ledger; not the feed cache |
| Position size from risk **1–10%** of equity per trade | Band lock — qty is derived; **do not hardcode 2%** in source |
| R:R is **not hardcoded** | Derived from SL/TP and stored; optional `min_rr` lives on the account/config, never as a magic `2` in the engine |
| Multi-timeframe (MTF) on every open | Operator must name **≥ 2** feed intervals (đánh đa khung); paper records them and reads local klines |
| Open with stop-loss + take-profit | Both required |
| Close (manual) and mark-to-market PnL | Unrealized on open; realized on close |
| Fill / mark price from local market data | `http://127.0.0.1:43180` ticker / WS cache |
| CLI + HTTP surface for Minh | Shapes below; names stay `paper*` |

### Non-goals (hard ban)

| Ban | Why |
| --- | --- |
| Bybit API keys / env that look like keys | Feed is public-only; paper stays public-only |
| Private WS topics | No account, position, or order streams |
| Real orders (`/v5/order`, any signed REST) | Simulation only |
| Auto-live bridge (paper → live) | No shared path, no “promote” flag |
| Mid-watch spam | No periodic chat/notify while Minh is watching a paper trade |
| Changing `src/feed/bb` HTTP, brief, or WS behavior | PR #5 brief is live; leave it |

Phase 2 (funding, fees, multi-TP, leverage) is locked in [§10](#10-phase-2). Daily 1–2tr VND reports and live orders stay out of scope — see [§9](#9-out-of-scope--later).

## 2. Architecture

Paper is a **future** feature module. It reads prices from the existing feed. It does not live inside `src/feed/bb/`.

```text
src/index.ts                    # composition root (feed + paper)
  → src/feed/bb                 # UNCHANGED
       → public linear WS
       → SQLite market cache    # ticker_latest, klines, …
       → read-only HTTP 127.0.0.1:43180
         GET /brief  GET /tickers  GET /health  …

  → src/paper/                  # phase M impl
       → paper SQLite ledger    # paper_* tables only
       → risk engine (1–10% band, R:R from SL/TP, MTF tags)
       → CLI  bun run paper …
       → HTTP 127.0.0.1:43181 /paper/*   # separate bind; not feed routes
```

| Piece | Role | Rule |
| --- | --- | --- |
| `src/feed/bb` | Public market data | Read-only cache. Paper may **GET** `:43180` or open the feed DB **readonly**. Paper must not `INSERT`/`UPDATE` feed tables or add routes to `src/feed/bb/http.ts`. |
| `src/paper/` | Simulated broker | Own DB file, own CLI, own HTTP. English identifiers; `paper` in every public name. |
| Composition root | Wire only | Starts paper next to the tracker. Must not fold paper handlers into the feed fetch loop. |

Price I/O for paper:

1. Prefer `GET http://127.0.0.1:43180/tickers?symbol=BTCUSDT` (or `GET /brief?symbol=`).
2. MTF context: `GET /brief?symbol=` (15/60/240) and/or `GET /klines?symbol=&interval=` for each tagged timeframe. Same cache, still public-only.
3. Allowed equivalent: `openDb(BYBIT_DB_PATH, true)` and read `ticker_latest` / `klines` — same cache the HTTP layer serves.
4. Forbidden: `api.bybit.com` signed routes, private WS, Bybit MCP private tools, any key-bearing client.

If the feed is down or the ticker is stale, **reject** the open/close/mark. Do not invent a price.

## 3. Data model

Use a **separate** SQLite file (`PAPER_DB_PATH`, default `data/paper.sqlite`). WAL, `busy_timeout`, same style as the feed DB — different file so a paper bug cannot corrupt market cache.

Money and prices are stored as **TEXT** decimal strings (same as `ticker_latest.last_price`), not IEEE floats.

### `paper_accounts`

One row for MVP (`id = 1`, name `minh-paper`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | `CHECK (id = 1)` for MVP |
| `name` | TEXT NOT NULL UNIQUE | `minh-paper` |
| `quote` | TEXT NOT NULL | `USDT` |
| `cash` | TEXT NOT NULL | Realized cash (no open margin lock in MVP) |
| `equity` | TEXT NOT NULL | `cash` + sum of unrealized MTM; refreshed on mark/close |
| `starting_cash` | TEXT NOT NULL | Seed; default `10000` |
| `risk_pct_min` | TEXT NOT NULL | Band floor — default `0.01`. Config, not a source constant. |
| `risk_pct_max` | TEXT NOT NULL | Band cap — default `0.10`. Config, not a source constant. |
| `default_risk_pct` | TEXT NOT NULL | Used when an open omits `riskPct`; must sit inside `[min, max]`. |
| `min_rr` | TEXT | Optional floor (reward / risk). **NULL = no RR gate.** Do not default this to `2` in source. Operator seed in `config.json` is `"2"`. |
| `fee_rate` | TEXT NOT NULL | Taker fee on notional. Product default `0.00055`. Tests may seed `0`. |
| `leverage_min` / `leverage_max` / `default_leverage` | TEXT NOT NULL | Band + default. Product `1` / `25` / `1`. |
| `mm_rate` | TEXT NOT NULL | Maintenance-margin rate for isolated liq. Product default `0.005`. |
| `created_ts` | INTEGER NOT NULL | Unix ms |
| `updated_ts` | INTEGER NOT NULL | Unix ms |

Do **not** subtract initial margin from `cash` (no margin wallet). `available = cash − sum(open margins)`. Open fee leaves `cash` on fill; close credits `pnl − close_fee`. `equity` is still `cash + unrealized`.

### `paper_positions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `account_id` | INTEGER NOT NULL | FK → `paper_accounts.id` |
| `symbol` | TEXT NOT NULL | e.g. `BTCUSDT` (feed symbol set) |
| `side` | TEXT NOT NULL | `long` \| `short` |
| `qty` | TEXT NOT NULL | Base size; derived from this row’s `risk_pct` |
| `risk_pct` | TEXT NOT NULL | This trade’s fraction of equity; must be in account `[risk_pct_min, risk_pct_max]` |
| `entry_price` | TEXT NOT NULL | Fill price at open |
| `stop_loss` | TEXT NOT NULL | Required |
| `take_profit` | TEXT NOT NULL | Furthest TP price (informational; plans live in `take_profits_json`) |
| `risk_quote` | TEXT NOT NULL | `|entry − SL| * qty` (USDT) |
| `reward_quote` | TEXT NOT NULL | `|TP − entry| * qty` (USDT) |
| `rr` | TEXT NOT NULL | Derived `reward_quote / risk_quote` (informational unless `min_rr` is set) |
| `timeframes` | TEXT NOT NULL | JSON array of ≥ 2 feed intervals, e.g. `["240","60","15"]` |
| `mtf_json` | TEXT | Optional snapshot of last local close per tagged TF at open |
| `status` | TEXT NOT NULL | `open` \| `closed` |
| `opened_ts` | INTEGER NOT NULL | |
| `closed_ts` | INTEGER | |
| `close_price` | TEXT | |
| `close_reason` | TEXT | `sl` \| `tp` \| `manual` \| `liq` |
| `leverage` | TEXT NOT NULL | This trade’s leverage |
| `qty_initial` | TEXT NOT NULL | Size at open (multi-TP slices from this) |
| `margin` | TEXT NOT NULL | `qty * entry / leverage` (display + availability) |
| `liq_price` | TEXT NOT NULL | Isolated linear liq from entry, leverage, `mm_rate` |
| `take_profits_json` | TEXT NOT NULL | `[{ price, qtyPct, filled }]` |
| `last_funding_ts` | INTEGER | Last applied `nextFundingTime` |
| `open_fee` / `close_fee` | TEXT NOT NULL | Accumulated fees |
| `realized_pnl` | TEXT | Set on close |
| `unrealized_pnl` | TEXT | Last mark; `0` when closed |
| `mark_price` | TEXT | Last mark used |
| `fill_source` | TEXT NOT NULL | `last` (MVP fill) |
| `fill_recv_ts` | INTEGER NOT NULL | Ticker `recvTs` at fill |
| `note` | TEXT | Optional operator note |

**MVP constraint:** at most **one `open` row per `symbol`**. A second open on the same symbol is rejected.

Index: `idx_paper_positions_status_symbol` on `(status, symbol)`.

### `paper_fills`

Append-only fill log (open and close). One row per execution.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `position_id` | INTEGER NOT NULL | |
| `account_id` | INTEGER NOT NULL | |
| `kind` | TEXT NOT NULL | `open` \| `close` |
| `symbol` | TEXT NOT NULL | |
| `side` | TEXT NOT NULL | Position side |
| `qty` | TEXT NOT NULL | |
| `price` | TEXT NOT NULL | Executed price |
| `source` | TEXT NOT NULL | `last` \| `sl` \| `tp` \| `liq` |
| `recv_ts` | INTEGER | Feed ticker `recvTs` |
| `ts` | INTEGER NOT NULL | Local time |

### `paper_marks`

Optional history of mark-to-market snapshots. MVP may keep only the latest values on `paper_positions` + `paper_accounts.equity` and still satisfy acceptance if `GET /paper/account` returns current MTM. If implemented:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `account_id` | INTEGER NOT NULL | |
| `ts` | INTEGER NOT NULL | |
| `equity` | TEXT NOT NULL | |
| `cash` | TEXT NOT NULL | |
| `unrealized_pnl` | TEXT NOT NULL | Sum across open positions |
| `payload_json` | TEXT | Per-position marks |

### `paper_funding`

Append-only funding settlements (Phase 2). One row per applied `nextFundingTime` per position.

| Column | Type | Notes |
| --- | --- | --- |
| `position_id` / `account_id` | INTEGER NOT NULL | |
| `qty` / `mark_price` / `rate` / `amount` | TEXT NOT NULL | `amount` is signed cash credit |
| `funding_time` | INTEGER NOT NULL | Feed `nextFundingTime` that settled |
| `ts` | INTEGER NOT NULL | Local apply time |

Do **not** reuse feed table names (`ticker_latest`, `klines`, …). Do **not** put `paper_*` tables in the feed database file.

## 4. Fill model

| Event | Price | Fallback |
| --- | --- | --- |
| Open fill | Ticker **`lastPrice`** | None — reject if missing |
| Manual close fill | Ticker **`lastPrice`** | None — reject if missing |
| SL / TP trigger fill | The **level** (`stop_loss` or `take_profit`) | Triggered when `lastPrice` crosses the level; fill at the level (0 slippage) |
| Mark-to-market | Ticker **`markPrice`**, else **`lastPrice`** | Reject mark if both missing |

**Mid** `(bid1Price + ask1Price) / 2` is **not** used in MVP. Do not blend last/mark/mid.

**Slippage = 0.** No spread, no latency model. Multi-TP is the only partial fill: each slice is `qty_initial * qtyPct` (last unfilled TP takes the remainder).

**Stale / missing data**

- Read `GET /tickers?symbol=` or `GET /brief?symbol=` (same cache).
- Require `recvTs` (brief: `ticker.recvTs`) within **15_000 ms** of now — same freshness window as feed `GET /health` `ok`.
- If `/health` is reachable and `ok === false`, reject mutating calls (open/close/mark).
- Unknown symbol or empty ticker → reject (do not 200 with a fake fill).

**PnL (linear USDT, 1× notion for MVP)**

```text
long:  pnl = (exit − entry) * qty
short: pnl = (entry − exit) * qty
```

`risk_quote` at open must be `≤ equity * risk_pct` for **that** trade’s `risk_pct` (tolerance: 1e-8 relative, TEXT math via `src/paper/decimal.ts`). `risk_pct` itself must be inside the account 1–10% band (values from config, not literals in the engine). Fees, funding, and leverage are Phase 2 — see [§10](#10-phase-2). They read rates from the account row; do not invent `0.00055` / `10` in the engine.

**SL / TP evaluation** (on `paper mark` or immediately after a price read):

| Side | SL hit | TP hit |
| --- | --- | --- |
| `long` | `lastPrice <= stop_loss` | `lastPrice >= take_profit` |
| `short` | `lastPrice >= stop_loss` | `lastPrice <= take_profit` |

If both could hit in one print (gap), **SL wins**. Close the row, write `paper_fills.kind = close`, update cash/equity.

Mark order (Phase 2): **funding → SL → liq (only if leverage > 1) → unfilled TPs nearest-first → MTM**.

Mark and SL/TP checks run on `paper mark` / `POST /paper/mark` **and** on the daemon tick loop (Phase 3). Tick emits **events once** when state changes (alert fired, limit filled, SL/TP/liq). It does **not** post periodic PnL. Mid-watch chat spam stays banned.

## 5. Risk engine

Locks: risk **varies 1–10% per trade**; **do not hardcode** `0.02` or R:R `2` in source. Read the band (and optional `min_rr`) from `paper_accounts` / paper config. Every open is **multi-timeframe**.

### Inputs

Client sends `symbol`, `side`, `stop_loss`, `take_profit` **or** `takeProfits`, `timeframes` (≥ 2 intervals). Optional `riskPct` (else `default_risk_pct`), optional `leverage` (else `default_leverage`), optional `note`. **Do not take `qty` from the client** — size is computed from risk.

`entry` = current fill price (`lastPrice`). `equity` = `paper_accounts.equity` after a mark of existing opens (or cash if no opens).

Allowed intervals are the feed set (`src/feed/bb` config: today `5`, `15`, `60`, `240`). Suggested MTF stack matches the snapshot brief: **240 + 60 + 15** (HTF bias → LTF trigger). Two frames is the minimum (e.g. `60` + `15`).

### Size

```text
risk_pct      = request.riskPct ?? account.default_risk_pct
# must satisfy account.risk_pct_min <= risk_pct <= account.risk_pct_max
# defaults for those three columns: 0.01 / 0.10 / 0.02 — loaded from DB/config
risk_budget   = equity * risk_pct
stop_dist     = abs(entry − stop_loss)
qty           = risk_budget / stop_dist
risk_quote    = stop_dist * qty          # == risk_budget
reward_dist   = abs(take_profit − entry)
reward_quote  = reward_dist * qty
rr            = reward_dist / stop_dist  # stored; gated only if min_rr is set
```

Impl must not write `const RISK_PCT = 0.02` or `const MIN_RR = 2`. Tests should pass with a **3%** open and with `min_rr` unset.

### Gates (reject open if any fail)

| Gate | Condition |
| --- | --- |
| Side | `side` is `long` or `short` |
| Symbol | In the feed symbol set (same list as `src/feed/bb` config) |
| Fresh price | Fill-model stale checks pass |
| SL side | `long` ⇒ `stop_loss < entry`; `short` ⇒ `stop_loss > entry` |
| TP side | `long` ⇒ `take_profit > entry`; `short` ⇒ `take_profit < entry` |
| Stop distance | `stop_dist > 0` |
| Risk band | `risk_pct_min <= risk_pct <= risk_pct_max` (default band 0.01–0.10) |
| Risk quote | `risk_quote <= equity * risk_pct` (true by construction if qty is derived) |
| RR | **Only if** `account.min_rr` is non-null: `rr >= min_rr`. No implicit 1:2. |
| MTF | `timeframes` has ≥ 2 unique feed intervals; each has at least one local kline |
| Flat symbol | No other `open` position on that `symbol` |
| Equity | `equity > 0` |

`rr` is reward÷risk, recorded on the position so Minh can review it. There is no hardcoded 1:2 reject. If an operator later sets `min_rr` on the account, that value is the floor — still not a compile-time constant.

Reject body (CLI + HTTP) must name the failed gate (`risk_pct`, `mtf`, `stale`, `sl_side`, `duplicate_symbol`, `rr` when configured, …). Do not open a position and “fix it later”.

### Multi-timeframe (đánh đa khung)

Paper is not a PA engine. It **does not** invent entries from klines. It does require Minh to declare the frames used and to prove those candles exist locally:

1. Persist `timeframes` on the position (order is HTF → LTF).
2. Read each interval from `:43180` (`/brief` for 15/60/240, `/klines` for others such as `5`).
3. Optionally store last close / `start_ts` / `confirm` per TF in `mtf_json` at open.
4. Reject `mtf_incomplete` if a tagged interval has no rows (do not call Bybit REST from paper).

Changing feed brief windows or adding intervals is **out of scope** for paper. Use what `:43180` already serves.

## 6. CLI commands + HTTP routes

Implemented under `src/paper/`. **Do not** attach `/paper` onto `src/feed/bb/http.ts`.

Script: `"paper": "bun run src/paper/cli.ts"`.

Bind paper HTTP on **`127.0.0.1:43181`** (env `PAPER_HTTP_HOST` / `PAPER_HTTP_PORT`). Feed stays `127.0.0.1:43180`. Auth: none (localhost). JSON `content-type: application/json`.

### CLI

```text
bun run paper account
bun run paper positions [--status open|closed|all]
bun run paper open SYMBOL --side long|short --sl PRICE --tp PRICE \
  --tf 240,60,15 [--risk-pct 0.03] [--note TEXT] [--leverage 10]
bun run paper open SYMBOL --side long --sl PRICE --tps PRICE:PCT,PRICE:PCT \
  --tf 240,60,15 [--leverage 10]
bun run paper close ID
bun run paper mark
```

`--tf` is required (comma-separated, ≥ 2). `--tp` or `--tps` is required (`--tps` pairs must sum to 1). `--risk-pct` / `--leverage` are optional (account defaults).

`--help` / `-h` prints usage and the paper-only warning. Exit `2` on usage errors; exit `1` on reject/stale; exit `0` and print JSON on success (same pretty-print habit as `bun run brief`).

### HTTP

| Method | Path | Action |
| --- | --- | --- |
| `GET` | `/paper/health` | Paper process + feed freshness |
| `GET` | `/paper/account` | Account + equity |
| `GET` | `/paper/positions?status=open` | Positions |
| `POST` | `/paper/positions` | Open |
| `POST` | `/paper/positions/:id/close` | Manual close |
| `POST` | `/paper/mark` | MTM + SL/TP check |

`GET` on mutating paths → `405`. Unknown path → `404` `{ "error": "not found" }`.

#### `GET /paper/health`

```json
{
  "ok": true,
  "mode": "paper",
  "feed": { "url": "http://127.0.0.1:43180/health", "ok": true },
  "account": "minh-paper"
}
```

`ok` is false if the paper DB is missing or the feed health check fails. Never reports a live/trading mode.

#### `GET /paper/account`

```json
{
  "mode": "paper",
  "id": 1,
  "name": "minh-paper",
  "quote": "USDT",
  "cash": "10000",
  "equity": "10000",
  "unrealizedPnl": "0",
  "startingCash": "10000",
  "riskPctMin": "0.01",
  "riskPctMax": "0.10",
  "defaultRiskPct": "0.02",
  "minRr": "2",
  "feeRate": "0.00055",
  "leverageMin": "1",
  "leverageMax": "25",
  "defaultLeverage": "1",
  "mmRate": "0.005",
  "marginMode": "isolated",
  "marginUsed": "0",
  "marginBalance": "10000",
  "totalMm": "0",
  "availableCash": "10000",
  "openPositions": 0,
  "updatedTs": 0
}
```

#### `POST /paper/positions`

Request:

```json
{
  "symbol": "BTCUSDT",
  "side": "long",
  "stopLoss": "60000",
  "takeProfit": "66000",
  "riskPct": "0.03",
  "leverage": "10",
  "takeProfits": [
    { "price": "64500", "qtyPct": "0.5" },
    { "price": "66000", "qtyPct": "0.5" }
  ],
  "timeframes": ["240", "60", "15"],
  "note": "optional"
}
```

`riskPct` omitted → `defaultRiskPct`. `leverage` omitted → `defaultLeverage`. `takeProfits` omitted → single `takeProfit` at 100%. `timeframes` required.

Success `201`:

```json
{
  "mode": "paper",
  "position": {
    "id": 1,
    "symbol": "BTCUSDT",
    "side": "long",
    "qty": "0.005",
    "riskPct": "0.03",
    "entryPrice": "63000",
    "stopLoss": "60000",
    "takeProfit": "66000",
    "riskQuote": "300",
    "rewardQuote": "300",
    "rr": "1",
    "timeframes": ["240", "60", "15"],
    "status": "open",
    "openedTs": 0,
    "fillSource": "last",
    "fillRecvTs": 0,
    "unrealizedPnl": "0"
  }
}
```

(`rr` is stored even when below 2 — no hardcoded reject unless `minRr` is set on the account.)

Reject `400`:

```json
{
  "mode": "paper",
  "error": "risk_pct_out_of_band",
  "gate": "risk_pct",
  "riskPct": "0.15",
  "riskPctMin": "0.01",
  "riskPctMax": "0.10"
}
```

Other `error` values: `stale_ticker`, `missing_last_price`, `sl_side`, `tp_side`, `duplicate_symbol`, `equity_non_positive`, `unknown_symbol`, `feed_unhealthy`, `mtf_required`, `mtf_incomplete`, `rr_below_min` (only when `minRr` is set), `leverage_out_of_band`, `insufficient_margin`, `tp_qty_pct_sum`, `unknown_instrument`, `min_order_qty`, `max_order_qty`, `min_notional`, `price_filter`.

#### `POST /paper/positions/:id/close`

```json
{
  "mode": "paper",
  "position": {
    "id": 1,
    "status": "closed",
    "closeReason": "manual",
    "closePrice": "64000",
    "realizedPnl": "3.33",
    "closedTs": 0
  },
  "account": { "cash": "10003.33", "equity": "10003.33" }
}
```

Already closed → `409` `{ "mode": "paper", "error": "already_closed" }`.

#### `POST /paper/mark`

```json
{
  "mode": "paper",
  "account": { "cash": "10000", "equity": "10010", "unrealizedPnl": "10", "marginUsed": "630" },
  "positions": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "markPrice": "63300",
      "unrealizedPnl": "10",
      "status": "open"
    }
  ],
  "closed": [],
  "funding": []
}
```

If SL/TP fires, that id appears in `closed` with `closeReason` `sl` or `tp`, and `account.cash` includes realized PnL.

#### `GET /paper/positions`

```json
{
  "mode": "paper",
  "positions": []
}
```

CLI JSON matches these objects (wrapper keys may be omitted when printing a single resource).

## 7. Safety

### Duyệt locked (verbatim)

Do not paraphrase, weaken, or implement around these. They override any later convenience in an impl PR.

1. Spec tách hẳn paper vs live; không import/call private/trading API.
2. Fill chỉ từ `:43180` (mark/last local); cấm endpoint order thật.
3. Env/API key Bybit **không** nằm path paper; bridge live = ticket riêng.
4. CLI/`GET /paper` chỉ đụng SQLite ảo; không ghi sổ thật.
5. Phase S→M ghi rõ; không lén ship L.

| Rule | Detail |
| --- | --- |
| Paper-only naming | Modules `src/paper/`, tables `paper_*`, env `PAPER_*`, HTTP `/paper/*`, JSON `"mode": "paper"`. Logs `[minh:paper]`. |
| No live trading path | None exists today (`src/feed/bb` is public market data). Keep it that way. Do not add `src/trade/`, signed Bybit clients, or a `PAPER_LIVE=1` escape. |
| No shared order code | Paper open/close is ledger math + local last price. It must not call a future live `placeOrder`. Extracting a “broker interface” that live later implements is out of scope and discouraged. |
| No keys | If `BYBIT_API_KEY`, `BYBIT_API_SECRET`, or similar are set, paper **refuses to start** and prints that paper never uses keys. Do not read them “just in case”. |
| Separate DB | `PAPER_DB_PATH` ≠ `BYBIT_DB_PATH`. Paper opens the feed DB readonly or uses HTTP. |
| Separate HTTP | Paper does not add methods to the feed server (today GET-only on `:43180`). |
| No mid-watch spam | No interval bot that posts marks / PnL to chat. Tick may log **events once** (`alert.fired`, `order.filled`, `order.invalidated`, `position.closed`). Optional Telegram/webhook on those same kinds (`PAPER_NOTIFY`). |
| No auto-live bridge | No command or route that places a Bybit order from a paper id. Live bridge is a **separate ticket** (locked item 3). |

Startup banner: `paper simulation only — no API keys, no real orders`.

**Phase S→M (locked item 5):** this document began as **S** (spec). The paper impl is **M** (mô phỏng / paper MVP). **L** (live orders) is not a phase of this work and must not ship inside an S or M PR.

## 8. Acceptance criteria (Duyệt checklist)

Use this list on the implementation PR (phase **M**).

**Duyệt locked (verbatim — same five as [§7](#duyệt-locked-verbatim)):**

- [x] Spec tách hẳn paper vs live; không import/call private/trading API.
- [x] Fill chỉ từ `:43180` (mark/last local); cấm endpoint order thật.
- [x] Env/API key Bybit **không** nằm path paper; bridge live = ticket riêng.
- [x] CLI/`GET /paper` chỉ đụng SQLite ảo; không ghi sổ thật.
- [x] Phase S→M ghi rõ; không lén ship L.

Impl PR must fail review if any of the five is missing or only “almost” true. Additional checks:

- [x] Docs-only files in *this* PR unchanged in spirit; impl lives under `src/paper/` (or equivalent), not `src/feed/bb/`.
- [x] Feed brief / `:43180` GET routes / WS behavior **unchanged** (PR #5 stays as-is).
- [x] Separate `paper_*.sqlite` (or `PAPER_DB_PATH`) with the tables in [§3](#3-data-model). No paper tables in the feed file.
- [x] Open computes qty from the **requested** `riskPct` (or account default); client cannot pass `qty`.
- [x] `riskPct` outside **1–10%** (account `risk_pct_min`/`max`) is rejected; **1%**, **3%**, and **10%** opens succeed. No `const` `0.02` / `2` in the risk engine.
- [x] R:R is derived and stored; with `min_rr` unset, `rr < 2` still opens. `rr_below_min` only when `min_rr` is configured.
- [x] Open requires ≥ 2 `timeframes`; missing local klines → `mtf_incomplete`. Does not fetch Bybit REST from paper.
- [x] Open without SL or TP is rejected.
- [x] SL/TP on the wrong side of entry is rejected.
- [x] Fill price is local `lastPrice` from `:43180` (or readonly `ticker_latest`); tests stub that cache, not Bybit private API.
- [x] Stale ticker (`recvTs` older than 15s) rejects open/close/mark.
- [x] `paper mark` updates unrealized PnL from `markPrice` (fallback `lastPrice`) and closes on SL/TP (SL wins on a gap).
- [x] Manual close realizes PnL into `cash` / `equity`.
- [x] CLI + HTTP shapes match [§6](#6-cli-commands--http-routes); every success payload includes `"mode": "paper"` (HTTP).
- [x] No Bybit key usage; process refuses to start if key env vars are present.
- [x] No private WS, no `/v5/order`, no “promote to live”.
- [x] No new mid-watch notifier.
- [x] `bun test` / `bun run typecheck` green; feed tests still pass without paper fixtures leaking into `test/feed/bb/`.
- [x] README/script names say **paper**, never “live trade”.

Phase 2 (this PR):

- [x] `fee_rate` / leverage band / `mm_rate` live on the account; no engine magic `0.00055` or `10`.
- [x] Open/close charge `qty * price * fee_rate`; IM is not subtracted from cash.
- [x] `leverage` in band; `insufficient_margin` when `cash < existingIM + newIM + openFee`.
- [x] Isolated liq only when leverage > 1; SL still wins a gap.
- [x] Cross IM/MM use mark; liq when account margin balance ≤ total MM. Isolated default unchanged.
- [x] `takeProfits` percents sum to 1; nearest-first scale-out; last slice takes remainder.
- [x] Funding from ticker `fundingRate` / `nextFundingTime`; once per settlement; long pays when rate > 0.
- [x] Qty/price/leverage follow Bybit linear `instruments-info` (lot, tick, min notional, market max). Isolated liq uses the UTA formula. No `/v5/order`.
- [x] Live orders still forbidden.

## 9. Out of scope / later

Do not silently invent these. Funding / fees / multi-TP / leverage shipped in [§10](#10-phase-2).

| Item | Notes |
| --- | --- |
| Slippage > 0 | Still zero-slippage. Fees are not slippage. |
| Add-to / scale-in | Multi-TP is scale-**out** only. No add-to an open row. |
| Multi-account | Single `minh-paper` row. |
| Rich reports vs daily target | Paper PnL vs **1–2 triệu VND / day** (reports only; still simulated). |
| Extra multi-symbol UX | One open per symbol, feed universe only. |
| MTF strategy / auto signals | Paper only **tags** TFs and snapshots local closes. |
| Browser UI | None (same as greenfield Minh). |
| Live trading / copy-trade | Forbidden, not “later”. |

## 10. Phase 2

Locked for this PR. All rates come from `paper_accounts` / `src/paper/config.json`. Tests seed `feeRate: "0"` so MVP cash assertions stay `10000` after a zero-fee open.

### Risk band (1–10%)

Operator may raise or lower `riskPct` per trade inside **1–10%** of equity (`0.01`–`0.10`). Product default when omitted remains `0.02`. Existing ledgers pick up the new band from config on open. A 10% request can still fail `insufficient_margin` at 1× if IM does not fit — raise leverage or widen the stop; do not invent qty.

### Fees

```text
fee = qty * price * fee_rate
open:  cash -= open_fee
close: cash += pnl - close_fee   # each slice
```

Risk band is still `|entry − SL| * qty`. Fees sit **outside** that budget.

### Leverage / isolated liq

`qty` is still from risk, then **floored to the venue lot**. Margin is display + availability only — **do not subtract IM from cash**.

```text
margin    = qty * entry / leverage
            + qty * entry * (1 ± 1/leverage) * fee_rate   # Bybit isolated IM
available = cash - sum(open margins)
reject insufficient_margin if cash < existingIM + newIM + openFee

# Bybit UTA isolated USDT (no extra margin, no MM deduction)
liq long  = [entry*qty − entry*qty/lev] / [qty − qty*mm_rate]
liq short = [entry*qty + entry*qty/lev] / [qty + qty*mm_rate]
# stored liq is snapped to tickSize; skipped when leverage = 1
```

Liq is evaluated only when `leverage > 1` (1× keeps MVP behavior). Product band `1–25`, default `1`, then floored to the instrument `leverageStep`. Reject `leverage_out_of_band` outside the account **or** instrument band.

### Cross (account)

Account `marginMode` is `isolated` (default) or `cross`. Isolated keeps per-position liq. Cross follows Bybit UTA one-way:

```text
IM   = qty * mark / leverage + qty * entry * (1 ± 1/leverage) * fee_rate
MM   = qty * mark * mm_rate  + qty * entry * (1 ± 1/leverage) * fee_rate
MB   = cash + sum(unrealized)          # margin balance
avail = MB − sum(IM)                   # UP&L counts toward new opens
liq when MB <= sum(MM)                 # close remaining opens at mark
```

Estimated per-position cross liq is the mark that would set MB = total MM with other positions held constant (0 if no positive solution — a small long vs a large wallet). Isolated liq price is ignored in cross. SL/TP still fire first.

### Multi-TP

`takeProfits: [{ price, qtyPct, filled? }]`. Percents must sum to 1 (1e-8). Sort long ascending / short descending (nearest first). Each slice is `qtyPct` of **original** qty; the last unfilled TP takes the remainder. Partial close keeps the row `open`. A single `takeProfit` is one plan at 100%.

### Venue (Bybit linear, current)

Paper is still a simulation, but **size / price / position math follow the live venue**. Current adapter: Bybit USDT perpetual, isolated **or** cross, one-way. Specs live in `src/paper/instruments/bybit-linear.json` (public `instruments-info` snapshot). Paper does **not** call Bybit REST or `/v5/order`.

| Rule | Bybit linear behavior |
| --- | --- |
| Open | Market in base-coin qty at local `lastPrice` (already on tick) |
| Close | Reduce-only market (manual) or stop-market at SL / TP / liq |
| Qty | Floor computed risk qty to `qtyStep`; reject `< minOrderQty`, `> maxMktOrderQty`, or notional `< minNotionalValue` |
| Price | Snap SL / TP / liq / last / mark to `tickSize` (UI snap), then re-check side |
| Leverage | Floor to `leverageStep`; cap is `min(account, instrument)` |
| PnL / funding / fees | Linear USDT: `(exit−entry)*qty` long; funding `± qty*mark*rate` |

A later venue is a new adapter file — do not invent a second size model inside the engine.

### Funding

Read ticker `fundingRate` + `nextFundingTime` from `:43180` (already on the feed). On mark, if `now >= nextFundingTime` and `last_funding_ts !== nextFundingTime`:

```text
amount = ± qty * mark * rate   # long pays when rate > 0
cash  += amount
```

Write `paper_funding` and set `last_funding_ts`. Apply once per settlement.

### Still banned

No API keys, no `/v5/order`, no paper→live bridge, no changes to feed WS/brief behavior.

---

**Phase M + 2 + 3.** Success is `src/paper/` + `bun run paper` + `127.0.0.1:43181/paper/*` matching this spec. Live orders are still forbidden.

## 11. Phase 3 — alerts, limit pending, tick

Locked. Paper stays simulated. No keys, no `/v5/order`, no paper→live, no feed WS/brief changes, no browser UI, no Telegram.

Event-once is **not** mid-watch spam. A tick that prints nothing is the correct idle behavior.

### 11.1 Tick loop

When the daemon starts (`bun run start` → `startPaper`), paper evaluates every `tickMs` (default `400`, env `PAPER_TICK_MS`). CLI one-shots do **not** tick; they persist into the same SQLite file the daemon reads.

Each tick, in order:

1. Fire armed **alerts** whose last print is through the level.
2. **OCO-invalidate** pending limits whose last print is through `--invalidate` / `--sl`.
3. Fill remaining **pending limit** orders whose last print is through the limit; fill **at the limit** (0 slippage).
4. Mark open positions (funding → SL → liq → TP → MTM). Newly filled positions are included so a gap can SL in the same tick.

`POST /paper/mark` / `bun run paper mark` runs the same `evaluate()`. Feed unhealthy → explicit mark still rejects; the daemon tick swallows `PaperReject` and waits.

Tickers are batched (`GET /tickers`) then filled in per-symbol. A stale symbol is skipped; other symbols still evaluate.

### 11.2 Alerts

Table `paper_alerts` in the paper DB (not the feed file).

| Field | Lock |
| --- | --- |
| `symbol` | Feed universe |
| `op` | `above` \| `below` |
| `price` | Snapped to `tickSize` |
| `status` | `armed` \| `fired` \| `cancelled` |
| `once` | Always true in this phase — fire once, then `fired` |
| `channel` | `log` only (stdout `[minh:paper] alert.fired` + `paper_events`) |

Hit: `above` ⇒ `last >= price`; `below` ⇒ `last <= price`. Equal counts. Stale ticker does not fire.

Duplicate armed `(symbol, op, price)` → `duplicate_alert`. If last is already through on submit, the row is inserted then immediately `fired` (event includes `immediate: true`).

```text
bun run paper alert set BTCUSDT --above 118000
bun run paper alert set ETHUSDT --below 4200 --note "HTF demand"
bun run paper alert list
bun run paper alert cancel ID
```

| Method | Path |
| --- | --- |
| `GET` | `/paper/alerts?status=armed` |
| `POST` | `/paper/alerts` `{ symbol, op, price, note? }` |
| `POST` | `/paper/alerts/:id/cancel` |

### 11.3 Limit pending (vị thế trước)

Do **not** store pending in `paper_positions`. A position exists only after fill. Table `paper_orders`.

| Field | Lock |
| --- | --- |
| `type` | `limit` |
| `tif` | `gtc` |
| `post_only` | Default **true**. Long must rest `limit < last`; short `limit > last`. At-or-through last → `limit_crossed` (does not take liquidity). |
| `--cross` / `postOnly: false` | Allow immediate fill if last is already through |
| `oco` | Default **true**. Pending dies if last prints through invalidation **before** fill. Same-print gap: invalidation wins (do not fill-then-SL). |
| `--invalidate PRICE` | Optional. Default = `--sl`. Must sit on the stop side of the limit. |
| `--no-oco` / `oco: false` | Rest even if structure prints through. |
| `status` | `pending` \| `filled` \| `cancelled` \| `rejected` \| `invalidated` |
| `qty` | **Locked at submit** from risk % using **limit price** as entry |
| SL / TP / MTF | Same gates as market open, evaluated against **limit**, not last |

Fill (0 slippage):

| Side | Fill when | Price |
| --- | --- | --- |
| long | `lastPrice <= limit` | the limit |
| short | `lastPrice >= limit` | the limit |

On fill: insert `paper_positions` with `fill_source = limit`, charge **maker** fee (`account.maker_fee_rate`, product default `0.0002`), re-check margin. If margin fails at fill → `rejected` + `order.rejected`, no position.

`duplicate_symbol` covers **open position or pending order** on that symbol.

`bun run paper open` stays market (`fill_source = last`, taker `fee_rate`). Limit is a new path.

```text
bun run paper limit BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --risk-pct 0.02
# optional tighter invalidation: --invalidate 116800
# disable OCO: --no-oco
bun run paper orders
bun run paper cancel ID
```

| Method | Path |
| --- | --- |
| `GET` | `/paper/orders?status=pending` |
| `POST` | `/paper/orders` `{ symbol, side, limitPrice, stopLoss, takeProfit, timeframes, postOnly?, oco?, invalidatePrice? }` |
| `POST` | `/paper/orders/:id/cancel` |

### 11.4 Events

Append-only `paper_events`. Kinds: `alert.fired`, `order.filled`, `order.rejected`, `order.cancelled`, `order.invalidated`, `position.closed`.

```text
bun run paper events [--limit 50]
GET /paper/events?limit=50
```

Daemon logs a line only when `evaluate().events.length > 0`.

### 11.5 Still banned

No scale-in. No live orders. No browser UI. No mid-watch PnL spam.

---

## 12. Phase 4 — event notify

Optional extra channel on top of log + `paper_events`. Default remains **log**. Still no mid-watch PnL, no live orders, no Bybit keys.

| Lock | Rule |
| --- | --- |
| Kinds | `alert.fired`, `order.filled`, `order.invalidated`, `position.closed` only |
| Not sent | `order.cancelled`, `order.rejected`, funding, MTM, idle ticks |
| Channel | `log` (default) \| `telegram` \| `webhook` \| `off` |
| Secrets | env only: `PAPER_TELEGRAM_BOT_TOKEN`, `PAPER_TELEGRAM_CHAT_ID`, `PAPER_NOTIFY_URL` |
| Failure | Never block a fill. 4xx → log once, no retry. 5xx / 429 / timeout / network → up to 3 attempts with equal-jitter exponential backoff (400ms × 2ⁿ, cap 4s; honor `Retry-After` / Telegram `retry_after`, still capped). Then log `[minh:paper] notify failed kind=…`. Missing token/URL → warn once, stay log-only. Logs redact bot token and webhook basic-auth. |

```text
PAPER_NOTIFY=telegram
PAPER_TELEGRAM_BOT_TOKEN=…
PAPER_TELEGRAM_CHAT_ID=…
# or
PAPER_NOTIFY=webhook
PAPER_NOTIFY_URL=https://ntfy.sh/minh-paper
```

Telegram is **not** a Bybit key. `assertNoApiKeys` still only refuses `BYBIT_*` key env.
