# Live execution — Minh (明)

**Staged path from the paper-only MVP to a live desk, with a falsifiable exit criterion per stage.** Shipped so far: Stage 1 (boundary encoded in tests — `test/exec/boundary.test.ts`, `src/exec-mode.ts`) and Stage 2 (read-only testnet skeleton — `src/exec/` with the official SDK behind `ExecClient`, `bun run exec` on `:43183`, keys from credential files only, GET-only HTTP). Stage 0 is operator work (host retention vars, testnet account). **No order placement exists** — Stage 3 and beyond are plan. Paper stays the default forever; live is opt-in per process.

Read with [ROADMAP](ROADMAP.md) (locks), [paper-trading.md](paper-trading.md) (paper spec, unchanged by this plan), [ARCHITECTURE](ARCHITECTURE.md) (process boundaries).

## Boundary

The paper-only lock at [ROADMAP](ROADMAP.md) line 7 is replaced, not deleted. The replacement is a **boundary** lock:

> Keys and order placement exist only in `src/exec/`. `src/feed`, `src/agent`, `src/paper`, `src/zones`, `src/ta`, `src/features` and `src/live` never mention `/v5/order`, signing, or key env names.

`src/exec/` is a **fourth process** (`bun run exec`, `:43183`, own sqlite), not a module started by [`src/index.ts`](../src/index.ts). That is deliberate: [`test/agent/policy.test.ts`](../test/agent/policy.test.ts) scans `src/index.ts` for the literal `BYBIT_API_KEY`, and [`test/paper/safety.test.ts`](../test/paper/safety.test.ts) scans ~50 source files for `api.bybit.com`, `/v5/order`, `PAPER_LIVE`, `promote`, `private.*websocket`. Keeping exec as a separate process outside those file lists preserves every existing guard instead of deleting it.

Rejected alternative: a shared `ExchangePort` with paper and live adapters behind one interface (the design used by the predecessor `comtammatu/minh-agent`). [paper-trading.md](paper-trading.md) line 514 already forbids it — *"Extracting a 'broker interface' that live later implements is out of scope and discouraged."* It is also the option that would invalidate the source-scan tests above, because paper would become transitively connected to order placement.

## Invariants that never relax

Removing paper-only does not remove these.

| # | Invariant | Where |
| --- | --- | --- |
| 1 | Key + order placement only in `src/exec/` | new boundary lock |
| 2 | LLM / MCP / UI is never a command source | [ROADMAP](ROADMAP.md) line 10 |
| 3 | Paper open/close stays ledger math; never calls order code | [paper-trading.md](paper-trading.md) line 514 |
| 4 | Lab and A/B scripts refuse to run when key env is set | [`deploy/replay-map-ab.sh`](../deploy/replay-map-ab.sh) line 16, [`deploy/replay-map-lab.sh`](../deploy/replay-map-lab.sh) line 15, [`deploy/enable-mesh.sh`](../deploy/enable-mesh.sh) line 11 |
| 5 | GitHub Actions never holds Bybit keys | [ci.md](ci.md) line 33 |

Invariant 2 rules out `bybit-exchange/trading-mcp` and `bybit-exchange/skills` in the autonomous path. Both route order placement through an AI assistant; that makes the order path non-deterministic, unreplayable, and turns prompt injection into a money-loss surface. [paper-trading.md](paper-trading.md) line 70 already bans *"Bybit MCP private tools"* — that ban belongs to invariant 2, not to paper-only, so it survives.

Invariant 4 is pinned by [`test/paper/review.test.ts`](../test/paper/review.test.ts) lines 194–207. Keeping the guards keeps that test green.

## Client

`bybit-official-ts-sdk` (repo `bybit-exchange/bybit.js.api`) — official, MIT, one dependency (`axios`), provenance-signed publishes.

Used for: V5 HMAC-SHA256 signing (`X-BAPI-API-KEY` / `TIMESTAMP` / `RECV-WINDOW` / `SIGN` / `SIGN-TYPE: 2`), order create/amend/cancel + batch + pre-check, positions, TP/SL, leverage, wallet balance, margin mode, fee rate, `instruments-info`. Typed error hierarchy separates `auth` from network/timeout/rate-limit. Throws before the network call when a signed endpoint has no keys. `testnet: true` flag; testnet and mainnet keys are separate and a mainnet key fails testnet with `retCode 10003`.

Not provided by the SDK, and therefore ours to build: **WebSocket** (roadmap only — no public or private streams), **automatic retry** (roadmap only).

Wrapped behind an internal `ExecClient` interface so the SDK does not leak past `src/exec/`. Fallback if it proves insufficient: `bybit-api` (community, has WS, used by the predecessor) or hand-rolled signing against `bybit-exchange/api-usage-examples`.

