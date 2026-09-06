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
| Paper trading | Live | `src/paper/` — virtual USDT ledger sized like Bybit linear (lot/tick/notional), 1–10% risk, MTF tags, Phase 2 fees/funding/multi-TP/leverage, isolated or cross. CLI + `127.0.0.1:43181`. No keys, no real orders. See [paper-trading.md](paper-trading.md). |
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
| [paper-trading.md](paper-trading.md) | Paper trading spec (MVP + Phase 2: 1–10% risk, fees, funding, multi-TP, leverage, isolated/cross) |
