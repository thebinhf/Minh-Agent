# Minh-Agent

Monorepo for local development tools: a TypeScript task board (Express + static UI) and a Bybit public WebSocket market tracker (Bun + SQLite).

## Projects

| Path | Stack | Docs |
| --- | --- | --- |
| `./` (root) | Node.js, Express 5, Vitest | [Task board](docs/task-board.md) |
| [`bybit-ws-tracker/`](bybit-ws-tracker/) | Bun, SQLite | [Bybit tracker](bybit-ws-tracker/README.md) |

See [`docs/README.md`](docs/README.md) for the full documentation index.

## Quick start — task board

```bash
npm ci
npm run dev   # http://localhost:3000
```

## Quick start — Bybit market tracker

Local public WebSocket → SQLite cache. No API keys, no trading. Works where Bybit REST is geo-blocked; Minh can read prices from localhost instead of Bybit MCP.

```bash
cd bybit-ws-tracker
bun install
bun test
bun run start   # HTTP 127.0.0.1:43180
```

## Requirements

- **Task board:** Node.js >= 20, npm
- **Bybit tracker:** Bun >= 1.4
