# Minh-Agent

Monorepo for local development tools used by Minh.

## Projects

| App | Path | Stack | Docs |
| --- | --- | --- | --- |
| Task board | [`apps/task-board/`](apps/task-board/) | Node.js, Express 5, Vitest | [Task board](docs/task-board.md) |
| Bybit market tracker | [`apps/bybit-ws-tracker/`](apps/bybit-ws-tracker/) | Bun, SQLite | [Bybit tracker](apps/bybit-ws-tracker/README.md) |

See [`docs/README.md`](docs/README.md) for the documentation index and [`docs/architecture.md`](docs/architecture.md) for layout and history.

## Quick start

From the repository root:

```bash
npm run install:all   # task-board (npm) + bybit tracker (bun)
npm test              # all test suites
```

### Task board

```bash
npm run dev           # http://localhost:3000
```

### Bybit market tracker

Local public WebSocket → SQLite cache. No API keys, no trading.

```bash
npm run dev:bybit     # HTTP 127.0.0.1:43180
```

## Requirements

- **Monorepo scripts:** Node.js >= 20, npm
- **Bybit tracker:** Bun >= 1.4
