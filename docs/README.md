# Documentation

| Document | Description |
| --- | --- |
| [Task board](task-board.md) | Express JSON API, static UI, scripts, and endpoints (repo root). |
| [Bybit market tracker](../bybit-ws-tracker/README.md) | Bun + SQLite public WebSocket cache for Bybit linear markets. |

## Tooling

| Package | Task board (root) | Bybit tracker |
| --- | --- | --- |
| Runtime | Node.js >= 20 | Bun >= 1.2 |
| Package manager | npm | Bun |
| TypeScript | 5.9.x (latest supported by ESLint tooling) | 5.9.x |

TypeScript 7 is available on npm but is not yet supported by `typescript-eslint`; both packages stay on the latest 5.x line until that ecosystem catches up.
