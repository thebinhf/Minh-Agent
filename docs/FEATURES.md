# Features — Minh (明)

Verify against `src/` before treating older PRs as product scope.

## Runtime

| Feature | Status | Notes |
| --- | --- | --- |
| Single-process Bun runtime | Live | `bun run start` → `src/index.ts` |
| TypeScript 7.x | Live | `bun run typecheck` |
| Bybit public WS market cache | Live | `src/feed/bb/` — 10 linear symbols including HYPEUSDT. L50 book on the full watchlist. Liq prints + CVD stay BTC/ETH/SOL. See [exchanges/BB.md](exchanges/BB.md) |
| Stale-pong watchdog | Live | Force reconnect if no pong after grace + `pongStaleMs` |
| Kline lag watchdog | Live | `GET /health` `klineLag` — 15/60/240 stop advancing for `klineLagMs` (default 3m) while ticker WS is live. Log once on trip/recover. Not mid-watch PnL. |
| REST kline gap-fill | Live | After subscribe; best-effort (REST may be geo-blocked; tries `restFallbacks`) |
| Open interest history | Live | Public `GET /v5/market/open-interest` → SQLite `open_interest`. `GET /oi`, `/map.oi` (`deltaPct`, `trend`, `reading` = long_add/short_add/cover/flush). Quant veto only. `BYBIT_OI=0` off. `BYBIT_OI_EXTREME` default 2 (%). |
| Funding rate history | Live | Public `GET /v5/market/funding/history` → SQLite `funding`. `GET /funding`, `/map.funding` (`crowded` long/short if `|rate| ≥ 0.0003`). Quant veto only. `BYBIT_FUNDING=0` off. |
| Taker CVD / money flow | Live | Public WS `publicTrade` (BTC/ETH/SOL) → SQLite `flow_bars` (1m). `GET /flow`, `/map.flow` (`delta`, `reading` = buy_dom/sell_dom). Quant veto, accept-only (`sell_dom` vs demand / `buy_dom` vs supply). ARM skips like OI add. `BYBIT_FLOW=0` off. `BYBIT_FLOW_EXTREME` default `0.15`. Not `/heatmap`. |
| As-of features | Live | `GET /features?symbol=&asof=` — same tape as `replay-map` (`crowded` / `oiReading` / `flowReading` / `cascade`). Missing ≠ 0. Debug. Not a signal. `/map` unchanged. |
| Liquidation heatmap | Live | Public WS `allLiquidation` (BTC/ETH/SOL) → SQLite `liquidations`. `GET /liq-heatmap`, `/map.liq`. `cascade` is side+intensity+walk+fuel (OI `flush`/`cover` can confirm). Prints only. `BYBIT_LIQ=0` off. |
| Liquidation model | Live | `GET /liq-model`: isolated MMR + 10/20/50 mix + 15m VW entries, inventory-capped at OI/2. Labeled `model — not exchange data`. Not mixed into `/liq-heatmap`. `BYBIT_LIQ_MODEL=0` off. |
| Feed WS relay | Live | `ws://127.0.0.1:43180/ws` — ticker (1s), confirmed kline, liq bins (1s; quiet +1 window; same-side burst now). `BYBIT_RELAY=0` off. |
| Historical kline backfill | Live | `bun run backfill` — REST failover or JSON/CSV dump into SQLite; no WS |
| Snapshot brief | Live | `bun run brief` / `GET /brief` — one local JSON (ticker + 15/60/240) for Minh |
| HTF map | Live | `bun run map` / `GET /map` — ticker + 4H/1H (+ daily if backfilled) + `klineLag` (60/240). No query = watchlist (cap 10). No 15m, no S/D, no bias. `/brief` unchanged. |
| Zone suggest | Live | `bun run zones` / `GET /zones` — candidate zone-cards from local 4H/1H klines. Suggest-only. Does not arm/open/limit. `/brief-pack.zones` is the accepted paper ledger, not this list. |
| Zone ledger | Live | `paper zone accept ZONEID|FILE.json` / `POST /paper/zones` (`zoneId` looks up `GET /zones`, or a full card). Cap 2 accepted/symbol. Expires on `expiryBars`. `paper zone reject`. No auto-arm of suggestions. |
| Proximity ARM | Live | Tick rests post-only OCO when last is in the proximal band of an **accepted** card **and** the last confirmed 15m closes with the zone (still in proximal→entry). Forming/opposite → wait, no reject. `PAPER_PROXIMITY_ARM=0` / `PAPER_CONFIRM_15=0` off. No chase through entry. |
| LTF confirm | Live | `bun run confirm` / `GET /confirm` — ticker + 20×15m (scalp: 5). Optional scalp after HTF is armed. EVENT itself is OCO/tick (`/paper/event`). |
| MAP close | Live | Confirmed 1H/4H → `map-latest.json` + optional webhook. 4H auto-accepts `/zones` via MAP_ACCEPT pick then agent policy (`MAP_ACCEPT=0` off = no copy; `AGENT_MAP=0` = policy no-op, old copy still runs). Family paper score ranks before the per-symbol cap when history exists. No auto-arm. `MAP_CLOSE=0` off. |
| MAP policy agent | Live | `src/agent/` — 4H HH/HL=bull, LH/LL=bear. `quantVeto`: cascade + crowded at accept, ARM, and pending fill; opposing OI add and opposing CVD (`/map.flow`) are accept-only (ARM / rest treat zone fill as the add). `AGENT_QUANT=0` off. Paper-only. |
| EVENT desk | Live | `bun run paper event` / `GET /paper/event` — pending OCO + alerts + accepted zones. Bound pending dies with the zone (expire / deep / HTF). Do not poll `/confirm`. |
| Paper week | Live | `bun run paper week` / `GET /paper/week` — 7-day metrics + standing ledger + funnel.accepted + `review.families` scores. |
| Brief data pack | Live | `bun run brief-pack` / `GET /brief-pack` — tickers + kline lag + `gates` + paper desk + accepted ledger zones. Additive. No auto-arm. |
| Chart / depth / heatmap views | Live | `GET /chart` stitches kline OHLCV; `GET /depth` is the live L50 ladder (watchlist); `GET /heatmap` grids snapshots (+ live book); `GET /market` is one payload. No browser UI. |
| Paper trading | Live | `src/paper/` — virtual USDT ledger sized like Bybit linear (lot/tick/notional), 1–10% risk, MTF tags, Phase 2 fees/funding/multi-TP/leverage, isolated or cross. Phase 3: price alerts, GTC limit pending (post-only default), daemon tick evaluates alerts/limits/SL-TP. Taker market / close / `--cross` immediate walks live L50 (`GET /depth`); resting limit and SL/TP stay 0-slip. `PAPER_SLIPPAGE=0` off. CLI + `127.0.0.1:43181`. No keys, no real orders. See [paper-trading.md](paper-trading.md). |
| Paper alerts | Live | `bun run paper alert set SYMBOL --above|--below PRICE`. Fire-once. Log + `paper_events`; optional Telegram/webhook via `PAPER_NOTIFY`. No chat spam. |
| Paper limit entry | Live | `bun run paper limit … --price`. Rests until last prints through; fill at the limit (maker). `--cross` immediate takes L50 up to the limit (taker). Default post-only + OCO (invalidation cancels pending before fill). |
| SQLite storage | Live | Shared `src/sqlite.ts`: 4 MiB cache, no mmap, WAL ≤8 MiB. Prune PASSIVE then TRUNCATE (skip if busy). VACUUM when freelist ≥15%. |
| Paper event notify | Live | Optional `PAPER_NOTIFY=telegram|webhook` on `alert.fired` / `order.filled` / `order.invalidated` / `position.closed`. Default log. No PnL spam. |
| Paper replay | Live | `bun run paper replay` / `replay-batch FILE.json` — walk local klines through limit/OCO/fee/funding. Slippage 0. Same-bar TP after fill skipped. Separate `*-replay.sqlite`. No auto S/D. |
| Paper replay-map | Live | `bun run paper replay-map SYMBOL --from --to` — walk confirmed 4H detect → MAP policy → 15m ARM/OCO. No future bars. Quant tape **as-of** from local OI/funding/flow/liq (`quant: "asof"`); missing rows stay null (`"missing"`). Slippage 0. Separate `*-replay-map.sqlite`. |
| Paper operator surface | Live | `paper status` / `paper event` / `paper arm` / `paper day` / `paper week` — desk, OCO event, limit+alert, UTC session, 7-day funnel. |
| Paper entry kill-switch | Live | New `paper open` / `paper limit` / `POST /paper/positions` / `POST /paper/orders` / `paper arm` reject when `GET /health` WS is down (`feed_unhealthy`) or `klineLag.ok=false` (`kline_lag`). `/brief-pack` `gates: { tradingAllowed, reasons }`. Does not auto-close opens. No extra mid-range alerts. |
| Paper metrics | Live | SQLite `paper_events` + closed positions. `GET /paper/metrics?days=N` / `bun run paper metrics --days N`. Win rate, avg RR, no_fill%, funnel (detected→accepted→armed→touched→filled/cancelled→exited). `cancelCodes` splits noFill into `never_touched` vs `ops_cancel`; submit-time `kline_lag` / `feed_unhealthy` / `rr_below_min` increment `gates_block` / `rr_fail`. Bound pending tags `deep_mitigate` / `htf_break` / `expired` when the ledger card dies. `byFamily` / `score` rank MAP accept from 7-day paper stats (`PAPER_ZONE_SCORE=0` off). Optional `zoneId` on open/limit/arm. `/zones` does not auto-arm. |
| Orderbook snapshot gate | Live | Clear RAM on connect; ignore deltas until snapshot/`u=1` |
| Subscribe + REST retry | Live | Chunked subscribe (10) + exponential retry |
| CI | Live | GitHub Actions: `bun` typecheck + test on `main` and PRs. No keys, no daemon, no live deploy. See [ci.md](ci.md). |

## Explicitly not in this repo

| Item | Why |
| --- | --- |
| Trading / private Bybit topics | Public linear market data only. No API keys. |
| Live orders / paper→live bridge | Forbidden. Paper refuses to start if Bybit key env vars are set. |
| Browser dashboard | No operator UI. |
| Timer scans / ICT-as-signal | MAP is 4H close. ICT is optional confirm, not a detector. |

## Docs

| Doc | Purpose |
| --- | --- |
| [http.md](http.md) | HTTP API (`:43180` feed, `:43181` paper) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process + layers |
| [exchanges/BB.md](exchanges/BB.md) | Bybit tracker feature |
| [paper-trading.md](paper-trading.md) | Paper spec (risk, fees, OCO, replay) |
| [operator.md](operator.md) | MAP / ARM / EVENT. EVENT is OCO, not `/confirm` |
| [ci.md](ci.md) | Actions gate + host restart |
