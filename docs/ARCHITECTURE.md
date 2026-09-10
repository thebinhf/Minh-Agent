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
         GET /brief  (one snapshot JSON for Minh — ticker + 15/60/240)
         GET /map    (HTF MAP — ticker + 4H/1H + D if backfilled; klineLag 60/240)
         GET /map-latest (last 1H/4H close dump; 404 until first confirm)
         GET /confirm (EVENT — ticker + 20×15m or 5m; no depth)
         GET /zones    (suggest-only zone-cards from local HTF klines; no auto-arm)
         GET /brief-pack  (tickers + kline lag + gates + paper desk + accepted zone ledger)
         GET /chart  GET /depth  GET /heatmap  GET /market
         GET /health  (WS + per 15/60/240 kline lag)
  → src/paper
       → paper SQLite ledger (separate file)
       → risk engine (account 1–10% band, R:R from SL/TP, MTF tags, Phase 2 fee/funding/lev)
       → alerts + limit pending + tick evaluate (Phase 3)
       → optional notify on event-once kinds (Phase 4)
       → kline replay into paper-replay.sqlite (Phase 5)
       → status / arm / day / metrics operator surface (Phase 6 + P1 + zone funnel)
       → zone ledger (accept/reject/expire; cap 2/symbol)
       → proximity ARM (accepted cards, proximal band only; PAPER_PROXIMITY_ARM=0 off)
       → HTTP 127.0.0.1:43181 /paper/*
       → CLI  bun run paper …

bun run brief [SYMBOL]   # same JSON as GET /brief; default BTCUSDT
bun run map              # HTF MAP watchlist + klineLag; agent draws S/D
bun run zones            # suggest-only zone-cards (no auto-arm)
bun run paper zone accept ZONEID   # ledger from GET /zones; does not arm
bun run paper event              # OCO desk — no /confirm
bun run paper week               # 7-day funnel + standing zones
bun run confirm [SYMBOL] # EVENT LTF snapshot (15m / 5m)
bun run brief-pack [SYMBOL]  # same JSON as GET /brief-pack; all symbols if omitted
bun run query chart|depth|heatmap|market
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
| `src/brief-pack.ts` | CLI for `GET /brief-pack` (feed SQLite + local paper SQLite) |
| `src/feed/bb/` | Bybit public WS tracker (first live feature) |
| `src/zones/` | Zone-card v1 schema + HTF suggest detector (no auto-arm) |
| `src/paper/` | Paper trading ledger + CLI + HTTP (simulation only) |
| `test/feed/bb/` | Tracker unit tests |
| `test/zones/` | Zone-card schema + detector tests |
| `test/paper/` | Paper ledger / risk / HTTP tests |
| `deploy/` | systemd unit + `pull-restart.sh` for the Minh process |
| `.github/workflows/` | CI: typecheck + test (no daemon, no keys) |
| `docs/` | Architecture and feature docs |

## Layers (target, from greenfield Minh)

| Layer | Path | Rule |
| --- | --- | --- |
| App | `src/index.ts`, `src/brief-pack.ts` | Boot + wire. `GET /brief-pack` injects `paperDesk` from the composition root so feed never imports paper. CLI opens both SQLite files. |
| Feed | `src/feed/bb/` | Exchange I/O — public WS, SQLite, HTTP. Owns kline lag on `/health`. |
| Zones | `src/zones/` | Zone-card schema + HTF suggest. Feed HTTP `GET /zones` only. No paper writes. |
| Paper | `src/paper/` | Simulated broker — own DB, own HTTP. Reads feed prices only. |

Future features (strategy, agent, presence) belong under `src/` the same way — not as `apps/*` packages.

## Why not `apps/`

PR #1 put a throwaway task board at repo root. PR #2 added the tracker as a sibling folder so it would not clobber that demo. That split is obsolete: the task board had no product meaning, and the tracker is a Minh feature, not a second project.
