# Architecture

Minh-Agent is a **two-app monorepo**. Both apps are independent services with their own runtime, dependencies, and tests. The repository root only orchestrates install, dev, and test scripts.

## Layout

```
.
├── apps/
│   ├── task-board/          # PR #1 — Node.js demo app + Cloud Agent smoke test
│   └── bybit-ws-tracker/    # PR #2 — Bun market cache for local price reads
├── docs/                    # Shared documentation
├── .cursor/environment.json # Cloud Agent bootstrap for both apps
└── package.json             # Root scripts (no app dependencies)
```

## Apps

### `apps/task-board` (PR #1)

- **Purpose:** Minimal full-stack task board to prove a Node.js dev environment end to end.
- **Stack:** Express 5, TypeScript 7, Vitest, static UI in `public/`.
- **Port:** `3000`
- **Origin:** Bootstrapped at repo root in PR #1; moved here to unify the monorepo.

### `apps/bybit-ws-tracker` (PR #2)

- **Purpose:** Local Bybit public linear WebSocket → SQLite cache. Lets agents read prices from localhost instead of Bybit MCP (avoids Usage quota) and works where REST is geo-blocked.
- **Stack:** Bun, TypeScript 7, `bun:sqlite`.
- **Port:** `43180` (read-only HTTP)
- **Origin:** Added under `bybit-ws-tracker/` in PR #2; moved under `apps/` to match the task board.

## Why this structure

PR #1 placed the task board at the repository root. PR #2 added the Bybit tracker as a sibling folder without moving the task board, which left:

- Two unrelated top-level project roots (`package.json` at `/` vs `bybit-ws-tracker/`)
- Cloud Agent environment configured only for the task board
- Documentation and scripts split across root and subdirectory

Moving both apps under `apps/` and keeping a thin root `package.json` removes that split while preserving each app's stack (npm/Node vs Bun).

## Cloud Agent environment

`.cursor/environment.json` installs both apps and exposes both ports:

| Terminal | Command | Port |
| --- | --- | --- |
| `task-board` | `npm run dev --prefix apps/task-board` | 3000 |
| `bybit-tracker` | `cd apps/bybit-ws-tracker && bun run start` | 43180 |

## Deploy note

The Bybit tracker systemd unit expects the app at `/opt/minh-agent/apps/bybit-ws-tracker`. See [`apps/bybit-ws-tracker/deploy/bybit-tracker.service`](../apps/bybit-ws-tracker/deploy/bybit-tracker.service).
