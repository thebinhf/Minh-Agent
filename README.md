# Minh (明)

[![CI](https://github.com/thebinhf/Minh-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/thebinhf/Minh-Agent/actions/workflows/ci.yml)

Public Bybit linear market cache and a **paper** PA + Supply/Demand engine. One Bun process. No API keys, no live orders, no paper→live.

## Overview

Minh runs 24/7 on a host:

1. Cache public Bybit linear data in SQLite (`:43180`).
2. On each confirmed 4H close, suggest HTF supply/demand cards and copy them into a paper ledger.
3. When last price enters the proximal band of an accepted card, rest a post-only GTC limit with OCO.
4. Tick fills at the limit, or invalidates if last prints through SL first. Open positions use SL/TP.

Quiet between two 4H candles. `/confirm` is optional scalp, not required to hold a zone.

## Features

- Public linear WebSocket + REST gap-fill / backfill (10 symbols)
- Open-interest history (`GET /oi`, on `/map` as quant veto)
- Funding-rate history (`GET /funding`, `/map.funding.crowded` veto)
- HTF MAP (`/map`) and suggest-only zone cards (`/zones`)
- Paper ledger with risk sizing, fees, funding, leverage, OCO limits
- Proximity ARM on accepted cards
- Replay on local klines (separate DB, slippage 0)
- Event-once notify (log / Telegram / webhook)
- systemd host + GitHub Actions typecheck/test

## Architecture

```text
src/index.ts
├── src/feed/bb     :43180   public WS → SQLite → HTTP
├── src/zones                zone-card schema + HTF suggest
└── src/paper       :43181   ledger, OCO, tick, metrics
```

Feed HTTP never imports paper. The composition root injects the paper desk into `/brief-pack` and accepts `/zones` cards on 4H close.

| Path | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Composition root |
| [`src/feed/bb/`](src/feed/bb/) | Bybit public WS, SQLite, HTTP |
| [`src/zones/`](src/zones/) | Zone-card v1, detector, proximity |
| [`src/paper/`](src/paper/) | Paper broker |
| [`deploy/`](deploy/) | systemd unit + `pull-restart.sh` |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- [Bun](https://bun.sh) >= 1.4
- TypeScript 7.x (dev)
- Linux host for the systemd unit (optional)

## Installation

```bash
git clone https://github.com/thebinhf/Minh-Agent.git
cd Minh-Agent
bun install
bun run ci
```

## Configuration

Defaults live in [`src/feed/bb/config.json`](src/feed/bb/config.json) and [`src/paper/config.json`](src/paper/config.json). Override with env.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BYBIT_HTTP_HOST` / `BYBIT_HTTP_PORT` | `127.0.0.1` / `43180` | Feed bind |
| `BYBIT_DB_PATH` | feed SQLite | Market cache |
| `PAPER_HTTP_HOST` / `PAPER_HTTP_PORT` | `127.0.0.1` / `43181` | Paper bind |
| `PAPER_DB_PATH` | paper SQLite | Ledger (must not equal the feed DB) |
| `MAP_CLOSE` | on (`0` disables) | Dump `/map` on 1H/4H close |
| `BYBIT_OI` | on (`0` disables) | REST OI history fill |
| `BYBIT_OI_EXTREME` | `2` | `|deltaPct|` % for `oi.trend` / `oi.reading` |
| `BYBIT_FUNDING` | on (`0` disables) | REST funding history fill |
| `MAP_ACCEPT` | on (`0` disables) | Old 4H auto-copy of `/zones` into the ledger |
| `AGENT_MAP` | on (`0` disables) | MAP policy gate before `acceptZone`. Off = policy no-op; old `MAP_ACCEPT` path still runs |
| `PAPER_PROXIMITY_ARM` | on (`0` disables) | Rest accepted cards in the proximal band |
| `PAPER_NOTIFY` | log | `telegram` or `webhook` for event-once pings |

`BYBIT_API_KEY` / `BYBIT_API_SECRET` (and similar names) are **forbidden**. Paper refuses to start if they are set.

Tight BTC stops at `defaultLeverage=1` skip with `insufficient_margin`. Seed **10x** if those cards should rest.

## Usage

```bash
bun run start                 # feed :43180 + paper :43181
bun run map                   # HTF watchlist + klineLag
bun run zones                 # suggest-only cards (does not arm)
bun run paper event           # pending OCO + alerts + accepted zones
bun run paper week            # 7-day funnel
```

### Feed (`127.0.0.1:43180`)

Full contract: [docs/http.md](docs/http.md).

| Route | Use |
| --- | --- |
| `GET /map` | HTF MAP + `klineLag` (watchlist, cap 10) |
| `GET /map-latest` | Last 1H/4H dump (`404` until first close) |
| `GET /zones` | Suggest-only cards (4H default; `?interval=60`) |
| `GET /oi` | OI history + `trend` (quant veto, not a signal) |
| `GET /funding` | Funding history (quant veto, `crowded`) |
| `GET /confirm` | Optional LTF (20×15m; scalp `5`) |
| `GET /brief-pack` | Tickers + lag + `gates` + paper desk + accepted zones |
| `GET /health` | WS + kline lag |
| `GET /brief` `/chart` `/depth` `/heatmap` `/market` | Snapshots |

Watchlist: BTC ETH SOL ENA BNB XRP DOGE AVAX LINK HYPE.

### Paper (`127.0.0.1:43181`)

```bash
bun run paper zone accept ZONEID          # or FILE.json
bun run paper zone reject ZONEID
bun run paper arm BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --zone-id btc-4h-d-20260908-01
bun run paper event
bun run paper week
bun run paper replay BTCUSDT --from 2026-08-01 --to 2026-08-15 \
  --side long --price 117500 --sl 116200 --tp 120800 --tf 240,60,15
```

`paper arm` = post-only limit + fire-once alert. OCO: last through SL **before** the limit → `order.invalidated`. After fill, SL/TP run on the position.

Replay walks local klines (`bun run backfill` first). Separate `*-replay.sqlite`. Slippage 0.

HTTP: `GET /paper/event`, `GET /paper/week`, `POST /paper/zones`, `POST /paper/arm`, `GET /paper/status`, `GET /paper/metrics`. See [docs/http.md](docs/http.md).

Playbook: [docs/operator.md](docs/operator.md). Spec: [docs/paper-trading.md](docs/paper-trading.md).

## Operations

Host unit: [`deploy/bybit-tracker.service`](deploy/bybit-tracker.service) (`Restart=always`). After a green merge:

```bash
deploy/pull-restart.sh
```

Stale ticker → reject. Stale klines with a live ticker → `klineLag.ok=false`, `gates.tradingAllowed=false`, new open/limit/arm reject with `kline_lag`. Open positions stay open.

## Development

```bash
bun test
bun run typecheck
bun run ci          # typecheck + test
```

CI is GitHub Actions on `main` and PRs (no daemon, no keys). See [docs/ci.md](docs/ci.md).

## Documentation

| Doc | Content |
| --- | --- |
| [docs/http.md](docs/http.md) | HTTP API (`:43180` / `:43181`) |
| [docs/operator.md](docs/operator.md) | MAP / ARM / EVENT |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers |
| [docs/paper-trading.md](docs/paper-trading.md) | Paper spec |
| [docs/exchanges/BB.md](docs/exchanges/BB.md) | Feed |
| [docs/FEATURES.md](docs/FEATURES.md) | Inventory |
| [docs/ci.md](docs/ci.md) | Actions + host restart |

## Non-goals

Live keys, `/v5/order`, paper→live, mid-range entries, timer scans, ICT as a signal, mid-watch PnL, browser UI.