Reuse from [`src/feed/bb/rest.ts`](../src/feed/bb/rest.ts): nothing on the auth path. `RestFetch` (lines 26–34) does not accept a `headers` object at all, and `FAILOVER_STATUS = new Set([401, 403, 404])` (line 36) treats auth-shaped statuses as geo-block and rotates to a fallback host. Correct for a public client; on an order path it turns an expired key into a silent retry against another host. In `src/exec/`, 401 / 403 / `retCode 10003` are a hard stop.

## Stages

Order constraints: **Stage 1 before Stage 2** (fence before the animal). **Stage 4 before Stage 7** (crash guard before real money). Others may overlap slightly.

### Stage 0 — Preconditions, no code

| | |
| --- | --- |
| Do | Deploy tape retention (`BYBIT_FLOW_HOURS` / `BYBIT_LIQ_HOURS` = 4320) on the host via `systemctl edit bybit-tracker`. Create the testnet account and key. Note that units in `/etc/systemd/system/` are **copies**, so [`deploy/pull-restart.sh`](../deploy/pull-restart.sh) alone will not apply unit changes. |
| Exit | `systemctl show bybit-tracker -p Environment` lists both vars; the prune line in `journalctl -u bybit-tracker` shows a non-zero `flow=`; a manual signed curl authenticates against testnet; the next nightly walk reports `quantCoverage.flow` above the 0.325% measured on 2026-09-12. |
| Abort if | The host cannot keep ~2× the db size free for `VACUUM` ([`src/feed/bb/db.ts`](../src/feed/bb/db.ts) line 224 triggers at 15% freelist). |

### Stage 1 — Boundary encoded in tests

No live capability is added. This stage only writes down the new invariant and proves the old guards still hold.

| | |
| --- | --- |
| Do | Rewrite the [ROADMAP](ROADMAP.md) line 7 lock as the boundary lock; drop `paper→live` from the line 77 non-goals and add *order placement outside `src/exec/`*. Add `test/exec/boundary.test.ts` reusing the [`test/paper/safety.test.ts`](../test/paper/safety.test.ts) file list, asserting `src/exec/**` is the only tree allowed to contain `/v5/order`, `X-BAPI`, `createHmac`, `BYBIT_API_KEY`. Generalise `assertSeparateDb` ([`src/paper/config.ts`](../src/paper/config.ts) lines 53–59) to four distinct db paths. Add `assertExecMode()` refusing to start unless `EXEC_MODE` is explicitly `testnet` or `mainnet`, with `mainnet` behind a second flag. |
| Exit | `bun run typecheck && bun test` green with the boundary test present and `src/exec/` still empty (assertion holds vacuously). `assertNoApiKeys()` still called at all eight sites. **No existing safety test deleted or relaxed.** |
| Abort if | Making this stage pass requires editing [`test/paper/safety.test.ts`](../test/paper/safety.test.ts). That means the boundary is in the wrong place. |

### Stage 2 — `src/exec/` skeleton, read-only, testnet

**Shipped.** `src/exec/` wraps the SDK behind `ExecClient` (`client.ts`), loads config through `assertExecMode` + credential-file keys with a plaintext-env refusal (`config.ts`), persists the refreshed linear instrument spec with an age guard (`instruments.ts`, default 168h) in its own sqlite (`db.ts`), and serves a GET-only HTTP surface on `:43183` (`http.ts`). Auth-class rejections (401/403/`retCode 10003`) latch the client into a failed state that refuses further signed calls — no retry, no host rotation (proven against a local fake venue in `test/exec/skeleton.test.ts`). Remaining operator-side exit evidence: run it against real testnet keys and check `/exec/health` reports `authenticated: true` with balance matching the testnet UI.

| | |
| --- | --- |
| Do | Add `bybit-official-ts-sdk` (first runtime dependency in repo history) behind `ExecClient`. New process `bun run exec`, `:43183`, `EXEC_DB_PATH`. Read-only: wallet balance, positions, open orders, fee rate, `instruments-info`. Refresh and persist the instrument spec with a staleness guard — [`src/paper/instruments/bybit-linear.json`](../src/paper/instruments/bybit-linear.json) is a static snapshot (`asOf: 2026-09-11`) and a stale spec means wrong lot rounding or venue rejects; paper keeps using the static file. Keys via systemd `LoadCredential=` / `CredentialEncrypted=`, never plaintext `Environment=`. |
| Exit | On testnet: `/exec/health` reports `authenticated: true`, balance matches the testnet UI, the refreshed spec is persisted with a current `asOf`. A test asserts that a wrong key produces an `auth`-class error, stops the process, and issues **no** request to a fallback host. [`deploy/enable-mesh.sh`](../deploy/enable-mesh.sh) still refuses when key env is set — keys live only in the exec unit, never in the shell that enables the mesh. Feed, paper and live dbs untouched; all pre-existing tests green. |
| Abort if | The SDK cannot reach `instruments-info`, or its error hierarchy does not distinguish auth. Re-evaluate the client choice before continuing. |

