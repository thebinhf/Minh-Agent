# Features — Minh (明)

Verify against `src/` before treating older PRs as product scope.

## Runtime

| Feature | Status | Notes |
| --- | --- | --- |
| Single-process Bun runtime | Live | `bun run start` → `src/index.ts` |
| TypeScript 7.x | Live | `bun run typecheck` |
| Bybit public WS market cache | Live | `src/feed/bb/` — 10 linear symbols including HYPEUSDT. See [exchanges/BB.md](exchanges/BB.md) |
| Stale-pong watchdog | Live | Force reconnect if no pong after grace + `pongStaleMs` |
| Kline lag watchdog | Live | `GET /health` `klineLag` — 15/60/240 stop advancing for `klineLagMs` (default 3m) while ticker WS is live. Log once on trip/recover. Not mid-watch PnL. |
| REST kline gap-fill | Live | After subscribe; best-effort (REST may be geo-blocked; tries `restFallbacks`) |
| Historical kline backfill | Live | `bun run backfill` — REST failover or JSON/CSV dump into SQLite; no WS |
| Snapshot brief | Live | `bun run brief` / `GET /brief` — one local JSON (ticker + 15/60/240) for Minh |
| HTF map | Live | `bun run map` / `GET /map` — ticker + 4H/1H (+ daily if backfilled) + `klineLag` (60/240). No query = watchlist (cap 10). No 15m, no S/D, no bias. `/brief` unchanged. |
| Zone suggest | Live | `bun run zones` / `GET /zones` — candidate zone-cards from local 4H/1H klines. Suggest-only. Does not arm/open/limit. `/brief-pack.zones` is the accepted paper ledger, not this list. |
| Zone ledger | Live | `paper zone accept ZONEID|FILE.json` / `POST /paper/zones` (`zoneId` looks up `GET /zones`, or a full card). Cap 2 accepted/symbol. Expires on `expiryBars`. `paper zone reject`. No auto-arm of suggestions. |
| Proximity ARM | Live | Tick rests post-only OCO when last is in the proximal band of an **accepted** card. `PAPER_PROXIMITY_ARM=0` off. No chase through entry. |
| LTF confirm | Live | `bun run confirm` / `GET /confirm` — ticker + 20×15m (scalp: 5). EVENT only. No depth, no S/D. |
| MAP close | Live | Confirmed 1H/4H → `map-latest.json` + optional webhook. 4H also auto-accepts `/zones` cards into the paper ledger (`MAP_ACCEPT=0` off). No auto-arm. `MAP_CLOSE=0` off. |
| EVENT desk | Live | `bun run paper event` / `GET /paper/event` — pending OCO + alerts + accepted zones. Do not poll `/confirm`. |
| Paper week | Live | `bun run paper week` / `GET /paper/week` — 7-day metrics + standing ledger + funnel.accepted. |
| Brief data pack | Live | `bun run brief-pack` / `GET /brief-pack` — tickers + kline lag + `gates` + paper desk + accepted ledger zones. Additive. No auto-arm. |
| Chart / depth / heatmap views | Live | `GET /chart` stitches kline OHLCV; `GET /depth` is the live L50 ladder; `GET /heatmap` grids snapshots (+ live book); `GET /market` is one payload. No browser UI. |
| Paper trading | Live | `src/paper/` — virtual USDT ledger sized like Bybit linear (lot/tick/notional), 1–10% risk, MTF tags, Phase 2 fees/funding/multi-TP/leverage, isolated or cross. Phase 3: price alerts, GTC limit pending (post-only default), daemon tick evaluates alerts/limits/SL-TP. CLI + `127.0.0.1:43181`. No keys, no real orders. See [paper-trading.md](paper-trading.md). |
| Paper alerts | Live | `bun run paper alert set SYMBOL --above|--below PRICE`. Fire-once. Log + `paper_events`; optional Telegram/webhook via `PAPER_NOTIFY`. No chat spam. |
| Paper limit entry | Live | `bun run paper limit … --price`. Rests until last prints through; fill at the limit. Default post-only + OCO (invalidation cancels pending before fill). |
| SQLite storage | Live | Feed: ticker tape off by default; book snaps on timer only; drop redundant kline index; prune checkpoints WAL and VACUUMs when freelist ≥15%. |
| Paper event notify | Live | Optional `PAPER_NOTIFY=telegram|webhook` on `alert.fired` / `order.filled` / `order.invalidated` / `position.closed`. Default log. No PnL spam. |
| Paper replay | Live | `bun run paper replay` / `replay-batch FILE.json` — walk local klines through limit/OCO/fee/funding. Slippage 0. Same-bar TP after fill skipped. Separate `*-replay.sqlite`. No auto S/D. |
| Paper operator surface | Live | `paper status` / `paper arm` / `paper day` — one JSON for desk, one command to rest limit+alert, UTC session counts. |
| Paper entry kill-switch | Live | New `paper open` / `paper limit` / `POST /paper/positions` / `POST /paper/orders` / `paper arm` reject when `GET /health` WS is down (`feed_unhealthy`) or `klineLag.ok=false` (`kline_lag`). `/brief-pack` `gates: { tradingAllowed, reasons }`. Does not auto-close opens. No extra mid-range alerts. |
| Paper metrics | Live | SQLite `paper_events` + closed positions. `GET /paper/metrics?days=N` / `bun run paper metrics --days N`. Win rate, avg RR, no_fill%, funnel (detected→armed→touched→filled/cancelled→exited). `cancelCodes` splits noFill into `never_touched` vs `ops_cancel`; submit-time `kline_lag` / `feed_unhealthy` / `rr_below_min` increment `gates_block` / `rr_fail`. Optional `zoneId` on open/limit/arm (arm stamps an existing duplicate alert). `/zones` does not auto-arm. |
| Orderbook snapshot gate | Live | Clear RAM on connect; ignore deltas until snapshot/`u=1` |
| Subscribe + REST retry | Live | Chunked subscribe (10) + exponential retry |
| CI | Live | GitHub Actions: `bun` typecheck + test on `main` and PRs. No keys, no daemon, no live deploy. See [ci.md](ci.md). |

## Explicitly not in this repo

| Item | Why |
| --- | --- |
| Express task board / static UI | Cursor environment-setup scaffold only. Removed. |
| `apps/` monorepo packages | Tracker is a feature, not a sibling app. |
| Trading / private Bybit topics | Public linear market data only. No API keys. |
| Live orders / paper→live bridge | Forbidden. Paper refuses to start if Bybit key env vars are set. |
| Browser dashboard | Greenfield Minh has no browser operator UI. |

## Docs

| Doc | Purpose |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process + layout |
| [exchanges/BB.md](exchanges/BB.md) | Bybit tracker feature |
| [paper-trading.md](paper-trading.md) | Paper trading spec (MVP + Phase 2–6: risk, fees, alerts/limit/OCO, notify, kline replay, operator surface) |
| [operator.md](operator.md) | Minh Agent loop: MAP = `/map` + optional `/zones` suggest; `/brief-pack` gates/desk; EVENT = `/confirm` |
| [ci.md](ci.md) | GitHub Actions CI + host systemd restart (no live keys) |
