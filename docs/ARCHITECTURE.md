# AlgoTerminal — Architecture

**Status:** v1.0 (pre-implementation)
**Reads with:** `DATA_SCHEMA.md` (what the numbers mean), `API_SPEC.md` (the wire contract), `CONNECTOR_GUIDE.md` (how to extend), `DEPLOYMENT.md` (how to ship it)

---

## 1. Design constraints that drive every decision below

1. **The payment gate must sit in front of everything paid, and must be the only way in.** Judging criterion #2 is "x402 is core to the payment flow, not bolted on." An API-key bypass would fail it. There is no bypass.
2. **A $0.005 call must be profitable.** That forbids a synchronous upstream fetch on the hot path. The cache is not an optimization; it is the business model.
3. **Upstream sources are heterogeneous and partly hostile.** Tinyman and Pact serve open JSON; Folks Finance's REST API returns `{"message":"Forbidden"}` to anonymous callers (verified 2026-09-08), so Folks data must come from on-chain application state. The architecture must make "this source is a REST API" and "this source is on-chain state" indistinguishable to everything above the connector.
4. **A stale number must never masquerade as a fresh one.** Freshness and confidence are part of the response contract, not logging.
5. **Adding protocol #4 must not touch anything but one new file plus a registry line.**

---

## 2. Component map

```
                    ┌──────────────────────────────────────────────────┐
   Agent / bot  ───► │  Edge (Railway HTTPS, Hono on Node 22)           │
   (x402 client)     │                                                  │
                    │  ┌────────────────────────────────────────────┐  │
                    │  │ FREE ROUTES (no payment gate)              │  │
                    │  │  /health  /catalog  /openapi.json          │  │
                    │  │  /llms.txt  /methodology  /                │  │
                    │  └────────────────────────────────────────────┘  │
                    │                                                  │
                    │  ┌────────────────────────────────────────────┐  │
                    │  │ x402 PAYMENT GATE  (@x402/hono + @x402/avm)│  │
                    │  │  • no PAYMENT-SIGNATURE  → 402 + reqs      │  │
                    │  │  • has one → facilitator /verify           │  │
                    │  │  • handler runs                            │  │
                    │  │  • on 2xx → facilitator /settle            │  │
                    │  │  • on 5xx → NO settle (caller not charged) │  │
                    │  └───────────────────┬────────────────────────┘  │
                    └──────────────────────┼───────────────────────────┘
                                           │  (paid, verified)
                    ┌──────────────────────▼───────────────────────────┐
                    │              QUERY LAYER (route handlers)        │
                    │  /metric/{protocol}/{kpi}   /compare    /ask     │
                    └───┬──────────────────┬───────────────────┬───────┘
                        │                  │                   │
                        │                  │        ┌──────────▼─────────┐
                        │                  │        │ SYNTHESIS ENGINE   │
                        │                  │        │ Claude: route Q →  │
                        │                  │        │ KPI set → narrate  │
                        │                  │        │ (haiku-4-5 route,  │
                        │                  │        │  sonnet-5 answer)  │
                        │                  │        └──────────┬─────────┘
                        ▼                  ▼                   ▼
                    ┌──────────────────────────────────────────────────┐
                    │        STANDARDIZATION LAYER (the core IP)       │
                    │  raw connector output ──► KpiFact                │
                    │  {metric, protocol, value, unit, timestamp,      │
                    │   source, confidence, ...}                       │
                    │  • unit + decimals normalization                 │
                    │  • USD conversion via price service              │
                    │  • cross-type KPI definitions (DEX vs lending)   │
                    │  • confidence scoring                            │
                    │  • methodology_version stamping                  │
                    └──────────────────────┬───────────────────────────┘
                                           │
                    ┌──────────────────────▼───────────────────────────┐
                    │      CACHE / COST LAYER (read-through)           │
                    │  L0: in-process LRU (60s)                        │
                    │  L1: Redis (per-KPI TTL, see §6)                 │
                    │  L2: Postgres last-known-good (stale fallback)   │
                    └──────────────────────┬───────────────────────────┘
                                           │ miss
                    ┌──────────────────────▼───────────────────────────┐
                    │            CONNECTOR REGISTRY                    │
                    │  Map<protocolId, Connector>                      │
                    │  each: capabilities() + fetchRaw() + toFacts()   │
                    └───┬───────────┬───────────┬──────────┬───────────┘
                        │           │           │          │
                   ┌────▼───┐  ┌────▼───┐  ┌────▼────┐ ┌───▼────────┐
                   │Tinyman │  │ Pact   │  │ Folks   │ │ Price svc  │
                   │REST    │  │ REST   │  │ on-chain│ │ (Tinyman/  │
                   │analytics│ │api.pact│  │ via     │ │  Pact USD  │
                   │        │  │  .fi   │  │ algod   │ │  + Vestige)│
                   └────┬───┘  └────┬───┘  └────┬────┘ └───┬────────┘
                        └───────────┴───────────┴──────────┘
                                    │
                        ┌───────────▼────────────┐
                        │  PUBLIC DATA SOURCES   │
                        │  mainnet.analytics.    │
                        │    tinyman.org         │
                        │  api.pact.fi           │
                        │  mainnet-api.4160.     │
                        │    nodely.dev (algod)  │
                        │  mainnet-idx.4160.     │
                        │    nodely.dev (indexer)│
                        │  api.llama.fi (x-check)│
                        └────────────────────────┘

  SIDE PROCESSES (same container, separate scheduler):
   • Refresher   — every 60s, re-fetch the hot KPI set; keeps cache warm so the
                   paid path is almost always an L0/L1 hit
   • Snapshotter — every 15min, write every computed KpiFact to Postgres
                   (history for a future /history route + stale fallback)
   • Ledger      — on every settle, write {txid, payer, amount, route, ts}
```

