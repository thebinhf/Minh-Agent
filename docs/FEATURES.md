# Features — Minh (明)

Verify against `src/` before treating older PRs as product scope.

## Runtime

| Feature | Status | Notes |
| --- | --- | --- |
| Single-process Bun runtime | Live | `bun run start` → `src/index.ts` |
| TypeScript 7.x | Live | `bun run typecheck` |
| Bybit public WS market cache | Live | `src/feed/bb/` — see [exchanges/BB.md](exchanges/BB.md) |
| Stale-pong watchdog | Live | Force reconnect if no pong after grace + `pongStaleMs` |
| REST kline gap-fill | Live | After subscribe; best-effort (REST may be geo-blocked; tries `restFallbacks`) |
| Historical kline backfill | Live | `bun run backfill` — REST failover or JSON/CSV dump into SQLite; no WS |
| Snapshot brief | Live | `bun run brief` / `GET /brief` — one local JSON (ticker + 15/60/240) for Minh |
| HTF map | Live | `bun run map` / `GET /map` — ticker + 4H/1H (+ daily if backfilled). No 15m, no S/D, no bias. `/brief` unchanged. |
| Chart / depth / heatmap views | Live | `GET /chart` stitches kline OHLCV; `GET /depth` is the live L50 ladder; `GET /heatmap` grids snapshots (+ live book); `GET /market` is one payload. No browser UI. |
| Paper trading | Live | `src/paper/` — virtual USDT ledger sized like Bybit linear (lot/tick/notional), 1–10% risk, MTF tags, Phase 2 fees/funding/multi-TP/leverage, isolated or cross. Phase 3: price alerts, GTC limit pending (post-only default), daemon tick evaluates alerts/limits/SL-TP. CLI + `127.0.0.1:43181`. No keys, no real orders. See [paper-trading.md](paper-trading.md). |
| Paper alerts | Live | `bun run paper alert set SYMBOL --above|--below PRICE`. Fire-once. Log + `paper_events`; optional Telegram/webhook via `PAPER_NOTIFY`. No chat spam. |
| Paper limit entry | Live | `bun run paper limit … --price`. Rests until last prints through; fill at the limit. Default post-only + OCO (invalidation cancels pending before fill). |
| SQLite storage | Live | Feed: ticker tape off by default; book snaps on timer only; drop redundant kline index; prune checkpoints WAL and VACUUMs when freelist ≥15%. |
| Paper event notify | Live | Optional `PAPER_NOTIFY=telegram|webhook` on `alert.fired` / `order.filled` / `order.invalidated` / `position.closed`. Default log. No PnL spam. |
| Paper replay | Live | `bun run paper replay` / `replay-batch FILE.json` — walk local klines through limit/OCO/fee/funding. Slippage 0. Same-bar TP after fill skipped. Separate `*-replay.sqlite`. No auto S/D. |
| Paper operator surface | Live | `paper status` / `paper arm` / `paper day` — one JSON for desk, one command to rest limit+alert, UTC session counts. |
| Orderbook snapshot gate | Live | Clear RAM on connect; ignore deltas until snapshot/`u=1` |
| Subscribe + REST retry | Live | Chunked subscribe (10) + exponential retry |

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
| [operator.md](operator.md) | Minh Agent loop: MAP on HTF close, ARM alert+limit, EVENT-only (no 30m scan) |
