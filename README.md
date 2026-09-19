# Minh (明)

[![CI](https://github.com/thebinhf/Minh-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/thebinhf/Minh-Agent/actions/workflows/ci.yml)

Public Bybit linear market cache and a **paper** PA engine that runs **autonomous 24/7**. You observe. Feed + paper share one Bun process. Live-shadow is a second process. Exec is a fourth: a read-only testnet skeleton. No live orders, no paper→live.

## You observe

The host loop does not wait for a click:

1. Public Bybit linear WS → SQLite (`:43180`).
2. Confirmed 4H close → HTF cards (S/D, breakout, reversal) → MAP policy → paper ledger.
3. Last in proximal + confirmed 15m with the zone → post-only GTC + OCO.
4. Tick fills at the limit, or invalidates through SL. Open uses SL/TP.

Watch `GET /observe` (feed + tape coverage + live-shadow + paper). Event-once notify (log / Telegram / webhook). `PAPER_OBSERVE=1` on the host unit blocks POST arm/open. Kill switch: `PAPER_OBSERVE=0` via `systemctl edit`.

```text
deploy/enable-mesh.sh
# tracker + live-shadow + nightly lab
# then GET http://127.0.0.1:43180/observe
```

## Features

- Public linear WebSocket + REST gap-fill / backfill (10 symbols)
- Open-interest history (`GET /oi`, on `/map` as quant veto)
- Funding-rate history (`GET /funding`, `/map.funding.crowded` veto)
- Taker CVD (`GET /flow`, `/map.flow` buy_dom/sell_dom; accept-only veto)
- Liquidation prints heatmap (`GET /liq-heatmap`, `/map.liq`)
- Estimated liq model (`GET /liq-model`, inventory-capped; not exchange data)
- Local WS relay (`ws://127.0.0.1:43180/ws` — ticker / kline close / liq prints)
- HTF MAP (`/map`) and suggest-only zone cards (`/zones`)
- Paper ledger with risk sizing, fees, funding, leverage, OCO limits
- Proximity ARM on accepted cards
- Replay on local klines (separate DB, slippage 0)
- Event-once notify (log / Telegram / webhook)
- Exec skeleton — testnet read-only (`/exec/health`, wallet, positions, open orders, fees, instrument spec; no order placement)
- systemd host + GitHub Actions typecheck/test

## Architecture

```text
src/index.ts
├── src/feed/bb     :43180   public WS → SQLite → HTTP
├── src/zones                zone-card schema + HTF suggest
├── src/ta                   overlay pack (GET /ta). Does not arm
└── src/paper       :43181   ledger, OCO, tick, metrics

src/live            :43182   MAP/ARM shadow (own sqlite, no orders)
src/exec            :43183   testnet read-only skeleton (own sqlite, keys via credential files)
```

Feed HTTP never imports paper. The composition root injects the paper desk into `/brief-pack` and accepts `/zones` cards on 4H close.

| Path | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Composition root |
| [`src/feed/bb/`](src/feed/bb/) | Bybit public WS, SQLite, HTTP |
| [`src/zones/`](src/zones/) | Zone-card v1, detector, proximity |
| [`src/ta/`](src/ta/) | Overlay pack. Does not arm |
| [`src/paper/`](src/paper/) | Paper broker |
| [`src/live/`](src/live/) | Live-shadow observer |
| [`src/exec/`](src/exec/) | Exec skeleton — testnet, read-only, no order placement |
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
| `LIVE_HTTP_HOST` / `LIVE_HTTP_PORT` | `127.0.0.1` / `43182` | Live-shadow bind (`bun run live`) |
| `LIVE_MAP_POLL_MS` | `30000` | How often the shadow fetches the MAP dump. The ARM tick (`LIVE_TICK_MS`, 400 ms) is separate — a 4H bar cannot arrive faster than the poll, and the watchlist body is ~680 KB |
| `LIVE_DB_PATH` | live-shadow SQLite | Must not equal paper or feed |
| `LIVE_FEED_URL` | `http://127.0.0.1:43180` | Public tape. Does not start a second WS |
| `EXEC_MODE` | (none) | `testnet` or `mainnet`. Exec refuses to start without it; `mainnet` also needs `EXEC_MAINNET_CONFIRM=1` |
| `EXEC_HTTP_HOST` / `EXEC_HTTP_PORT` | `127.0.0.1` / `43183` | Exec bind (`bun run exec`) |
| `EXEC_DB_PATH` | exec SQLite | Must not equal feed, paper or live |
| `EXEC_KEY_FILE` / `EXEC_KEY_SECRET_FILE` | unset | Credential-file key pair. Alternatively systemd `LoadCredential=` → `$CREDENTIALS_DIRECTORY` with `bybit_api_key` / `bybit_api_secret`. Plaintext key env vars refuse start |
| `EXEC_ACCOUNT_TYPE` | `UNIFIED` | Wallet-balance account type (`UNIFIED` / `CONTRACT` / `SPOT` / `FUND`) |
| `EXEC_BASE_URL` | unset | Testnet-only host override. Refused under `EXEC_MODE=mainnet` |
| `EXEC_SPEC_MAX_AGE_HOURS` | `168` | Refresh the linear instrument spec when older; stale is flagged, never silently used |
| `LIVE_SHADOW` | on (`0` disables) | Kill switch for the observer process |
| `LIVE_SHADOW_URL` | unset | Host unit sets `http://127.0.0.1:43182/live/shadow` for `GET /observe`. Unset = `shadow.quality` missing |
| `MAP_CLOSE` | on (`0` disables) | Dump `/map` on 1H/4H close |
| `BYBIT_OI` | on (`0` disables) | REST OI history fill |
| `BYBIT_OI_EXTREME` | `2` | `|deltaPct|` % for `oi.trend` / `oi.reading` |
| `BYBIT_FUNDING` | on (`0` disables) | REST funding history fill |
| `BYBIT_FLOW` | on (`0` disables) | WS `publicTrade` CVD → `/map.flow` |
| `BYBIT_FLOW_EXTREME` | `0.15` | `|imbalance|` floor for `flow.reading` |
| `BYBIT_LIQ` | on (`0` disables) | WS `allLiquidation` prints |
| `BYBIT_TAPE_SYMBOLS` | watchlist | CVD + liq subscribe set. Default = every config symbol. Comma list intersects. `0` = none. Replay does **not** invent history; missing stays null |
| `BYBIT_LIQ_MODEL` | on (`0` disables) | Estimated `/liq-model` |
| `BYBIT_RELAY` | on (`0` disables) | Local `ws://…/ws` push |
| `BYBIT_RELAY_LIQ_MS` | 1000 | Liq relay coalesce; `0` = every batch |
| `MAP_ACCEPT` | on (`0` disables) | Old 4H auto-copy of `/zones` into the ledger |
| `AGENT_MAP` | on (`0` disables) | MAP policy gate before `acceptZone`. Off = policy no-op; old `MAP_ACCEPT` path still runs |
| `AGENT_BIAS_CHOP` | `deny` | 4H mixed chop is a MAP deny (`bias_chop`). `0` = off (A/B). `proximal` = allow only when last is in proximal→entry. 1H chop does not override 4H |
| `AGENT_ZONE_FRESH` | off | `1` = MAP deny when the zone is `touched` or already penetrated (`zone_fresh`). Signal-cleaning filter. Off until a one-flag 180d A/B |
| `AGENT_ZONE_IMPULSE_MIN` | off | Float floor on the departure impulse in ATR. MAP deny below the floor (`zone_impulse`). Unset / `0` / invalid = off. A/B before on |
| `MINH_DECISION_LOG` | off | `1` = log one JSON line per MAP card at 4H close (`[minh:decision]`): inputs (bias, quant tape, family score/RR, freshness, impulse), the verdict, and the reason. Journald captures it; nothing reads it back. Only the exact string `1` turns it on |
| `PAPER_TA_FIB` | off | `arm` = ARM wait unless last is nearest fib 0.5/0.618. Missing fib is not a wait |
| `AGENT_TA_OSC` | off | `accept` = MAP deny when RSI/div opposes the zone. Missing osc is not a veto |
| `PAPER_TA_VOL` | off | `arm` = ARM wait on kline volume climax (rel ≥ 2). Volume 0 stays missing |
| `PAPER_TA_SHOCK` | off | `arm` = ARM wait on 4H `impulse` / `vol_spike`. Quiet/missing pass |
| `PAPER_TA_REV` | off | `arm` = ARM wait unless 15m reversal agrees. Missing reversal is not a wait |
| `PAPER_SETUPS` | `sd,breakout,reversal` | Zone-card families MAP may emit. `0` / `sd` = old S/D-only detector. Does not arm from `GET /ta` |
| `PAPER_PROXIMITY_ARM` | on (`0` disables) | Rest accepted cards in the proximal band |
| `PAPER_CONFIRM_15` | on (`0` disables) | ARM also needs a confirmed 15m close with the zone |
| `PAPER_ZONE_SCORE` | on (`0` disables) | Rank MAP accept by 7-day family paper score when history exists. Sampled families below the floor or `avgRealizedRr ≤ 0` skip (`family_floor`) |
| `PAPER_ZONE_SCORE_RR` | off | `1` = rank MAP/ARM by sampled family `avgRealizedRr` then score then card `rr`. Cold last. **180d A/B: equity −84.7, realizedPnl −160.2 → no gain, stays off** |
| `PAPER_BE_R` | off | Float R multiple. After favorable MFE ≥ N, move SL to entry (`position.managed` / `be`). Unset / `0` / invalid = off. **180d A/B: 0.5R → equity −4 770.6, 1.0R → −520.0; both negative (scratches bought with forfeited winners) → stays off** |
| `PAPER_FAMILY_SCORE_MIN` | `0.5` | Score floor after a sample. Cold / missing history is not a veto |
| `PAPER_FAMILY_FLOOR_MIN_TRADES` | `2` | Closed trades before the RR floor applies. `1` is an A/B. Cold history is still not a veto |
| `PAPER_MAP_SKIP` | (none) | Comma symbols MAP will not auto-accept. Unset / `0` / blank = none. Feed watchlist unchanged |
| `PAPER_ARM_MAX` | `2` | Max symbols with pending/open. Cap ranks ready cards by family score then `rr` then `zoneId` (`PAPER_ZONE_SCORE_RR=1` inserts realized RR first). Occupied slots stay. `0` = unlimited (still one per symbol). 180d: 2 beat 3/5/0 |
| `PAPER_SLIPPAGE` | on (`0` disables) | Taker market / close / `--cross` immediate walk live L50. Resting limit and SL/TP stay 0 |
| `PAPER_NOTIFY` | log | `telegram` or `webhook` for event-once pings (`zone.accepted` / `zone.armed` / fill / OCO / close) |
| `PAPER_OBSERVE` | off (host unit `1`) | `1` = GET-only paper HTTP/CLI. MAP/ARM/EVENT still run. systemd sets this. |

Every flag above is validated at boot (`src/config/runtime-flags.ts`). A value that cannot mean anything — `PAPER_ARM_MAX=abc`, `PAPER_TA_FIB=armed`, `MINH_DECISION_LOG=on` — makes the feed, paper, live-shadow and the paper CLI **refuse to start** and lists each offender, instead of quietly falling back to the default. An operator typo can no longer read as a strategy change.

`BYBIT_API_KEY` / `BYBIT_API_SECRET` (and similar names) are **forbidden**. Paper and live-shadow refuse to start if they are set. Exec refuses them too: its keys come from credential files only.

Tight BTC stops at `defaultLeverage=1` may need more IM than cash. Seed is **10x**; if that IM still does not fit, paper raises leverage to the minimum that fits, capped at `min(account.leverageMax, spec.maxLeverage)` (watchlist max **150**). Existing paper DBs keep their stored `leverage_max` until PATCH.

## Usage

```bash
bun run start                 # feed :43180 + paper :43181
bun run live                  # shadow :43182 (own sqlite, no orders)
bun run exec                  # exec :43183 (testnet, read-only, keys via credential files)
bun run map                   # HTF watchlist + klineLag
bun run zones                 # suggest-only cards (does not arm)
bun run ta                    # overlay pack (22 methods, does not arm)
bun run features scan --days 7  # as-of shock + tape points (does not arm)
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
| `GET /flow` | Taker CVD 4H/15m (quant veto, `buy_dom`/`sell_dom`) |
| `GET /features` | As-of quant tape + 4H kline shock (debug). Not a signal |
| `GET /ta` | Overlay pack (22 methods). Not a signal. Does not arm |
| `GET /liq-heatmap` | Actual liq prints (not orderbook `/heatmap`) |
| `GET /liq-model` | Estimated forward map (not prints; not a target) |
| `ws://127.0.0.1:43180/ws` | Local push: ticker / confirmed kline / liq |
| `GET /confirm` | Optional LTF (20×15m; scalp `5`) |
| `GET /brief-pack` | Tickers + lag + `gates` + paper desk + accepted zones |
| `GET /health` | WS + kline lag |
| `GET /metrics` | Same health facts as Prometheus text |
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
bun run paper replay-map --days 180 --one-book --train-days 90
bun run paper replay-map BTCUSDT --from 2026-08-01 --to 2026-08-15
bun run paper review ./lab/replay-map.json
bun run paper ab ./lab/base.review.json ./lab/chop0.review.json
```

`paper arm` = post-only limit + fire-once alert. OCO: last through SL **before** the limit → `order.invalidated`. After fill, SL/TP run on the position.

Replay walks local klines (`bun run backfill` first). Separate `*-replay.sqlite`. Slippage 0.
`replay-map` walks 4H detect → policy → 15m ARM on the same tape. Omit symbol = watchlist. `--days 180` (max). `--one-book` shares one equity. `--train-days 90` freezes family floor. Quant as-of. `quantCoverage` counts ok vs missing per field (flow/cascade 0/0 is a flag, not a zero). `*-replay-map.sqlite`.
`paper review FILE.json` is compact QC from that JSON (skipReasons, coverage, flags). Does not walk bars. Nightly: [`deploy/replay-map-lab.sh`](deploy/replay-map-lab.sh).
`paper ab BASE.json VARIANT.json` is variant minus base. One flag at a time: [`deploy/replay-map-ab.sh`](deploy/replay-map-ab.sh).

HTTP: `GET /paper/event`, `GET /paper/week`, `POST /paper/zones`, `POST /paper/arm`, `GET /paper/status`, `GET /paper/metrics`. See [docs/http.md](docs/http.md).

### Live-shadow (`127.0.0.1:43182`)

Separate process. Own sqlite. Mirrors MAP/ARM **without** ledger writes or orders.

```bash
bun run live
curl -sS http://127.0.0.1:43182/live/health
curl -sS http://127.0.0.1:43182/live/shadow
```

`POST /live/map-close` accepts the feed `map.close` webhook. Polls `GET /map-latest` if the webhook is unset. Family is always cold (not a veto).

Playbook: [docs/operator.md](docs/operator.md). Spec: [docs/paper-trading.md](docs/paper-trading.md).

## Operations

Watch the mesh (read-only, viewer only — it never sends a command):

```bash
bun run term              # one live text screen: feed/gates/MAP/tape/desk/ledger/cards/events
bun run term --once       # single snapshot, exit 1 when the feed is down
scripts/ops-check.sh      # health + lag + disk + lab freshness for a 5m cron
```

`bun run term` reads four GETs per redraw — feed `/observe`, paper `/paper/observe`
(only when the feed has no embedded desk), feed `/zones?interval=240`, and
`$LIVE_SHADOW_URL` — and joins them into one `MAPCARDS` block: every card the
detector sees now, which of them the desk is holding, and the policy reason the
shadow gave each one. That is the live answer to "why is nothing armed", which
until now only a `replay-map` JSON could attribute.

Host unit: [`deploy/bybit-tracker.service`](deploy/bybit-tracker.service) (`Restart=always`, CVD/liq watchlist). Observer: [`deploy/live-shadow.service`](deploy/live-shadow.service). Exec: [`deploy/minh-exec.service`](deploy/minh-exec.service) — opt-in, **not** part of `minh.target`, keys via `LoadCredential=`. After a green merge:

```bash
deploy/pull-restart.sh
```

Stale ticker → reject. Stale klines with a live ticker → `klineLag.ok=false`, `gates.tradingAllowed=false`, new open/limit/arm reject with `kline_lag`. Open positions stay open.

A `MAP` age on the terminal far past the last 1H close means the closer did not run, not that a write was lost: a dump that fails (Windows answers `EPERM` when another handle holds `map-latest.json`) releases its bars and retries on the next closer tick, so a lock costs seconds. The feed log line is `map close`.

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
| [docs/http.md](docs/http.md) | HTTP API (`:43180` / `:43181` / `:43182`) |
| [docs/operator.md](docs/operator.md) | MAP / ARM / EVENT |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers |
| [docs/paper-trading.md](docs/paper-trading.md) | Paper spec |
| [docs/exchanges/BB.md](docs/exchanges/BB.md) | Feed |
| [docs/FEATURES.md](docs/FEATURES.md) | Inventory |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Lab → live-shadow phases (locks stay) |
| [docs/live-execution.md](docs/live-execution.md) | Live desk — staged plan, not shipped |
| [docs/ci.md](docs/ci.md) | Actions + host restart |

## Non-goals

Mainnet keys and live orders (exec is a testnet-only read-only skeleton — [live-execution.md](docs/live-execution.md) gates each stage), paper→live, mid-range entries, timer scans, ICT as a signal, mid-watch PnL, browser UI.