---

## 3. Request flow: the paid path, end to end

`GET /metric/tinyman/fee_apr` from an agent with no payment header:

```
1. Agent → GET /metric/tinyman/fee_apr
2. Gate: no PAYMENT-SIGNATURE header.
   → 402 Payment Required
     PAYMENT-REQUIRED: base64({
       x402Version: 2,
       accepts: [{
         scheme: "exact",
         network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
         asset: "31566704",
         amount: "5000",                    // 0.005 USDC, 6 decimals
         payTo: "<ALGOTERMINAL_PAYTO>",
         maxTimeoutSeconds: 60,
         extra: { decimals: 6, feePayer: "<GOPLAUSIBLE_FEE_PAYER>" }
       }],
       ...Bazaar discovery block (see §5.3)
     })
   Body: JSON description of what the caller would get, so an agent can decide.

3. Agent builds an atomic group:
     txn[0] unsigned fee-payer txn (0 µALGO self-payment, FlatFee, fee ≥ 2000,
            note "x402-fee-payer") — facilitator signs this
     txn[1] signed ASA transfer, 5000 units of ASA 31566704 → payTo
   Sends payload { paymentGroup: [b64, b64], paymentIndex: 1 }
   in PAYMENT-SIGNATURE (v2) / X-PAYMENT (v1 compat).

4. Gate → POST facilitator.goplausible.xyz/verify
   Checks: scheme, network, asset, amount ≥ required, payTo match, not expired,
           group well-formed. Rejects → 402 with the failure reason.

5. Gate → handler.  Handler → cache → (hit) KpiFact.

6. Handler returns 200 with the KpiFact envelope.

7. Gate → POST facilitator.goplausible.xyz/settle
   Facilitator signs the fee-payer txn and submits the group. ~3.3s finality.
   → PAYMENT-RESPONSE header (base64) with txid + success flag, echoed to caller.
   → Ledger row written.

8. If the handler had thrown or the upstream had failed with no usable fallback,
   step 7 is SKIPPED and we return 5xx. The caller is never charged for an error.
```

**Settle-after-success is the single most important ordering decision here.** Verify before work (so we don't do unpaid work), settle after success (so we don't take money for a failure). It also makes the leaderboard number honest: settled volume equals successfully-served requests.

---

## 4. Component detail

### 4.1 x402 payment gate

