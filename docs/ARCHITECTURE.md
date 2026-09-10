# Architecture — Minh (明)

One Bun process. I/O at the feed edge. Features under `src/`. See the [README](../README.md) for the 24/7 loop.

```text
src/index.ts
  → src/feed/bb     public linear WS → SQLite → HTTP :43180
  → src/zones       zone-card schema + HTF suggest + proximity math
  → src/agent       paper-only MAP bias + accept policy (no arm)
  → src/paper       simulated broker → SQLite → HTTP :43181
```

Feed HTTP never imports paper. The composition root:

1. Injects `paperDesk` into `GET /brief-pack`
2. On confirmed **4H** `map.close`, MAP_ACCEPT pick → agent policy → `acceptZone`. `MAP_ACCEPT=0` = no copy. `AGENT_MAP=0` = policy no-op (old copy still runs).
3. Paper tick proximity-arms accepted cards (`PAPER_PROXIMITY_ARM=0` off)

HTTP contract: [http.md](http.md).

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Composition root |
| `src/brief-pack.ts` | CLI for `GET /brief-pack` |
| `src/feed/bb/` | Public WS, SQLite, read-only HTTP |
| `src/zones/` | Zone-card v1, HTF detector, ledger helpers, proximity |
| `src/agent/` | Paper-only MAP bias + policy gate (no auto-arm) |
| `src/paper/` | Paper ledger, OCO limits, tick, replay, metrics |
| `test/feed/bb/` `test/zones/` `test/paper/` `test/agent/` | Tests |
| `deploy/` | systemd + `pull-restart.sh` |
| `.github/workflows/` | typecheck + test (no daemon, no keys) |

## Layers

| Layer | Path | Rule |
| --- | --- | --- |
| App | `src/index.ts` | Boot + wire. No exchange I/O. |
| Feed | `src/feed/bb/` | Public WS / REST / SQLite / HTTP. Owns kline lag. Does not arm. |
| Zones | `src/zones/` | Schema + suggest. `GET /zones` is GET-only. |
| Agent | `src/agent/` | 4H HH/HL bias + accept policy. Does not arm. Does not change `/map`. |
| Paper | `src/paper/` | Simulated broker. Own DB, own HTTP. Reads feed prices only. |

## Feed HTTP (`:43180`)

| Route | Role |
| --- | --- |
| `GET /map` | HTF MAP + `klineLag` (60/240). Cap 10. No 15m. |
| `GET /map-latest` | Last 1H/4H dump |
| `GET /zones` | Suggest-only cards (240 / 60) |
| `GET /oi` | OI history (quant veto) |
| `GET /funding` | Funding history (quant veto) |
| `GET /liq-heatmap` | Actual liq prints heatmap |
| `GET /confirm` | Optional LTF (15 / 5) |
| `GET /brief-pack` | Tickers + lag + `gates` + paper desk + accepted zones |
| `GET /health` | WS + kline lag |
| `GET /brief` `/chart` `/depth` `/heatmap` `/market` | Snapshots |

## Paper HTTP (`:43181`)

| Route | Role |
| --- | --- |
| `GET /paper/event` | OCO desk |
| `GET /paper/week` | 7-day funnel + standing ledger |
| `POST /paper/zones` | Accept by `zoneId` or full card |
| `POST /paper/arm` | Manual limit + alert |
| `GET /paper/status` `/metrics` `/day` | Desk |

## CLI

```text
bun run start
bun run map | zones | confirm | brief | brief-pack | query | backfill
bun run paper zone accept ZONEID
bun run paper event
bun run paper week
bun run paper arm …
bun run paper replay … | replay-batch FILE.json
```

Future features (strategy, presence) belong under `src/` the same way — not as `apps/*` packages.
