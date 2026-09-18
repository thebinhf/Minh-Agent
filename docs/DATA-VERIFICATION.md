# Data & signal verification — Minh (明)

How the project proves its data and signals are correct, that it pursues
exactly **one** trading methodology, and how the data layer grows toward a
Terminal Platform. Run it any time:

```bash
bun run scripts/verify-data.ts        # readonly; needs network for the venue diff
```

The verifier is **independent re-derivation**, not a self-test: stored values
are compared against what the venue serves over REST, and every zone card is
recomputed from raw klines without calling the detector.

## Results — 2026-09-14 (dev machine, 180d local DB)

| Section | Check | Result |
| --- | --- | --- |
| klines | stored closed OHLCV equals venue (5,970 bars, 10 symbols × 240/60/15) | **0 confirmed mismatches** |
| klines | stale forming rows (process died mid-bar, `confirm=0`) | 69 — harmless to signals (detectors use confirmed bars only), never re-fetched |
| klines | missing bars | 570 in 30 contiguous downtime blocks + **20 single-bar holes** |
| OI | stored history equals venue (4,000 points, 1h/4h) | **0 mismatches, 0 missing** |
| funding | stored history equals venue (2,000 records) | **0 mismatches, 0 missing** |
| flow | minute-bucket alignment, sizes, trade counts | clean |
| liquidations | price/size sanity, recv/exch within clock tolerance | clean (local clock runs ~1–14s behind venue) |
| zones | detector deterministic (two runs byte-identical) | **pass** |
| zones | geometry: bounds, sl beyond distal, entry in zone, tp side, hardInvalid=sl, softInvalid=distal | **25/25** |
| zones | impulseAtr = \|body\| / atr14; rr = reward / risk | **25/25** |
| zones | penetration monotone since base; freshness label matches band | **25/25** |
| methodology | one detector definition (`src/zones/setups.ts`), consumers = live `/zones` + `replay-map` only | **pass** |
| methodology | quant enters MAP only as vetoes; overlay `signal:false` never arms; live-shadow `orders:false`; no LLM/MCP; ROADMAP locks present | **pass** |
| coverage | watchlist vs venue universe | 10 of 869 linear perps (1.2%), 538 spot — explicit MVP scope |

## One methodology, verified

The project trades exactly one method: **zone-cards (S/D + breakout + reversal)
emitted from confirmed HTF bars → MAP policy accept (quant = veto-only) →
proximity ARM + 15m confirm → post-only GTC + OCO in the paper ledger.** The
audit proves there is no second signal path: the detector has a single
definition with exactly two consumers (the live `/zones` endpoint and the
replay of the same method on historical tape), the TA overlay is `signal:false`
and cannot arm, live-shadow mirrors decisions without orders, no LLM/MCP sits
in the autonomous path, and the ROADMAP locks (boundary, event-once, missing
tape ≠ 0) are still in place. The P7 TA gates and the `AGENT_ZONE_FRESH` /
`AGENT_ZONE_IMPULSE_MIN` filters are accept-time **filters** on the same
method — off by default, A/B before on — not new signals. P9 `PAPER_BE_R`
moves an already-open stop; `PAPER_ZONE_SCORE_RR` only reorders sampled
families. Neither emits a card.

## Findings and follow-ups

1. **Gap-fill does not heal mid-history holes.** Boot gap-fill starts from
   `MAX(start_ts)`, so bars missing during tracker-off windows stay missing
   forever, and a forming row left `confirm=0` by an abrupt shutdown is never
   re-fetched because the row exists. **Addressed** by `BYBIT_GAP_HEAL`
   (default on, `recovery.gapHeal`): before the tail fill, every boot scans
   interior cadence holes and stale `confirm=0` rows per series and repairs
   them from venue REST (`healKlineGaps` in `src/feed/bb/rest.ts`, wired in
   `ws.ts`). First run on the dev DB: 108 stale rows finalized, all interior
   holes closed, second pass idempotent — the verifier now reports
   **VERIFIED (0 fail)** with only honest warnings (forward-only tape,
   tail bars while the feed is stopped).
2. **Run the verifier on the host.** The dev-machine downtime above is
   environmental; the host tracker runs 24/7 under systemd and should show
   zero downtime blocks. Weekly verifier runs on the host + before releases
   turn this into a standing data-quality gate.

## Terminal Platform data expansion path

Today the cache is deliberately narrow: 10 Bybit-linear perps, klines
15/60/240 (+5m recent), tickers/orderbook snapshots, OI, funding, and a
forward-only flow/liq tape. The architecture already separates **feed →
sqlite → read-only HTTP**, which is the shape a Terminal needs; what grows is
breadth, not design:

| Stage | Breadth | What changes |
| --- | --- | --- |
| T0 | All Bybit linear (869 symbols) | `config.symbols` → registry-driven universe from `instruments-info`; WS subscribe in chunks; per-symbol coverage stays honest (`GET /coverage`) |
| T1 | Bybit spot (538) | same cache schema, second `category`; zone detector stays perp-first |
| T2 | Second venue (public, no keys) behind the same zone-card + paper desk | ROADMAP P5 — normalized kline/ticker schema, venue table per cache row; after the P7 A/B queue resolves |
| T3 | Terminal UI | reads the existing read-only HTTP surface (`/observe`, `/ta`, `/zones`, `/flow`, `/liq-heatmap`); UI stays a viewer — never a command source (lock) |

Invariants that survive every stage: missing tape ≠ 0, as-of honesty with
`quantCoverage`, venue rules stay venue rules, and keys/order placement exist
only in `src/exec/`.