- Packages: `@x402/core`, `@x402/avm`, `@x402/hono`, `@x402/extensions`, all pinned to exactly `2.25.0` (`DEPLOYMENT.md` §1.1). Python alternative `x402-avm[fastapi]` exists; we go TypeScript (§7).
- Middleware: `src/gate/middleware.ts`, built on the library's `x402HTTPResourceServer` and a `HTTPFacilitatorClient` pointed at `https://facilitator.goplausible.xyz`.

  **This was `paymentMiddlewareFromConfig` in the pre-implementation draft, and changed at build step 6.** The packaged Hono middleware implements the same verify/handler/settle order, but three behaviours this document specifies are unreachable through it, and they are the three that matter most:

  - **Fail closed.** An unreachable `/verify` produces a bare 502 from the packaged middleware, not the 503 + `Retry-After: 5` §5.2 requires. Worse, `HTTPFacilitatorClient.verify` raises a plain `TypeError` from `fetch` when the host is unreachable, and `x402HTTPResourceServer` converts anything that is not a `FacilitatorResponseError` into a **402** — so an outage would present to an agent as "your payment was rejected", sending it into a re-sign loop against a service that is down and hiding the outage from us inside an ordinary-looking 402 count. `src/gate/facilitator.ts` wraps the client so a transport failure is distinguishable from a verdict.
  - **Do not retract a delivered response.** On a settle failure the packaged middleware discards the handler's 200 and returns a 402. §5.2 says the opposite, and says why.
  - **409 `payment_replayed`** (`API_SPEC.md` §2.4) has no hook at all.

  Everything that is protocol rather than policy still comes from the library: building and encoding the requirements, matching routes, decoding the payment header, calling verify and settle, and the settlement headers. What is written out is the sequencing and the error contract — the parts `API_SPEC.md` §2 specifies and the library leaves to the resource server.
- One `RouteConfig` per priced route pattern. `/ask` and `/compare` use a **`DynamicPrice` function**, because their price depends on the request (number of protocols compared; whether synthesis ran). Dynamic pricing is a first-class `PaymentOption.price` type — we are not inventing a mechanism.
- Route → price table lives in one module (`src/pricing.ts`) and is the single source of truth for both the middleware config and the `/catalog` response, so the advertised price can never drift from the charged price.
- **Idempotency:** a settled payment's txid is recorded. A replayed `PAYMENT-SIGNATURE` is rejected by the facilitator (the group is already committed); we additionally reject a duplicate txid at the ledger to keep our own accounting clean. Our check is a read of `payments.payment_txid` — the id of the caller's own signed payment transaction, derived from the header **before** verify, so a replay costs one indexed lookup rather than a facilitator round-trip and a cache read. It is defence in depth, not the authoritative double-spend guard: two simultaneous replays both pass the read, and the chain is what stops the second.

### 4.2 Query layer

Thin. Parses and validates params (zod), resolves protocol + KPI against the registry's capability matrix, calls the standardization layer, shapes the envelope. It contains **no** protocol knowledge and **no** arithmetic. If a handler ever needs an `if (protocol === 'folks')`, that logic belongs in a connector.

`/metric` supports `?fresh=true`, which bypasses L0/L1 and forces an upstream fetch. This is priced higher ($0.02–0.03) because it costs us an upstream round-trip and is the honest way to sell recency instead of pretending everything is real-time.

### 4.3 Standardization layer

The core IP. Input: connector-native raw records. Output: `KpiFact[]`. Responsibilities, in order:

1. **Decimals + units** — every ASA amount divided by `10^decimals`; every rate expressed as a decimal fraction (0.0369), never a percent string.
2. **USD conversion** — via the price service, with the price's own confidence multiplied into the fact's confidence.
3. **KPI definition application** — the cross-type accounting policy from `DATA_SCHEMA.md` §3. This is where "borrower interest" and "swap fees" both become `gross_fees`.
4. **Aggregation** — pool-level → protocol-level, with explicit handling of double-counting (a Tinyman V1.1 pool and its V2 successor are distinct venues, not the same TVL counted twice).
5. **Confidence scoring** — `DATA_SCHEMA.md` §5.
6. **Stamping** — `methodology_version`, `source[]`, `as_of`, `is_estimated`.

The layer is pure: same inputs → same outputs, no I/O. That makes it unit-testable with recorded fixtures, which matters because a silent arithmetic regression in an accounting policy is the worst bug this product can have.

### 4.4 Connector registry

```ts
const registry = new Map<ProtocolId, Connector>([
  ['tinyman', tinymanConnector],
  ['pact',    pactConnector],
  ['folks',   folksConnector],
]);
```

