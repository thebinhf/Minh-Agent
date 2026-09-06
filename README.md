# Minh (明)

Bun trading agent. Architecture follows the [greenfield Minh Agent](https://github.com/comtammatu/minh-agent) layout: one process, features under `src/`, Bybit as `src/feed/bb/`.

**Live features:** Bybit public linear WebSocket → local SQLite market cache, plus a **paper** simulation ledger. No API keys, no real orders.

## Quick start

```bash
bun install
bun test
bun run start          # feed :43180 + paper :43181
bun run brief BTCUSDT  # one local JSON snapshot (ticker + 15/60/240)
bun run paper account  # simulated equity (requires local feed prices to mutate)
bun run backfill --probe
bun run backfill --days 14   # 15/60/240 into SQLite; does not start WS
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/FEATURES.md](docs/FEATURES.md)
- [docs/exchanges/BB.md](docs/exchanges/BB.md)
- [docs/paper-trading.md](docs/paper-trading.md) — paper trading (ledger + CLI + HTTP; Phase 2 fees/funding/multi-TP/leverage)

## Checks

```bash
bun test
bun run typecheck
```

## Requirements

- Bun >= 1.4
- TypeScript 7.x
