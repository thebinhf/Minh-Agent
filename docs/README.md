# Documentation

| Document | Description |
| --- | --- |
| [Architecture](architecture.md) | Monorepo layout and how PR #1 / #2 fit together. |
| [Task board](task-board.md) | Express JSON API, static UI, scripts, and endpoints. |
| [Bybit market tracker](../apps/bybit-ws-tracker/README.md) | Bun + SQLite public WebSocket cache for Bybit linear markets. |

## Tooling

| Package | Task board | Bybit tracker |
| --- | --- | --- |
| Path | `apps/task-board/` | `apps/bybit-ws-tracker/` |
| Runtime | Node.js >= 20 | Bun >= 1.4 |
| Package manager | npm | Bun |
| TypeScript | 7.x (`tsc`) | 7.x |
| Lint | ESLint on `public/**/*.js` | — |

Run everything from the repo root with `npm run test`, `npm run dev`, and `npm run dev:bybit`.

TypeScript sources in the task board are checked with `npm run typecheck`. ESLint does not lint `.ts` files because `typescript-eslint` does not yet support TypeScript 7.