Registration is one line. Discovery (`/catalog`) is generated by iterating the registry and calling `capabilities()`, so a protocol/KPI pair is advertised **only if a connector claims it**. We can never advertise a KPI we cannot compute. Full interface in `CONNECTOR_GUIDE.md`.

### 4.5 Cache / cost layer

Read-through, three tiers:

| Tier | Store | TTL | Purpose |
|---|---|---|---|
| L0 | In-process LRU (`lru-cache`), ~2k entries | 60 s | Absorbs bursts; sub-ms; survives Redis blips |
| L1 | Redis (Railway) | per-KPI, §6 | Shared across instances; the real hit source |
| L2 | Postgres `kpi_snapshots` | unbounded | Last-known-good when upstream is down |

Key: `kpi:v{methodology_version}:{protocol}:{kpi}:{paramsHash}`.

**Stampede protection:** a Redis `SETNX` lock per key on miss; losers wait up to 2 s for the winner's write, then fall back to L2. Without this, a cold key plus 50 concurrent bots equals 50 upstream calls and a rate-limit ban.

**Stale-while-revalidate:** if L1 is expired but present, serve it immediately with `stale: true` and `confidence` reduced (§5 of `DATA_SCHEMA.md`), and trigger an async refresh. An agent gets a fast, correctly-labeled answer instead of a timeout.

**L2 fallback is always labeled.** `stale: true`, `as_of` set to the snapshot time, `confidence` floored at 0.4. We never serve a stale number that looks fresh.

### 4.6 Refresher (why the cache is warm, not lucky)

A scheduler recomputes the **hot set**: every `(protocol, kpi)` pair that has been requested in the last 6 hours, plus the full matrix for the three launch protocols (currently ~40 facts).

Effect: the paid path is almost always an L0/L1 hit even for the *first* caller of the minute. The 70% hit-rate target in `PRD.md` §5.1 is a floor, not a hope — the refresher, not caller luck, is what produces it.

**Two cycles, not one.** This section originally specified a single 60-second scheduler. Measured against the real Tinyman connector at build step 5, a full refresh floors at **~65 s** — above its own interval. A single 60 s cycle can therefore never complete inside its period, and the honest implementations of that are a queue that grows without bound or a skip that means the cycle really runs every 130 s while the logs claim 60.

The measurement that resolves it: a TVL-scoped refresh takes **13–14 s** and produces a byte-identical TVL. The whole remaining ~50 s is the per-pool analytics lookups the 24 h flow KPIs need — and those have a 600 s TTL (§6), so refreshing them every 60 s was buying nothing.

| Cycle | Interval | KPIs | Measured |
|---|---|---|---|
| fast | 60 s | registry TTL ≤ 300 s (`tvl`, `total_borrows`, the rate models) | ~13–30 s |
| slow | 600 s | registry TTL > 300 s (the 24 h flows, `active_users_24h`, `pool_count`) | ~65–210 s |

Membership is derived from the §6 registry TTLs, not from a hardcoded list of KPI names: a KPI added with a 120 s TTL joins the fast cycle by definition. `FetchOpts.kpis` is what makes the split cheap — that field exists precisely so a connector can skip fetches a scoped refresh does not need.

**A cycle never overlaps itself.** If the previous run is still going, the next is skipped and logged, never queued: a backlog that never drains means the work that finally runs is stale by however long the queue has grown. The guard is per cycle, so a slow flow refresh never blocks the fast TVL one.

**Cycle timings are published on `/health`** (`cache.refresher`), `last_duration_ms` beside `interval_s`, with counters for skipped runs and overruns. A cycle drifting past its interval must be a number an operator can read, not something inferred from log timestamps.

**The stampede lock is held on the fetch group, not the fact key.** §4.5's "lock per key" closes the stampede for one KPI and leaves open the one that hurts: `fetchRaw` is per-protocol, so a cold start on 11 Tinyman KPIs is 11 *uncontended* locks and 11 concurrent full enumerations. Measured on a live soak, that kept the fast cycle at 257 s against its 60 s interval and the hit rate at 0.13. Locking `(protocol, basis, TTL class)` collapses those to one fetch per class; losers still wait on their own fact key in L1. A cold `/metric` miss fetches its whole TTL class for the same reason, so a caller's fetch warms exactly what the refresher would have warmed a moment later.

