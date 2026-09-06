# Architecture — Minh (明)

This repository is **Minh Agent**, not a collection of unrelated demo apps.

The dummy Express task board that Cursor added during environment setup is gone. It was never a product feature.

Layout matches the greenfield Minh Agent convention: one Bun process, I/O at the feed edge, features under `src/`.

## Operating mechanism

- One Bun process = one daemon (`bun run start` → `src/index.ts`).
- Features start from the composition root. They do not ship as sibling packages.

```text
src/index.ts
  → src/feed/bb
       → public linear WS (+ stale-pong watchdog, subscribe retry)
       → REST kline gap-fill after connect (best-effort, host failover)
       → SQLite cache
       → read-only HTTP 127.0.0.1:43180
         GET /brief  (one snapshot JSON for Minh)
  → src/paper
       → paper SQLite ledger (separate file)
       → risk engine (account 2–5% band, R:R from SL/TP, MTF tags)
       → HTTP 127.0.0.1:43181 /paper/*
       → CLI  bun run paper …

bun run brief [SYMBOL]   # same JSON as GET /brief; default BTCUSDT
bun run paper account    # simulated equity (no keys, no real orders)
bun run backfill   # one-shot; does not start WS
  → REST /v5/market/kline (official host, then restFallbacks)
    or JSON/CSV dump import
  → same SQLite klines table
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Composition root |
| `src/feed/bb/` | Bybit public WS tracker (first live feature) |
| `src/paper/` | Paper trading ledger + CLI + HTTP (simulation only) |
| `test/feed/bb/` | Tracker unit tests |
| `test/paper/` | Paper ledger / risk / HTTP tests |
| `deploy/` | systemd unit for the Minh process |
| `docs/` | Architecture and feature docs |

## Layers (target, from greenfield Minh)

| Layer | Path | Rule |
| --- | --- | --- |
| App | `src/` | Boot + wire only |
| Feed | `src/feed/bb/` | Exchange I/O — public WS, SQLite, HTTP |
| Paper | `src/paper/` | Simulated broker — own DB, own HTTP. Reads feed prices only. |

Future features (strategy, agent, presence) belong under `src/` the same way — not as `apps/*` packages.

## Why not `apps/`

PR #1 put a throwaway task board at repo root. PR #2 added the tracker as a sibling folder so it would not clobber that demo. That split is obsolete: the task board had no product meaning, and the tracker is a Minh feature, not a second project.