### Stage 3 — Order lifecycle and idempotency, testnet

| | |
| --- | --- |
| Do | Deterministic `orderLinkId` (cloid) per `(cardId, attempt)`, intent row persisted **before** send. Send-once: write intent → send → record response; on restart, reconcile every pending intent by cloid before anything else. Post-only GTC limit mapping the paper semantics in [`src/paper/watch.ts`](../src/paper/watch.ts) line 39 and [`src/paper/engine.ts`](../src/paper/engine.ts) lines 1667–1689 (`limit_crossed`, `already_invalidated`), plus TP/SL, cancel-by-cloid, amend. Venue rejects are data, not exceptions. Mine the predecessor's `src/execution/bybit-exchange-service.ts` (42 KB) for venue quirks — port the knowledge, not the code. |
| Exit | A scripted testnet sequence (place post-only → amend → cancel → place and fill → place with TP/SL trigger) runs **100 consecutive times** with zero orphan orders and zero duplicate positions. Fault injection: `kill -9` at a random point mid-sequence, **50 times**; after each restart, reconciliation leaves the local ledger matching the venue with zero orphans and zero duplicates. The predecessor's `execution-boundary.contract.test.ts` (18.5 KB) ported and green. |
| Abort if | Reconciliation cannot be made idempotent across `kill -9`. There is no acceptable partial pass. |

Retry policy: never blind-retry a submit. A timeout leaves the order state unknown, and resubmitting is how double positions happen. Query by cloid first. The SDK's missing auto-retry is an advantage here. This is why the predecessor's `ExchangePort` exposes `cancelByCloid` and `getFillAggregateByCloid`.

Run a security review before this stage merges — it is the first stage holding real credentials.

### Stage 4 — Crash guard

Bybit has **no native dead-man switch**. A process that dies while post-only orders are resting leaves them resting indefinitely.

| | |
| --- | --- |
| Do | Port the predecessor's design: exec writes a heartbeat file every 30s including its PID; a separate `exec-watchdog` process calls `cancelAllOpenOrders()` when the file is older than 5 minutes **and** the PID is dead or alive-but-stale. 30s / 5min gives a 10× margin. Keep a `CrashGuardPort { arm, refresh, disarm, status }` abstraction even with one venue, so the state is explicit (`armed` / `disarmed` / `degraded`). |
| Exit | `kill -9` exec with resting orders on testnet → watchdog cancels all within threshold + interval, **5/5** runs. No false positive: a clean shutdown that disarms first results in no cancellation. A hung-but-alive process that stops refreshing still triggers. Watchdog is idempotent across consecutive runs. |
| Abort if | "Dead" cannot be distinguished from "restarting" — that cancels the orders of a healthy process. |

### Stage 5 — Operator controls and risk governor

| | |
| --- | --- |
| Do | Port `OperatorIntent`, keeping `confirm: true` as a **literal type** on `flatten` / `close` / `reduce` so omitting it fails to compile. `flatten` = cancel-all then close-all. Add `pause` / `resume`. Add the risk governor — none of this exists today (repo-wide grep for `flatten`, `deadman`, `reconcil`, `pause` returns zero code matches): max open positions, max daily loss, max notional per order, max total notional; tripping flattens and refuses new entries. Add `EXEC_OBSERVE=1` generalising `PAPER_OBSERVE` ([`src/paper/observe.ts`](../src/paper/observe.ts) lines 10–13) so the exec HTTP surface is GET-only by default. Single-flag kill switch: flatten and halt. Reuse `rejectIfEntryBlocked()` ([`src/paper/gates.ts`](../src/paper/gates.ts) lines 26–36) for `feed_unhealthy` / `kline_lag` — it already has the right semantics, including "does not close existing positions". |
| Exit | Each control exercised on testnet with assertions. The governor trips deterministically at every threshold in tests, not by hand. `EXEC_OBSERVE=1` returns 403 on every non-GET. The kill switch flattens from an open-position state in one invocation, logged. |

### Stage 6 — Decision feed and shadow diff

`src/exec/` never derives strategy. It consumes the same card and ARM events the paper desk and live-shadow consume.