### 4.7 Synthesis engine (`/ask`)

Two Claude calls, deliberately split:

1. **Route** (`claude-haiku-4-5`): natural-language question → structured plan `{protocols[], kpis[], comparison_type}`, constrained by a tool-use schema and validated against the registry capability matrix. Cheap, fast, and it *cannot* invent a protocol we don't cover — an unroutable question returns 422 before any expensive call, and the caller is not charged.
2. **Synthesize** (`claude-sonnet-5`): fetch the planned KPIs through the normal cached path, then answer **strictly from that JSON**, with every claim citing a `KpiFact`.

System prompt hard rules: no forecasting, no advice, no numbers absent from the provided facts, and explicit acknowledgement of any fact with `confidence < 0.7`. The structured `facts[]` array is returned alongside the prose, so a downstream agent can ignore our narrative and read the numbers — the prose is a convenience, never the only payload.

---

## 5. x402 + GoPlausible integration detail

### 5.1 Verified constants (checked against GoPlausible docs, 2026-09-08)

| Thing | Value |
|---|---|
| Facilitator base | `https://facilitator.goplausible.xyz` |
| Endpoints | `/verify`, `/settle`, `/supported`, `/docs` |
| Algorand MainNet CAIP-2 | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Algorand TestNet CAIP-2 | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| USDC MainNet ASA | `31566704` (6 decimals) |
| USDC TestNet ASA | `10458941` (6 decimals) |
| Scheme | `exact` |
| x402 version | `2` (v1 network ids `algorand-mainnet`/`algorand-testnet` still map for compat) |
| Max atomic group | 16 txns |
| Fee-payer txn | self-payment, 0 µALGO, `FlatFee: true`, fee ≥ 2000 µALGO, note `x402-fee-payer`, left unsigned for the facilitator |
| Finality | ~3.3 s |
| Sponsor address | `ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA` (same on both networks) |

These live in `src/config/x402.ts` as named constants. No magic strings in route configs — with one deliberate exception: **the fee-payer address is not one of them.** It is read from the facilitator's own `/supported` response at runtime and injected into `extra.feePayer` by the AVM scheme. The only source that can be right about whose address is sponsoring the fee is the facilitator that will sign with it; the value above is recorded for review, not for configuration.

`@x402/avm` uses **truncated** 32-character CAIP-2 ids internally, per the Algorand namespace profile. The facilitator advertises the full genesis hash, which is the form above and the form we register and put on the wire. See `DEPLOYMENT.md` §1.1.

### 5.2 Failure handling

| Failure | Response |
|---|---|
| `/verify` returns invalid | 402 with `PAYMENT-REQUIRED` re-issued and the facilitator's reason in the body |
| `/verify` unreachable | 503, `Retry-After: 5`. **We do not fail open.** Serving unpaid data because our payment provider blinked is the one bug that would invalidate the whole entry. |
| Handler throws | 5xx, **no settle**. Caller not charged. |
| `/settle` fails after a successful handler | We have already returned the data. Log at ERROR, write a `settle_failed` ledger row with the payment payload for reconciliation, and surface it in `/health`. We eat the loss rather than retracting a delivered response — but we must *know* it happened, because an unnoticed settle-failure rate is silent revenue loss and a leaderboard discrepancy. |
| Facilitator degraded (>5% settle failures over 5 min) | `/health` goes `degraded`; alert. No automatic behavior change. |

### 5.3 Discovery / Bazaar

Per the Algorand best-practices guide, cataloging is automatic once a real mainnet payment lands — there is no manual registration. What we control is the *quality* of what gets indexed:

- **Bazaar discovery declaration** inside the 402 response: endpoint description, input example, output example, tag `x402-global-challenge`.
- **OpenGraph metadata** on the landing page (title, description, logo, banner), re-fetched daily by the enrichment engine.
- **`/llms.txt`** per llmstxt.org, written for an agent deciding whether to call us: what we cover, the exact schema, prices per route, and a copy-pasteable example.
- The landing page is built crawler-first, human-second.

Details and copy in `DEPLOYMENT.md` §6.

---

## 6. Cache TTL policy (with justification)

