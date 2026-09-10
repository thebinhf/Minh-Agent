# Minh (明)

[![CI](https://github.com/thebinhf/Minh-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/thebinhf/Minh-Agent/actions/workflows/ci.yml)

24/7 **paper** PA + Supply/Demand engine. One Bun process: public Bybit linear cache + simulated ledger.

**No API keys. No live orders. No paper→live.**

## Loop

```text
4H close
  → dump GET /map
  → copy GET /zones into paper ledger   (MAP_ACCEPT=0 off)
  → tick waits for last in proximal → entry
  → rest post-only GTC + OCO            (PAPER_PROXIMITY_ARM=0 off)
  → fill at limit  |  invalidate if last prints through SL first
  → SL / TP on the open position
```

Quiet between two 4H candles. No 30-minute scan. `/confirm` is optional scalp, not required to hold the zone.

Override a card: `bun run paper zone reject ZONEID`. Review: `bun run paper week`.

## Process

```text
src/index.ts
  src/feed/bb     :43180   public WS → SQLite → GET /map /zones /health …
  src/zones                zone-card schema + HTF suggest (no paper writes)
  src/paper       :43181   ledger, OCO limits, tick, metrics
```

Feed never imports paper. The composition root injects the paper desk into `/brief-pack` and runs MAP-accept on 4H close.

| Bind | Role |
| --- | --- |
| `127.0.0.1:43180` | Read-only market cache |
| `127.0.0.1:43181` | Paper broker |

Default watchlist (10): BTC ETH SOL ENA BNB XRP DOGE AVAX LINK HYPE.

## Layout

| Path | Purpose |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Composition root |
| [`src/feed/bb/`](src/feed/bb/) | Bybit public WS, SQLite, HTTP |
| [`src/zones/`](src/zones/) | Zone-card v1 + HTF detector + proximity math |
| [`src/paper/`](src/paper/) | Paper ledger, arm, tick, replay |
| [`deploy/`](deploy/) | systemd unit + `pull-restart.sh` |
| [`docs/operator.md`](docs/operator.md) | MAP / ARM / EVENT playbook |

## Quick start

```bash
bun install
bun test
bun run start                 # feed :43180 + paper :43181
bun run map                   # HTF watchlist + klineLag
bun run zones                 # suggest-only cards (does not arm)
bun run paper event           # pending OCO + alerts + accepted zones
bun run paper week            # 7-day funnel
```

Daemon (host): `deploy/bybit-tracker.service` (`Restart=always`). After a green merge: `deploy/pull-restart.sh`.

## HTTP

**Feed** `:43180`

| Route | Use |
| --- | --- |
| `GET /map` | HTF MAP (ticker + 20×4H + 24×1H + D) + `klineLag` |
| `GET /map-latest` | Last 1H/4H dump (`404` until first close) |
| `GET /zones` | Suggest-only zone-cards (4H default, `?interval=60`) |
| `GET /confirm` | Optional LTF (20×15m, scalp `5`) |
| `GET /brief-pack` | Tickers + lag + `gates` + paper desk + accepted zones |
| `GET /health` | WS + kline lag. `gates.tradingAllowed` follows this |
| `GET /brief` `/chart` `/depth` `/heatmap` `/market` | Unchanged snapshots |

**Paper** `:43181`

| Route | Use |
| --- | --- |
| `GET /paper/event` | EVENT desk (OCO pending + alerts + ledger) |
| `GET /paper/week` | 7-day metrics + standing cards |
| `POST /paper/zones` | Accept `{ zoneId }` or a full card |
| `POST /paper/arm` | Manual limit + alert |
| `GET /paper/status` `/paper/metrics` | Desk / funnel |

## Paper CLI

```bash
bun run paper zone accept ZONEID          # or FILE.json
bun run paper zone list
bun run paper zone reject ZONEID
bun run paper arm BTCUSDT --side long --price 117500 \
  --sl 116200 --tp 120800 --tf 240,60,15 --zone-id btc-4h-d-20260908-01
bun run paper event
bun run paper week
bun run paper replay BTCUSDT --from 2026-08-01 --to 2026-08-15 \
  --side long --price 117500 --sl 116200 --tp 120800 --tf 240,60,15
```

Arm = post-only limit + fire-once alert. OCO on: last through SL **before** the limit → `order.invalidated`, no fill. After fill, SL/TP run on the position.

Replay walks local klines (backfill first). Separate `*-replay.sqlite`. Slippage 0.

## Kill switches

| Env | Default | Effect |
| --- | --- | --- |
| `MAP_CLOSE=0` | on | No `map-latest.json` dump |
| `MAP_ACCEPT=0` | on | 4H close does not write the ledger |
| `PAPER_PROXIMITY_ARM=0` | on | Tick does not rest accepted cards |
| `PAPER_NOTIFY=telegram\|webhook` | log | Event-once pings only |

Tight BTC stops at `defaultLeverage=1` skip (`insufficient_margin`). Seed **10x** if you want those cards to rest.

Stale ticker → reject. Stale klines + live ticker → `klineLag.ok=false`, `gates.tradingAllowed=false`, new arm/open/limit reject with `kline_lag`. Open positions stay open.

## Ban

Live keys, `/v5/order`, mid-range entries, timer scans, ICT as a signal, mid-watch PnL.

## Docs

- [docs/operator.md](docs/operator.md) — MAP / ARM / EVENT
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers
- [docs/paper-trading.md](docs/paper-trading.md) — paper spec
- [docs/exchanges/BB.md](docs/exchanges/BB.md) — feed
- [docs/FEATURES.md](docs/FEATURES.md) — inventory
- [docs/ci.md](docs/ci.md) — Actions gate + host restart

## Checks

```bash
bun run ci    # typecheck + test
```

Bun >= 1.4. TypeScript 7.x.
