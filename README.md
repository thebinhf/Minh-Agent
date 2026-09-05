# Minh-Agent

A minimal full-stack TypeScript task board used to exercise a complete
development environment: an Express JSON API plus a modern static UI.

## Requirements

- Node.js >= 20 (developed against Node 22)
- npm

## Getting started

```bash
npm ci        # install dependencies
npm run dev   # start the dev server at http://localhost:3000 (watch mode)
```

Then open http://localhost:3000 and add, complete, and delete tasks.

## Scripts

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Run the server in watch mode (`tsx watch`).  |
| `npm run build`     | Compile TypeScript to `dist/`.               |
| `npm start`         | Run the compiled server from `dist/`.        |
| `npm run typecheck` | Type-check without emitting output.          |
| `npm run lint`      | Lint with ESLint.                            |
| `npm test`          | Run the API test suite (Vitest + Supertest). |

## API

| Method   | Path              | Description               |
| -------- | ----------------- | ------------------------- |
| `GET`    | `/api/health`     | Health check.             |
| `GET`    | `/api/tasks`      | List tasks (newest first).|
| `POST`   | `/api/tasks`      | Create a task (`{title}`).|
| `PATCH`  | `/api/tasks/:id`  | Toggle a task's done flag. |
| `DELETE` | `/api/tasks/:id`  | Delete a task.            |

Tasks are stored in memory and reset when the server restarts.

## Bybit market tracker

Local public WebSocket → SQLite market cache lives in [`bybit-ws-tracker/`](bybit-ws-tracker/). Minh can read prices from localhost SQLite/HTTP instead of Bybit MCP (avoids Usage quota). The WS feed works in regions where Bybit REST is geo-blocked. No API keys, no trading.

```bash
cd bybit-ws-tracker
bun install
bun test
bun run start   # HTTP 127.0.0.1:43180, public linear WS
```