TTL is a revenue/accuracy tradeoff, so it is set per-KPI by how fast the underlying number actually moves — not one global number.

| KPI class | TTL | Why |
|---|---|---|
| `tvl`, `total_deposits`, `total_borrows` | **300 s (5 min)** | Moves continuously but rarely >1% in 5 min. Under 5 min we pay upstream constantly for noise; over 15 min a rebalancing agent could act on a materially wrong number. |
| `volume_24h`, `gross_fees_24h`, `protocol_revenue_24h` | **600 s (10 min)** | Trailing 24h windows; a 10-minute-old value differs from live by well under 1% of the window. |
| `utilization`, `supply_apr`, `borrow_apr`, `net_apy` | **120 s (2 min)** | Rate-model outputs that step on every borrow/repay. Risk agents (`PRD.md` §3.5) act on these; staleness here has a real cost. |
| `active_users_24h` | **900 s (15 min)** | Expensive (indexer aggregation) and slow-moving by construction. |
| Asset prices | **60 s** | Feeds everything else; cheap; a stale price silently corrupts every USD-denominated KPI. |
| `/compare` results | **not cached as a unit** | Composed from already-cached component facts. Caching the composite would double the staleness surface for no gain. |
| `/ask` results | **300 s on a normalized question hash** | Many agents ask near-identical questions. Only cached when every underlying fact was itself a cache hit, so we never serve a synthesized narrative built on data older than the narrative claims. |

`?fresh=true` bypasses L0/L1 for a higher price. Every response carries `as_of` and `cache: "hit" | "miss" | "stale"`, so a caller can always see exactly what it got.

---

## 7. Tech stack recommendation

| Layer | Choice | Justification | Runner-up and why not |
|---|---|---|---|
| Language | **TypeScript (Node 22 LTS)** | The x402 AVM tooling is TS-first: `@x402/core`, `@x402/avm`, `@x402/hono`, plus `algosdk` and `@folks-finance/algorand-sdk` (the only maintained way to read Folks state, given the gated REST API). Python's `x402-avm` exists but the Folks SDK does not. | Python — loses the Folks SDK, which is the hardest connector |
| HTTP framework | **Hono** | `@x402/hono` is a first-party middleware; Hono is tiny, fast, Web-standard, and portable to an edge runtime later without a rewrite. | Express — also first-party (`@x402/express`), heavier, no edge path. Either works; pick Hono and don't relitigate. |
| Hosting | **Railway** | Long-lived Node process (the refresher needs one), managed Redis and Postgres as siblings on a private network, HTTPS + custom domain out of the box, and this repo already has Railway tooling wired up. Fixed cost ~$20/mo keeps `PRD.md` §5.3 true. | Cloudflare Workers — great latency, but no long-lived scheduler process and the Folks/algosdk path is awkward. Vercel — serverless cold starts on a latency-sensitive paid route. |
| Cache | **Redis (Railway)** | TTL semantics, `SETNX` stampede lock, shared across instances. All three needed. | In-process only — breaks the moment we run 2 instances |
| Database | **Postgres (Railway)** | Two jobs: the payment ledger (must be durable and auditable — it is our leaderboard reconciliation record) and `kpi_snapshots` (stale fallback today, `/history` tomorrow). | SQLite — no good story for multi-instance or durability across redeploys |
| Validation | **zod** | Runtime validation at both edges: inbound params and, critically, *outbound upstream JSON*. Upstream schema drift is the likeliest production failure and must surface as a typed connector error, not a `NaN` in a paid response. | Hand-rolled checks — guaranteed to rot |
| LLM | **Claude — `claude-haiku-4-5` (routing), `claude-sonnet-5` (synthesis)** | Split keeps `/ask` gross margin ~80%. Tool-use schema constrains routing to the real capability matrix. | Single Sonnet call — simpler, ~2× cost, and no cheap guard against unroutable questions |
| Observability | **Structured JSON logs + `/health`** | Must expose: cache hit rate, per-connector upstream success, settle-failure count, payer concentration. The last one is a `PRD.md` §7 compliance control, not a vanity metric. | A hosted APM — overkill at this scale |

### Data source endpoints (all verified live, 2026-09-08)

