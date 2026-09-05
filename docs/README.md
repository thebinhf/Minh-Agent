# Documentation

| Document | Description |
| --- | --- |
| [Task board](task-board.md) | Express JSON API, static UI, scripts, and endpoints (repo root). |
| [Bybit market tracker](../bybit-ws-tracker/README.md) | Bun + SQLite public WebSocket cache for Bybit linear markets. |

## Tooling

| Package | Task board (root) | Bybit tracker |
| --- | --- | --- |
| Runtime | Node.js >= 20 | Bun >= 1.4 |
| Package manager | npm | Bun |
| TypeScript | 7.x (`tsc` for type-checking) | 7.x |
| Lint | ESLint on `public/**/*.js` only | — |

TypeScript sources are checked with `npm run typecheck` / `tsc`. ESLint does not lint `.ts` files because `typescript-eslint` does not yet support TypeScript 7.
