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