| Source | Endpoint | Status |
|---|---|---|
| Tinyman | `https://mainnet.analytics.tinyman.org/api/v1/pools/` (list) and `/api/v1/pools/{address}` (single, incl. V2) | ✅ open, no key |
| Pact | `https://api.pact.fi/api/pools` | ✅ open, no key |
| Folks Finance | `https://api.folks.finance/*` | ❌ **403 Forbidden** to anonymous callers — use on-chain path |
| Algod | `https://mainnet-api.4160.nodely.dev/v2/...` | ✅ free tier |
| Indexer | `https://mainnet-idx.4160.nodely.dev/v2/...` | ✅ free tier |
| Prices | Tinyman/Pact `*_in_usd` fields; `https://api.vestigelabs.org` as fallback | ✅ open |
| Cross-check | `https://api.llama.fi/protocol/{slug}` | ✅ open — used only to compute a divergence flag, never as a primary value |

---

## 8. Repository layout

```
src/
  index.ts                 # Hono app, route registration, middleware order
  pricing.ts               # SINGLE source of truth: route → price
  config/
    x402.ts                # facilitator URL, CAIP-2 ids, ASA ids, fee-payer
    env.ts                 # zod-validated env
  gate/
    middleware.ts          # x402 route configs, dynamic pricers
    ledger.ts              # settle → Postgres; duplicate-txid guard
  routes/
    metric.ts  compare.ts  ask.ts
    catalog.ts  health.ts  llms.ts  openapi.ts
  standardize/
    schema.ts              # KpiFact type + zod
    kpis.ts                # KPI registry: id, unit, class, TTL
    definitions.ts         # DATA_SCHEMA.md §3 formulas, as pure functions
    confidence.ts
    aggregate.ts
  connectors/
    types.ts               # the Connector interface (CONNECTOR_GUIDE.md)
    registry.ts
    tinyman/  pact/  folks/
    price/
  cache/
    index.ts               # the read-through path: L0 -> L1 -> lock -> L2
    keys.ts  types.ts      # kpi:v{version}:{protocol}:{kpi}:{paramsHash}
    lru.ts  redis.ts       # L0, L1 (the lock lives on the Redis client)
    snapshots.ts           # L2, over kpi_snapshots
    cycles.ts  hotset.ts   # TTL classes; the §4.6 hot set
    metrics.ts  testing.ts
  db/
    pool.ts  migrate.ts    # migrations/*.sql, forward-only
  facts/
    compute.ts             # fetchRaw -> resolve prices -> toFacts, for any connector
  jobs/
    refresher.ts  snapshotter.ts
  llm/
    router.ts  synthesizer.ts  prompts.ts
docs/                      # these six documents
test/
  fixtures/                # recorded upstream payloads, per connector
  standardize/             # golden-file tests on the accounting policy
public/                    # landing page + OpenGraph assets
```

---

## 9. Build order

Each step ends with something runnable and testable. Do not proceed on a red step.

1. Skeleton: Hono, env validation, `/health`. Deployed to Railway with HTTPS.
2. `KpiFact` schema + KPI registry (`DATA_SCHEMA.md` §2). Types only.
3. `Connector` interface + registry + `/catalog` generated from capabilities.
4. Tinyman connector + standardization for its KPIs. Fixture tests.
5. Cache layer (L0/L1/L2, fetch-group lock, stale-while-revalidate) + refresher + snapshotter. Verify hit rate locally. **Done** — measured on live mainnet: cold 26 s, warm L0 p95 0.2 ms, warm L1 p95 0.7 ms against the 250 ms p95 target.
6. x402 gate on `/metric`, **TestNet**. Prove the full 402 → sign → verify → settle loop end to end. **Done** — `src/gate/`, `payments` (migration 002), `GET /metric/{protocol}/{kpi}` and `/llms.txt`. The cold-key stampede policy is decided and published (`API_SPEC.md` §3.1.1).
7. Pact connector.
8. Folks connector (hardest — on-chain state; budget the most time here).
9. `/compare`.
10. `/ask` (router + synthesizer).
11. Ledger (the refresher and snapshotter moved forward to step 5: L2 is only a real fallback if something has been writing to it all along).
12. Landing page, OpenGraph, `llms.txt`, Bazaar declaration.
13. MainNet cutover (`DEPLOYMENT.md`), one verification payment, confirm Bazaar + leaderboard.
