# Paper trading — MVP spec

**Tóm tắt:** Paper trading là tài khoản ảo (SQLite), risk ~2% equity mỗi lệnh, chỉ mở khi RR ≥ 1:2, fill/mark lấy giá local `127.0.0.1:43180`. Không API key, không lệnh thật. Spec only — chưa implement.

Simulated equity account for Minh. Fills and marks come from the **local** Bybit public cache (`src/feed/bb`), never from Bybit private API. This document is the locked product spec (An + Minh). A later implementation PR must follow it; this PR does not add runtime code, SQLite tables, or scripts.

**Not a trading bot.** No API keys, no private WebSocket topics, no real orders, no auto-live bridge.

## 1. Goals / non-goals

### Goals (MVP)

| Goal | Lock |
| --- | --- |
| Virtual USDT equity in a **paper** SQLite file | Isolated ledger; not the feed cache |
| Position size from risk **~2%** of equity per trade | Minh lock — qty is derived, not free-form |
| Require **RR ≥ 1:2** (reward:risk ≥ 2.0) before open | Reject otherwise |
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

Phase 2 items (funding, multi-TP, daily 1–2tr VND paper reports, multi-symbol niceties) are **mention-only** — see [§9](#9-out-of-scope--phase-2).

## 2. Architecture

Paper is a **future** feature module. It reads prices from the existing feed. It does not live inside `src/feed/bb/`.

```text
src/index.ts                    # composition root (today: feed only)
  → src/feed/bb                 # UNCHANGED
       → public linear WS
       → SQLite market cache    # ticker_latest, klines, …
       → read-only HTTP 127.0.0.1:43180
         GET /brief  GET /tickers  GET /health  …

  → src/paper/                  # FUTURE impl — not in this PR
       → paper SQLite ledger    # paper_* tables only
       → risk engine (2%, RR ≥ 2)
       → CLI  bun run paper …
       → HTTP 127.0.0.1:43181 /paper/*   # separate bind; not feed routes
```

| Piece | Role | Rule |
| --- | --- | --- |
| `src/feed/bb` | Public market data | Read-only cache. Paper may **GET** `:43180` or open the feed DB **readonly**. Paper must not `INSERT`/`UPDATE` feed tables or add routes to `src/feed/bb/http.ts`. |
| `src/paper/` (future) | Simulated broker | Own DB file, own CLI, own HTTP. English identifiers; `paper` in every public name. |
| Composition root | Wire only | A future impl may start paper next to the tracker. It must not fold paper handlers into the feed fetch loop. |

Price I/O for paper:

1. Prefer `GET http://127.0.0.1:43180/tickers?symbol=BTCUSDT` (or `GET /brief?symbol=`).
2. Allowed equivalent: `openDb(BYBIT_DB_PATH, true)` and read `ticker_latest` — same cache the HTTP layer serves.
3. Forbidden: `api.bybit.com` signed routes, private WS, Bybit MCP private tools, any key-bearing client.

If the feed is down or the ticker is stale, **reject** the open/close/mark. Do not invent a price.

## 3. Data model

Spec only. Do not create these tables in this PR. Use a **separate** SQLite file (suggested `PAPER_DB_PATH`, default `data/paper.sqlite`). WAL, `busy_timeout`, same style as the feed DB — different file so a paper bug cannot corrupt market cache.

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
| `risk_pct` | TEXT NOT NULL | `0.02` (Minh lock) |
| `min_rr` | TEXT NOT NULL | `2` (reward / risk) |
| `created_ts` | INTEGER NOT NULL | Unix ms |
| `updated_ts` | INTEGER NOT NULL | Unix ms |

MVP does not deduct cash on open (linear paper, no margin wallet). `equity` is the risk base: `cash + unrealized`. After a close, `cash` moves by realized PnL and `equity` is rewritten.

### `paper_positions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `account_id` | INTEGER NOT NULL | FK → `paper_accounts.id` |
| `symbol` | TEXT NOT NULL | e.g. `BTCUSDT` (feed symbol set) |
| `side` | TEXT NOT NULL | `long` \| `short` |
| `qty` | TEXT NOT NULL | Base size; derived from 2% risk |
| `entry_price` | TEXT NOT NULL | Fill price at open |
| `stop_loss` | TEXT NOT NULL | Required |
| `take_profit` | TEXT NOT NULL | Required; single TP in MVP |
| `risk_quote` | TEXT NOT NULL | `|entry − SL| * qty` (USDT) |
| `reward_quote` | TEXT NOT NULL | `|TP − entry| * qty` (USDT) |
| `rr` | TEXT NOT NULL | `reward_quote / risk_quote` |
| `status` | TEXT NOT NULL | `open` \| `closed` |
| `opened_ts` | INTEGER NOT NULL | |
| `closed_ts` | INTEGER | |
| `close_price` | TEXT | |
| `close_reason` | TEXT | `sl` \| `tp` \| `manual` |
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
| `source` | TEXT NOT NULL | `last` \| `sl` \| `tp` |
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

Do **not** reuse feed table names (`ticker_latest`, `klines`, …). Do **not** put `paper_*` tables in the feed database file.

## 4. Fill model

| Event | Price | Fallback |
| --- | --- | --- |
| Open fill | Ticker **`lastPrice`** | None — reject if missing |
| Manual close fill | Ticker **`lastPrice`** | None — reject if missing |
| SL / TP trigger fill | The **level** (`stop_loss` or `take_profit`) | Triggered when `lastPrice` crosses the level; fill at the level (0 slippage) |
| Mark-to-market | Ticker **`markPrice`**, else **`lastPrice`** | Reject mark if both missing |

**Mid** `(bid1Price + ask1Price) / 2` is **not** used in MVP. Do not blend last/mark/mid.

**Slippage = 0** unless a later spec says otherwise. No spread, no latency model, no partial fills. Qty is all-or-nothing.

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

No funding, fees, or leverage in MVP. `risk_quote` at open must be `≤ equity * 0.02` (tolerance: 1e-8 relative, TEXT math via decimal or integer micros — pick one in the impl PR and test it).

**SL / TP evaluation** (on `paper mark` or immediately after a price read):

| Side | SL hit | TP hit |
| --- | --- | --- |
| `long` | `lastPrice <= stop_loss` | `lastPrice >= take_profit` |
| `short` | `lastPrice >= stop_loss` | `lastPrice <= take_profit` |

If both could hit in one print (gap), **SL wins**. Close the row, write `paper_fills.kind = close`, update cash/equity.

Mark and SL/TP checks are **on demand** (CLI/HTTP). No background notifier, no mid-watch messages.

## 5. Risk engine

Locks: **~2% equity risk per trade**, **RR ≥ 1:2**.

### Inputs

Client sends `symbol`, `side`, `stop_loss`, `take_profit`. Optional `note`. **Do not take `qty` from the client** in MVP — size is computed.

`entry` = current fill price (`lastPrice`). `equity` = `paper_accounts.equity` after a mark of existing opens (or cash if no opens).

### Size

```text
risk_pct      = 0.02
risk_budget   = equity * risk_pct
stop_dist     = abs(entry − stop_loss)
qty           = risk_budget / stop_dist
risk_quote    = stop_dist * qty          # == risk_budget
reward_dist   = abs(take_profit − entry)
reward_quote  = reward_dist * qty
rr            = reward_dist / stop_dist  # == reward_quote / risk_quote
```

### Gates (reject open if any fail)

| Gate | Condition |
| --- | --- |
| Side | `side` is `long` or `short` |
| Symbol | In the feed symbol set (same list as `src/feed/bb` config) |
| Fresh price | Fill-model stale checks pass |
| SL side | `long` ⇒ `stop_loss < entry`; `short` ⇒ `stop_loss > entry` |
| TP side | `long` ⇒ `take_profit > entry`; `short` ⇒ `take_profit < entry` |
| Stop distance | `stop_dist > 0` |
| RR | `rr >= 2` |
| Risk | `risk_quote <= equity * 0.02` (true by construction if qty is derived) |
| Flat symbol | No other `open` position on that `symbol` |
| Equity | `equity > 0` |

`rr` is reward÷risk. **1:2** means reward is at least twice risk (`>= 2.0`). Values such as 1.99 reject. There is no “close enough” override and no `--force`.

Reject body (CLI + HTTP) must name the failed gate (`rr`, `stale`, `sl_side`, `duplicate_symbol`, …). Do not open a position and “fix it later”.

## 6. CLI commands + HTTP routes

Future impl only. **Do not** add these scripts or routes in this PR. **Do not** attach `/paper` onto `src/feed/bb/http.ts`.

Suggested script (later): `"paper": "bun run src/paper/cli.ts"` — not added now.

Bind paper HTTP on **`127.0.0.1:43181`** (env `PAPER_HTTP_HOST` / `PAPER_HTTP_PORT`). Feed stays `127.0.0.1:43180`. Auth: none (localhost). JSON `content-type: application/json`.

### CLI

```text
bun run paper account
bun run paper positions [--status open|closed|all]
bun run paper open SYMBOL --side long|short --sl PRICE --tp PRICE [--note TEXT]
bun run paper close ID
bun run paper mark
```

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
  "riskPct": "0.02",
  "minRr": "2",
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
  "note": "optional"
}
```

Success `201`:

```json
{
  "mode": "paper",
  "position": {
    "id": 1,
    "symbol": "BTCUSDT",
    "side": "long",
    "qty": "0.00333333",
    "entryPrice": "63000",
    "stopLoss": "60000",
    "takeProfit": "66000",
    "riskQuote": "200",
    "rewardQuote": "400",
    "rr": "2",
    "status": "open",
    "openedTs": 0,
    "fillSource": "last",
    "fillRecvTs": 0,
    "unrealizedPnl": "0"
  }
}
```

Reject `400`:

```json
{
  "mode": "paper",
  "error": "rr_below_min",
  "gate": "rr",
  "rr": "1.5",
  "minRr": "2"
}
```

Other `error` values: `stale_ticker`, `missing_last_price`, `sl_side`, `tp_side`, `duplicate_symbol`, `equity_non_positive`, `unknown_symbol`, `feed_unhealthy`.

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
  "account": { "cash": "10000", "equity": "10010", "unrealizedPnl": "10" },
  "positions": [
    {
      "id": 1,
      "symbol": "BTCUSDT",
      "markPrice": "63300",
      "unrealizedPnl": "10",
      "status": "open"
    }
  ],
  "closed": []
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

| Rule | Detail |
| --- | --- |
| Paper-only naming | Modules `src/paper/`, tables `paper_*`, env `PAPER_*`, HTTP `/paper/*`, JSON `"mode": "paper"`. Logs `[minh:paper]`. |
| No live trading path | None exists today (`src/feed/bb` is public market data). Keep it that way. Do not add `src/trade/`, signed Bybit clients, or a `PAPER_LIVE=1` escape. |
| No shared order code | Paper open/close is ledger math + local last price. It must not call a future live `placeOrder`. Extracting a “broker interface” that live later implements is out of scope and discouraged. |
| No keys | If `BYBIT_API_KEY`, `BYBIT_API_SECRET`, or similar are set, paper **refuses to start** and prints that paper never uses keys. Do not read them “just in case”. |
| Separate DB | `PAPER_DB_PATH` ≠ `BYBIT_DB_PATH`. Paper opens the feed DB readonly or uses HTTP. |
| Separate HTTP | Paper does not add methods to the feed server (today GET-only on `:43180`). |
| No mid-watch spam | No interval bot that posts marks to chat. `paper mark` is pull-only. |
| No auto-live bridge | No command or route that places a Bybit order from a paper id. |

Startup banner (future impl): `paper simulation only — no API keys, no real orders`.

## 8. Acceptance criteria (Duyệt checklist)

Use this list on the **implementation** PR. All items are “not done” until that PR exists.

- [ ] Docs-only files in *this* PR unchanged in spirit; impl lives under `src/paper/` (or equivalent), not `src/feed/bb/`.
- [ ] Feed brief / `:43180` GET routes / WS behavior **unchanged** (PR #5 stays as-is).
- [ ] Separate `paper_*.sqlite` (or `PAPER_DB_PATH`) with the tables in [§3](#3-data-model). No paper tables in the feed file.
- [ ] Open computes qty from **2%** of equity; client cannot raise risk.
- [ ] Open with `rr < 2` is rejected; fixture/test proves it.
- [ ] Open without SL or TP is rejected.
- [ ] SL/TP on the wrong side of entry is rejected.
- [ ] Fill price is local `lastPrice` from `:43180` (or readonly `ticker_latest`); tests stub that cache, not Bybit private API.
- [ ] Stale ticker (`recvTs` older than 15s) rejects open/close/mark.
- [ ] `paper mark` updates unrealized PnL from `markPrice` (fallback `lastPrice`) and closes on SL/TP (SL wins on a gap).
- [ ] Manual close realizes PnL into `cash` / `equity`.
- [ ] CLI + HTTP shapes match [§6](#6-cli-commands--http-routes); every success payload includes `"mode": "paper"` (HTTP).
- [ ] No Bybit key usage; process refuses to start if key env vars are present.
- [ ] No private WS, no `/v5/order`, no “promote to live”.
- [ ] No new mid-watch notifier.
- [ ] `bun test` / `bun run typecheck` green; feed tests still pass without paper fixtures leaking into `test/feed/bb/`.
- [ ] README/script names say **paper**, never “live trade”.

## 9. Out of scope / phase 2

Do not implement these in the MVP impl PR. Mentioned so they are not silently invented mid-MVP.

| Item | Notes |
| --- | --- |
| Funding payments | Ticker already has `fundingRate` / `nextFundingTime` on the feed; paper ignores them until phase 2. |
| Fees / slippage > 0 | MVP is zero-fee, zero-slippage. |
| Multi-TP / scale-out | One `take_profit` per position. |
| Partial close / add-to | One shot open, one shot close. |
| Margin / leverage / liq | 1× linear PnL only. |
| Multi-account | Single `minh-paper` row. |
| Rich reports vs daily target | Phase 2: paper PnL vs **1–2 triệu VND / day** target (reports only; still simulated). |
| Extra multi-symbol UX | MVP: one open per symbol, feed universe only. Niceties (baskets, relative size, heatmap) wait. |
| Browser UI | None (same as greenfield Minh). |
| Live trading / copy-trade | Forbidden, not “later”. |

---

**This repository PR is documentation.** Success is the spec file + docs pointers. No Bun runtime change, no schema migration, no `package.json` script.