| | |
| --- | --- |
| Do | Reuse the existing webhook seam (the `MAP_CLOSE_WEBHOOK` pattern at [`deploy/bybit-tracker.service`](../deploy/bybit-tracker.service) lines 26–28) — additive, no feed change beyond another target URL. Build the diff harness comparing exec's intended-versus-actual against live-shadow `wouldArm` ([`src/live/plan.ts`](../src/live/plan.ts)) and paper fills. This is what keeping live-shadow as an independent non-trading control group pays for. |
| Exit | Over ≥2 weeks on testnet, exec and live-shadow agree on **≥99% of decisions** (decisions, not fills — testnet liquidity is thin and fills will differ). Every disagreement has a classified cause: timing, data, or bug. Zero "unknown". Zero cases of exec acting without a corresponding shadow decision. |

### Stage 7 — Mainnet canary

| | |
| --- | --- |
| Do | Mainnet key with **trade permission only, withdrawal disabled**, IP-whitelisted to the host. One symbol (BTCUSDT), minimum notional, one open position, hard daily loss cap. `minh-exec.service` stays out of `minh.target` by default and gets its own `enable-exec.sh` with its own guards. |
| Exit | **N = 20 live trades**, each reconciling cleanly (venue position == exec ledger). Zero orphan orders, zero duplicate submits. Watchdog confirmed armed throughout. Drawdown inside the cap. Real slippage measured and compared against `walkBook()` ([`src/paper/slippage.ts`](../src/paper/slippage.ts) lines 60–104) — note the 180d baseline ran with `slippage: "0"`, so that model has never been exercised in the evidence we hold. |

### Stage 8 — Evidence gate before scaling

No work item. Only a criterion, because scaling size on an unestablished edge is the failure mode this plan exists to avoid.

The 2026-09-12 180d one-book baseline: 57 trades (~9.5/month), +24.6% equity, `slippage: "0"`, `quantCoverage.flow` 0.325%, and a realised-RR t-statistic between ~1.3 and ~2.3 depending on how dispersion is estimated. A confirmation *filter* reduces trade count, so forward-validating one is measured in quarters.

| | |
| --- | --- |
| Exit | ≥100 trades (live or paper-forward) with the new gate enabled; edge t-statistic **≥ 2** on that sample; drawdown inside policy throughout; tape retention accrued far enough for flow-based gates to have real data (≈90–180 days after Stage 0). |
| Otherwise | Stay at canary size indefinitely. That is an acceptable outcome, not a failure. |

## Cross-cutting risk

| Risk | Mitigation |
| --- | --- |
| Official SDK is young (0 stars, 2 forks, last push 2026-07-23), no WS, no retry | Wrap behind `ExecClient`; write retry ourselves as idempotent-by-cloid; defer private WS and use `bybit-exchange/api-usage-examples` as reference if latency ever demands it |
| Reconciliation by polling rather than private WS | The strategy is 4H MAP with 15m confirm and post-only GTC entries — not scalping. The predecessor's `getFillAggregateByCloid` is already poll-shaped |
| ~40 doc locations assert paper-only | Update per stage; each stage documents only what now exists. Densest surface is [paper-trading.md](paper-trading.md) (hard-ban table, rules table lines 504–519, acceptance checklists) |
| Four processes on one small host | `minh.target` already carries N units; exec is off by default |
| Effort is concentrated in Stages 3 and 4, not Stage 2 | Do not compress the fault-injection exit criteria; that is the cheapest place to find the most expensive bugs |

## Sources

- Predecessor `comtammatu/minh-agent` — `src/ports/{exchange,crash-guard,operator}.ts`, `src/execution/bybit-exchange-service.ts`, `runtime/heartbeat.ts`, `scripts/bb-watchdog.ts`, `test/execution/execution-boundary.contract.test.ts`, and the `EXECUTION_MODE` / `isBbWatchdogEnabled` gating in `src/config.ts`. Its own verification record for the order-flow work ends `Verdict: WARNING` with strategy edge labelled `[UNCERTAIN]`; having the machinery is not evidence of an edge.
- `bybit-exchange/bybit.js.api` — official TypeScript connector (`bybit-official-ts-sdk`).
- `bybit-exchange/api-usage-examples` — V5 REST and WS reference, used only if private WS is built.
- `bybit-exchange/trading-mcp`, `bybit-exchange/skills` — reviewed and **excluded** from the autonomous path by invariant 2.
- [Bybit V5 WS](https://bybit-exchange.github.io/docs/v5/ws/connect) — already the `Documentation=` target of [`deploy/bybit-tracker.service`](../deploy/bybit-tracker.service).
