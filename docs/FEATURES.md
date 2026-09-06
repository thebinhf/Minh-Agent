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
| Orderbook snapshot gate | Live | Clear RAM on connect; ignore deltas until snapshot/`u=1` |
| Subscribe + REST retry | Live | Chunked subscribe (10) + exponential retry |

## Explicitly not in this repo

| Item | Why |
| --- | --- |
| Express task board / static UI | Cursor environment-setup scaffold only. Removed. |
| `apps/` monorepo packages | Tracker is a feature, not a sibling app. |
| Trading / private Bybit topics | Public linear market data only. No API keys. |
| Browser dashboard | Greenfield Minh has no browser operator UI. |

## Docs

| Doc | Purpose |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process + layout |
| [exchanges/BB.md](exchanges/BB.md) | Bybit tracker feature |
