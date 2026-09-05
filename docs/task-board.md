# Task board

Minimal full-stack TypeScript task board: an Express JSON API plus a static UI. Used to exercise a complete Node.js development environment end to end.

**Path:** [`apps/task-board/`](../apps/task-board/)

## Requirements

- Node.js >= 20 (developed against Node 22)
- npm

## Getting started

From the repository root:

```bash
npm ci --prefix apps/task-board
npm run dev           # http://localhost:3000
```

Or from the app directory:

```bash
cd apps/task-board
npm ci
npm run dev
```

Then open http://localhost:3000 and add, complete, and delete tasks.

## Scripts

Run from `apps/task-board/` or via root (`npm run <script> --prefix apps/task-board`).

| Command | Description |
| --- | --- |
| `npm run dev` | Run the server in watch mode (`tsx watch`). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm start` | Run the compiled server from `dist/`. |
| `npm run typecheck` | Type-check without emitting output. |
| `npm run lint` | Lint static browser JS in `public/` (ESLint). |
| `npm test` | Run the API test suite (Vitest + Supertest). |

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check. |
| `GET` | `/api/tasks` | List tasks (newest first). |
| `POST` | `/api/tasks` | Create a task (`{ "title": "..." }`). |
| `PATCH` | `/api/tasks/:id` | Toggle a task's done flag. |
| `DELETE` | `/api/tasks/:id` | Delete a task. |

Tasks are stored in memory and reset when the server restarts.

## Stack

- **Express 5** — HTTP API and static file serving
- **TypeScript 7** — strict type-checking via `tsc`
- **Vitest 5** + **Supertest** — API tests
- **ESLint 10** — linting for static browser JS in `public/`
