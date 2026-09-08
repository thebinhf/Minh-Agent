# Minh (明)

Bun trading agent: one process, features under `src/`, Bybit feed at `src/feed/bb/`.

**Live features:** Bybit public linear WebSocket → local SQLite market cache, plus a **paper** simulation ledger. No API keys, no real orders.

## Quick start

```bash
bun install
bun test
bun run start          # feed :43180 + paper :43181
bun run brief BTCUSDT  # one local JSON snapshot (ticker + 15/60/240)
bun run query chart BTCUSDT 15
bun run query depth BTCUSDT
bun run query heatmap BTCUSDT --bucket 10
bun run query market BTCUSDT 15 --bucket 10
bun run paper account  # simulated equity (requires local feed prices to mutate)
bun run paper alert set BTCUSDT --below 117500
bun run paper limit BTCUSDT --side long --price 117500 --sl 116200 --tp 120800 --tf 240,60,15
bun run paper replay BTCUSDT --from 2026-08-01 --to 2026-08-15 --side long --price 117500 --sl 116200 --tp 120800 --tf 240,60,15
bun run backfill --probe
bun run backfill --days 14   # 15/60/240 into SQLite; does not start WS
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/FEATURES.md](docs/FEATURES.md)
- [docs/exchanges/BB.md](docs/exchanges/BB.md)
- [docs/operator.md](docs/operator.md) — MAP / ARM / EVENT loop for Minh Agent (PA + S/D; no 30m scan)
- [docs/paper-trading.md](docs/paper-trading.md) — paper trading (ledger + CLI + HTTP; Phase 2 fees/funding/multi-TP/leverage)

## Checks

```bash
bun test
bun run typecheck
```

## Requirements

- Bun >= 1.4
- TypeScript 7.x
