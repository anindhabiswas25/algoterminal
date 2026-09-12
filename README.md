# AlgoTerminal

**Standardized financial KPIs for Algorand DeFi, sold per query in USDC over [x402](https://x402.org).**

No API key. No signup. No account. The payment *is* the authentication — an HTTP
request arrives with a signed USDC transfer in a header, the facilitator verifies
it, and the data comes back. One call, about a second, a fraction of a cent.

| | |
|---|---|
| **MainNet API** | <https://api-production-36692.up.railway.app> |
| **TestNet API** (free evaluation) | <https://api-testnet-production-a3ec.up.railway.app> |
| **Agent discovery** | [`/llms.txt`](https://api-production-36692.up.railway.app/llms.txt) · [`/openapi.json`](https://api-production-36692.up.railway.app/openapi.json) · [`/catalog`](https://api-production-36692.up.railway.app/catalog) |
| **Accounting policy** | [`/methodology`](https://api-production-36692.up.railway.app/methodology) |
| **MCP server** | [`mcp/`](mcp/) — `npx algoterminal-mcp` |
| **Runnable clients** | [`examples/`](examples/) — Node and Python |

---

## Table of contents

1. [What this actually sells](#1-what-this-actually-sells)
2. [Coverage](#2-coverage)
3. [The KPI registry](#3-the-kpi-registry)
4. [Every number arrives in one envelope](#4-every-number-arrives-in-one-envelope)
5. [Endpoints and prices](#5-endpoints-and-prices)
6. [Payments: MainNet, TestNet, and the transaction](#6-payments-mainnet-testnet-and-the-transaction)
7. [Quickstart](#7-quickstart)
8. [Architecture](#8-architecture)
9. [The cache is the business model](#9-the-cache-is-the-business-model)
10. [Errors, and what they cost you](#10-errors-and-what-they-cost-you)
11. [Running it locally](#11-running-it-locally)
12. [Configuration](#12-configuration)
13. [Deployment](#13-deployment)
14. [Repository layout](#14-repository-layout)
15. [Adding a protocol](#15-adding-a-protocol)
16. [Revenue integrity and compliance](#16-revenue-integrity-and-compliance)
17. [License](#17-license)

---

## 1. What this actually sells

Anyone can scrape a DEX's pool list. The hard part is that a DEX's "fees" and a
lending market's "fees" are different economic events, reported by different
sources, in different shapes — so putting them in the same column is usually
either wrong or unjustified.

AlgoTerminal applies **one published accounting policy** across every protocol it
covers:

- **`gross_fees_24h`** is what users paid to use the protocol. A trader's swap fee
  on Tinyman and a borrower's interest payment on Folks Finance are the same kind
  of event, so they are the same number.
- **`supply_side_revenue_24h`** is the share that reached the people who supplied
  the capital — LPs on a DEX, depositors on a lending market. Deposit interest is
  *this quantity seen from the receiving end*, never a second fee.
- **`protocol_revenue_24h`** is the share the protocol kept. This is the figure
  comparable to a company's revenue. It excludes token emissions, governance
  rewards and liquidity-mining incentives on every class.

That one mapping is what makes `take_rate` and `capital_efficiency` mean the same
thing for a DEX and a lending market, which is the entire point. The policy lives
at [`/methodology`](https://api-production-36692.up.railway.app/methodology) and
in [`public/methodology.md`](public/methodology.md), versioned with semver in
`METHODOLOGY_VERSION` and stamped onto every fact.

### Three rules the code enforces, not just documents

**Never launder an estimate.** Anything not directly reported by the source
carries `is_estimated: true` *and* a non-empty `estimation_method`. The pair is
inseparable in the zod schema (`src/standardize/schema.ts`), so a connector
cannot forget.

**Never return a plausible-looking zero.** When Pact does not disclose its fee
split, Pact declines `take_rate` with a written reason rather than reporting
`0.00`. A decline is a fact about what the source publishes; a zero is a claim
about the protocol's economics. `/catalog` publishes every decline with its
reason, and `/metric` answers a declined KPI with a free 404 carrying the same
text.

**Every number is reproducible.** Each fact carries a `source[]` array of exact
URLs, and for on-chain reads, the application id and the ledger round. An
`onchain` source ref without a round fails schema validation — an unreproducible
number is not shippable.

---

## 2. Coverage

Read live from [`/catalog`](https://api-production-36692.up.railway.app/catalog);
this table is a snapshot.

| Protocol | Class | KPIs | Sources | Notes |
|---|---|---|---|---|
| **Tinyman** | `dex` | 11 | `mainnet.analytics.tinyman.org`, algod, indexer | V1.1 + V2. Fee split read **per pool** from on-chain state, not assumed |
| **Pact** | `dex` | 6 | `api.pact.fi` | Declines 5 KPIs — `pact_fee_bps` is null on all 3,961 pools, so the split is unknown |
| **Folks Finance** | `lending` | 12 | algod (on chain, via `@folks-finance/algorand-sdk`) | REST API is closed; read entirely on chain. Per-market `retentionRate` (10–30%) |

Data always describes **Algorand MainNet** protocols, whichever chain your
payment settles on. See [§6](#6-payments-mainnet-testnet-and-the-transaction).

---

## 3. The KPI registry

Fifteen KPIs, defined once in `src/standardize/kpis.ts`. `/catalog`, route
validation, cache TTLs, the `/ask` router and the 404 path all read that one
object — a KPI not in it does not exist as far as the API is concerned.

| KPI | Unit | Classes | TTL | Definition |
|---|---|---|---|---|
| `tvl` | USD | dex, lending | 300s | DEX: pool liquidity. Lending: total deposits (incl. capital lent out) |
| `volume_24h` | USD | dex | 600s | USD notional swapped, trailing 24h |
| `gross_fees_24h` | USD | dex, lending | 600s | Total paid by users to use the protocol, trailing 24h |
| `supply_side_revenue_24h` | USD | dex, lending | 600s | Share flowing to LPs / depositors |
| `protocol_revenue_24h` | USD | dex, lending | 600s | Share the protocol keeps — the comparable "revenue" |
| `take_rate` | RATIO | dex, lending | 600s | `protocol_revenue_24h / gross_fees_24h`. Null below $1 of fees |
| `capital_efficiency` | RATIO | dex, lending | 600s | Fees generated per dollar of TVL |
| `fee_apr` | RATIO | dex | 600s | `supply_side_revenue_24h × 365 / tvl` |
| `volume_to_tvl` | RATIO | dex | 600s | Turnover |
| `supply_apr` | RATIO | lending | 120s | Depositor rate |
| `borrow_apr` | RATIO | lending | 120s | Borrower rate |
| `utilization` | RATIO | lending | 120s | Borrows / deposits |
| `total_borrows` | USD | lending | 300s | Outstanding debt |
| `active_users_24h` | COUNT | dex, lending | 900s | Distinct addresses transacting with the protocol's app ids |
| `pool_count` | COUNT | dex, lending | 900s | Entities surviving the §3.6 filters |

**`RATIO` values are decimal fractions, never percentages.** `0.0369` means
3.69%. `COUNT` is a non-negative integer. `ASSET_UNITS` facts must name their
asset in `notes`.

A KPI that is not applicable to a protocol's class is a 404 `KPI_NOT_APPLICABLE`,
and the registry refuses to boot if a connector declares one that is
(`validateCapabilities` in `src/connectors/registry.ts`).

---

## 4. Every number arrives in one envelope

`/metric`, every leg of `/compare`, and every fact behind `/ask` return the same
`KpiFact` object — defined once in `src/standardize/schema.ts`, published as JSON
Schema at [`/schema/kpi-fact.json`](https://api-production-36692.up.railway.app/schema/kpi-fact.json)
so you can generate types or validate a response.

```json
{
  "metric": "capital_efficiency",
  "protocol": "tinyman",
  "value": 0.000318,
  "unit": "RATIO",
  "as_of": "2026-09-12T07:31:04.000Z",
  "timestamp": "2026-09-12T07:31:12.412Z",
  "confidence": 0.86,
  "methodology_version": "1.2.0",
  "is_estimated": false,
  "estimation_method": null,
  "cache": "hit",
  "stale": false,
  "coverage": { "entities": 17119, "excluded": 212, "basis": "all_pools_usd_priced" },
  "source": [
    { "name": "tinyman-analytics", "url": "https://mainnet.analytics.tinyman.org/api/v1/pools/?limit=5000", "kind": "rest", "retrieved_at": "2026-09-12T07:31:04.000Z" },
    { "name": "algod", "url": "https://mainnet-api.4160.nodely.dev/v2/applications/1002541853", "kind": "onchain", "app_id": 1002541853, "round": 64949473 }
  ],
  "notes": ["212 pools excluded: no USD price for one leg"]
}
```

### Reading `confidence`

A 0–1 score derived from how the number was obtained, not a vibe. Base values by
derivation (`src/standardize/confidence.ts`): reported `0.95`, on-chain `0.95`,
arithmetic `0.90`, USD conversion `0.90 × price confidence`, documented
estimation `0.85`, indexer aggregation `0.80`, fallback constant `0.70`. Then
penalties multiply in — stale L1 `×0.90`, L2 snapshot `×0.70`, high exclusion
`×0.90`, cross-source divergence `×0.90`.

| Band | Meaning |
|---|---|
| `>= 0.90` | Safe to act on |
| `0.70 – 0.90` | Directional only |
| `< 0.70` | Informational |
| `<= 0.40` | **Not sold.** The API returns a free 502 rather than a number whose error it cannot bound |

### `coverage.basis`

What the aggregate actually counted. `all_pools_usd_priced` (the default),
`verified_only`, or `total_deposits` for lending. Two legs of a comparison with
different bases get a caveat in the response, and for TVL-denominated metrics the
caveat says the gap is partly *definitional* rather than economic.

---

## 5. Endpoints and prices

Prices come from one table, `src/pricing.ts`, which is simultaneously what the
payment middleware charges and what `/catalog` advertises. The advertised price
and the charged price are structurally incapable of disagreeing.

### Free — everything needed to evaluate the service

| Route | What it gives you |
|---|---|
| `GET /health` | Liveness, per-connector status, cache hit rate, refresher timings, upstream throttle rates, facilitator settle-failure rate |
| `GET /catalog` | Live coverage, per-route prices, route availability, payment block, every declined KPI with its reason |
| `GET /methodology` | The accounting policy, structured and as a document |
| `GET /schema/kpi-fact.json` | The `KpiFact` envelope as JSON Schema |
| `GET /openapi.json` | Machine-readable route spec |
| `GET /llms.txt` | Agent discovery ([llmstxt.org](https://llmstxt.org)) |
| `GET /` | Human landing page, price table generated from `pricing.ts` |

### Paid

| Route | Price | Variants |
|---|---|---|
| `GET /metric/{protocol}/{kpi}` | **$0.005** | `?fresh=true` → **$0.02** (forces an upstream round-trip) · `kpi=active_users_24h` → **$0.03** (indexer aggregation) |
| `GET /compare?protocols=a,b,c&metric=x` | **$0.05** flat, 2–5 protocols | `?fresh=true` → **$0.08** |
| `POST /ask` | **$0.15** | `?depth=deep` → **$0.20** |

`?basis=` selects the coverage basis. `/compare` is composed from ordinary cached
legs and is never cached as a unit — a composite can never be fresher than its
parts, because there is no composite stored anywhere to go stale.

> **`/ask` is currently disabled upstream.** It requires an `ANTHROPIC_API_KEY`; a
> deployment without one serves every other route normally and reports
> `"available": false` for `/ask` in `/catalog`, `/llms.txt` and `/openapi.json`
> rather than quoting a price it would then 503. Check `/catalog` rather than
> assuming.

---

## 6. Payments: MainNet, TestNet, and the transaction

### Two chains, and they are not the same chain

This trips up everyone once, so it is worth being blunt:

| | Chain | Why |
|---|---|---|
| **The data** | Always Algorand **MainNet** | The protocols we measure live there. Tinyman's V2 pool walk returns 0 pools on TestNet |
| **The payment** | Whichever `X402_NETWORK` names | TestNet by default for clients, so you can evaluate with play money |

So the TestNet deployment sells **real MainNet numbers for free TestNet USDC**.
That is deliberate: an agent must be able to fully evaluate the service without
spending anything, so that every MainNet payment represents genuine demand.

`ALGOD_URL` / `INDEXER_URL` configure the **connectors** (always MainNet). The
payment gate ignores them entirely and derives its own algod from `X402_NETWORK`
(`src/config/x402.ts`). Pointing the connector URLs at TestNet does not error —
it silently under-reports.

### Network constants

| | MainNet | TestNet |
|---|---|---|
| CAIP-2 | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` |
| USDC ASA | `31566704` | `10458941` |
| algod | `mainnet-api.4160.nodely.dev` | `testnet-api.4160.nodely.dev` |
| indexer | `mainnet-idx.4160.nodely.dev` | `testnet-idx.4160.nodely.dev` |

Both are typed by hand in exactly one file. A mistyped CAIP-2 id fails as a
rejected settlement in production, never as a compile error, so it gets one
home.

### GoPlausible: the facilitator, and why you need no ALGO

Payments are verified and settled by the **[GoPlausible](https://goplausible.xyz)
x402 facilitator** at `https://facilitator.goplausible.xyz`. It is the third party
in the x402 handshake: AlgoTerminal never touches your key and never submits your
transaction itself.

```
Agent                    AlgoTerminal                 GoPlausible          Algorand
  │                            │                          │                   │
  │  GET /metric/tinyman/tvl   │                          │                   │
  ├───────────────────────────►│                          │                   │
  │  402 + PAYMENT-REQUIRED    │  (price, payTo, ASA,     │                   │
  │◄───────────────────────────┤   CAIP-2, feePayer)      │                   │
  │                            │                          │                   │
  │  sign axfer locally        │                          │                   │
  │  GET … PAYMENT-SIGNATURE   │                          │                   │
  ├───────────────────────────►│  POST /verify            │                   │
  │                            ├─────────────────────────►│                   │
  │                            │◄─── valid ───────────────┤                   │
  │                            │                          │                   │
  │                            │  ── run the handler ──   │                   │
  │                            │     (2xx or nothing)     │                   │
  │                            │                          │                   │
  │                            │  POST /settle            │  submit group     │
  │                            ├─────────────────────────►├──────────────────►│
  │  200 + KpiFact             │◄─── txid ────────────────┤                   │
  │◄───────────────────────────┤                          │                   │
```

**The facilitator sponsors the fee-payer transaction.** Your payment group pairs
your signed `axfer` with a fee-payer transaction GoPlausible signs and funds, so
your own transaction pays `"fee": 0`. In practice that means:

- **You need USDC only — no ALGO for gas.**
- Your account still needs a little ALGO for its own Algorand minimum balance.
- Your account **must be opted in to the USDC ASA.** An Algorand account that has
  not opted in to an asset cannot hold it, and every payment will fail with an
  error that looks like a service outage. This is the single most common reason an
  x402 integration appears broken.

Advertised as `payment.fee_sponsored: true` on `/catalog`.

### The two ordering guarantees

These are the whole reason `src/gate/middleware.ts` is hand-written rather than
assembled from the library's packaged middleware:

> **`/verify` runs before the handler.** We never do unpaid work.
> **`/settle` runs only after the handler returns 2xx.** We never take money for a
> failure.

A handler that throws, a 404 `KPI_NOT_APPLICABLE`, a 422 `UNROUTABLE_QUESTION`, a
502 `UPSTREAM_UNAVAILABLE` — all take the same path out of the gate, and none of
them reaches settle. That also makes the leaderboard number honest: **settled
volume equals successfully-served requests.**

Three further behaviours the gate holds:

- **Fail closed.** An unreachable facilitator is `503` with `Retry-After: 5`, never
  a served response. No verification, no data — a facilitator blip must not become
  free data.
- **Never retract a delivered response.** If settle fails *after* a successful
  handler, the caller keeps the 200 and we eat the loss — but a `settle_failed`
  row with the full payment payload is written to the ledger, so the loss is
  visible and reconcilable rather than silent.
- **Replays are rejected before any work.** `payment_txid` is the primary key of
  the `payments` table; a repeat is a `409 payment_replayed` costing us one indexed
  lookup, not a facilitator round-trip and a cache read.

### The handler deadline

Every Algorand transaction has a validity window. If a handler runs long enough
that its payment would expire before settlement, the request returns `504
PAYMENT_WINDOW_EXPIRED` **free**, and the work is left to finish into the cache
so the next caller gets the benefit. Budget is derived from the payment's own
window against the live chain round, falling back to the quoted cap if algod
blips — "no deadline" is not a reachable state.

### Payment headers

`PAYMENT-SIGNATURE` (x402 v2) is the canonical header; `X-PAYMENT` (v1) is
accepted as an alias and read at the one place the payload is decoded, so the
compatibility claim is true rather than merely documented.

### Verified MainNet settlement

One self-originated MainNet payment exists, logged in
[`mainnet-verification.json`](mainnet-verification.json) to confirm USDC receipt
and trigger Bazaar cataloging:

| | |
|---|---|
| Route | `GET /metric/tinyman/tvl` |
| Amount | `0.005000` USDC (5000 atomic, ASA `31566704`) |
| payTo | `36AZ3YZGHLUFFVU4STAQGSQMRB2W3TK5VVTKZVN6L2LH7NRCK7X27TMEJM` |
| txid | [`VR5MYGDARUPDHLS5CVOKNNGOHRORH4Z3FSOXP2BO7XCPGFOCEKOQ`](https://explorer.perawallet.app/tx/VR5MYGDARUPDHLS5CVOKNNGOHRORH4Z3FSOXP2BO7XCPGFOCEKOQ) |
| Round | 64949473 |
| Network fee paid by us | 0 — sponsored by the facilitator fee-payer |

TestNet settlements from the MCP end-to-end run are listed in
[`mcp/README.md`](mcp/README.md#verified-live), each confirmed on chain as an
`axfer` of ASA `10458941` with `"fee": 0`.

---

## 7. Quickstart

### Look before you pay — costs nothing

```bash
BASE=https://api-production-36692.up.railway.app

curl -s $BASE/catalog | jq           # coverage, prices, declines
curl -s $BASE/health  | jq .status
curl -i $BASE/metric/tinyman/tvl     # 402 + the exact payment requirements
```

### From an agent (MCP)

The fastest path. Add to `.mcp.json` (Claude Code) or
`claude_desktop_config.json` (Claude Desktop):

```json
{
  "mcpServers": {
    "algoterminal": {
      "command": "npx",
      "args": ["-y", "algoterminal-mcp"],
      "env": {
        "ALGOTERMINAL_KEYFILE": "~/.algoterminal/payer.key",
        "ALGOTERMINAL_MAX_SPEND_USDC": "1.00",
        "ALGOTERMINAL_MAX_PER_CALL_USDC": "0.05"
      }
    }
  }
}
```

Restart the client, then ask *"What does AlgoTerminal cover, and what does it
cost?"* — that hits the free catalog tool. Full setup, spend caps and TestNet
funding instructions: [`mcp/README.md`](mcp/README.md).

### From code

There is **no AlgoTerminal SDK**, because x402 already standardizes the client
half. The only AlgoTerminal-specific thing in the snippet below is the URL.

```js
import algosdk from 'algosdk';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

const account = algosdk.mnemonicToSecretKey(process.env.TESTNET_PAYER_MNEMONIC);
const client = new x402Client().register(
  'algorand:*',
  new ExactAvmScheme(toClientAvmSigner(Buffer.from(account.sk).toString('base64')), {
    algodUrl: 'https://testnet-api.4160.nodely.dev',
  }),
);

const pay = wrapFetchWithPayment(fetch, client);

// From here on, every call is an ordinary fetch that happens to pay.
const fact = await (await pay(`${BASE}/metric/tinyman/tvl`)).json();
```

Complete runnable programs in Node and Python — five steps, `0.055` TestNet USDC
for a full run — live in [`examples/`](examples/).

To get a funded TestNet account: generate one, fund it at
<https://bank.testnet.algorand.network>, **opt in to ASA `10458941`**, then get
USDC from <https://faucet.circle.com> (Algorand TestNet) or by swapping a little
TestNet ALGO on [TestNet Tinyman](https://testnet.tinyman.org).

---

## 8. Architecture

A single Hono service on Node 22, Redis and Postgres alongside it.

```
                    ┌─────────────────────────────────────────┐
   agent ──HTTP──►  │  Hono app (src/app.ts)                  │
                    │    CORS (free routes) → request log     │
                    │    → x402 payment gate  ◄── pricing.ts  │
                    └──────────────┬──────────────────────────┘
                                   │  (free routes short-circuit here)
                    ┌──────────────▼──────────────────────────┐
                    │  routes/  — thin. No protocol knowledge │
                    │  metric · compare · ask · catalog ·     │
                    │  health · methodology · schema · llms   │
                    └──────────────┬──────────────────────────┘
                    ┌──────────────▼──────────────────────────┐
                    │  cache/  L0 lru → L1 redis → L2 postgres│
                    │          + stampede lock                │
                    └──────────────┬──────────────────────────┘
                    ┌──────────────▼──────────────────────────┐
                    │  facts/compute → standardize/           │
                    │      kpis · confidence · schema         │
                    └──────────────┬──────────────────────────┘
                    ┌──────────────▼──────────────────────────┐
                    │  connectors/  tinyman · pact · folks    │
                    │    fetchRaw (impure) → toFacts (pure)   │
                    │    prices resolved once, before toFacts │
                    └──────────────┬──────────────────────────┘
                          algod · indexer · protocol REST APIs

  background: refresher (90s / 600s) · snapshotter (15m) · concentration (weekly)
```

**Layering rules that are actually enforced:**

- Routes contain no arithmetic and no protocol knowledge. There is no
  `if (protocol === 'folks')` anywhere in `src/routes/`, and there must never be.
- A connector splits into `fetchRaw` (network, impure) and `toFacts` (pure). A
  recorded snapshot plus a frozen price table is a complete replayable input to
  `toFacts`, which is what makes golden tests possible.
- Connectors never fetch their own USD prices. One price ladder
  (`src/connectors/price/`) resolves every asset before `toFacts` runs; a
  connector fetching its own would introduce a second, invisible pricing
  methodology.
- The service **refuses to boot** on an invalid environment (`src/config/env.ts`)
  or an incoherent connector registry (`src/connectors/registry.ts`). A blank
  `X402_PAYTO` would emit 402s pointing nowhere and quietly collect nothing;
  a `dex` declaring `utilization` would reach `/catalog` as a public promise we
  cannot keep. Both are boot failures, named all at once rather than one per
  restart.
- `X402_PAYTO` is validated for **alphabet and checksum**. A transposed Algorand
  address looks well-formed and cannot receive anything.

### Background jobs

| Job | Interval | What it does |
|---|---|---|
| **refresher** (fast) | 90s | Recomputes KPIs with registry TTL ≤ 300s (`tvl`, `total_borrows`, rate models). Measured ~13–15s |
| **refresher** (slow) | 600s | KPIs with TTL > 300s (24h flows, `active_users_24h`, `pool_count`). Measured ~62s |
| **snapshotter** | 15m | Persists every cached fact to `kpi_snapshots` — reads the cache, never fetches |
| **concentration** | weekly | The revenue-integrity review. See [§16](#16-revenue-integrity-and-compliance) |

The split between cycles is derived from the TTLs in the KPI registry, not a
hardcoded list of names: a KPI added with a 120s TTL joins the fast cycle by
definition. One 60s cycle was tried first and could not fit inside its own period
— the honest implementations of that are an unbounded queue or a log that claims
60s while running every 130s.

**The cache is warm because of these jobs, not because callers happen to repeat
each other.**

---

## 9. The cache is the business model

A `/metric` call sells for $0.005. A cold Tinyman fetch was measured at **~26
seconds** and costs a few thousand upstream requests. There is no price at which
the second thing pays for the first, so the paid path must essentially never do
it — and when it must, it must still answer, correctly labelled, rather than time
out.

| Tier | Store | TTL | Purpose |
|---|---|---|---|
| **L0** | in-process `lru-cache`, 2k entries | `min(60s, registry TTL)` | absorbs bursts, sub-ms, survives a Redis blip |
| **L1** | Redis | per-KPI, from the registry | shared across instances; the real hit source |
| **L2** | Postgres `kpi_snapshots` | unbounded | last-known-good when Redis *and* upstream are gone |

Key: `kpi:v{methodology_version}:{protocol}:{kpi}:{paramsHash}`. Network-independent
by construction, so the MainNet and TestNet services share one warm cache.

### What the caller can always tell

| Path | `cache` | `stale` | confidence |
|---|---|---|---|
| L0 or fresh L1 | `hit` | `false` | as computed |
| expired L1, served while revalidating | `stale` | `true` | × 0.90 |
| full miss, we fetched | `miss` | `false` | as computed |
| L2 last-known-good | `stale` | `true` | × 0.70, floored at 0.40, `as_of` = snapshot time |

A stale number never masquerades as a fresh one. Degradation is on the response
body, in the `X-AlgoTerminal-Cache` header, in the reduced confidence, and in a
note saying how old the number is.

### Measured, live on MainNet (2026-09-09)

| | |
|---|---|
| cold request (full upstream fetch) | 25.9 s |
| warm L0 | p50 0.0 ms, p95 0.2 ms |
| warm L1 (fresh process) | p50 0.5 ms, p95 0.7 ms |
| target p95 | 250 ms |
| 50 concurrent cold callers, one key | **1** upstream fetch |

The stampede lock is held on the **fetch group** `(protocol, basis, TTL class)`,
not on the fact key. A lock per key closes the stampede for one KPI and leaves
open the one that hurts — 11 cold Tinyman KPIs under 11 uncontended locks are 11
concurrent full enumerations. Measured on a live soak, that kept the fast refresh
cycle at 257s against its own 60s interval and the hit rate at 0.13. Locking the
group took the first cycle to 30s.

---

## 10. Errors, and what they cost you

**AlgoTerminal settles payment only after a successful response.** Not
"refunded", not "credited" — never settled in the first place. Retrying after a
failure is genuinely free advice.

| Status | Code | Meaning | Charged? |
|---|---|---|---|
| 400 | `INVALID_PARAM`, `INVALID_BODY`, `QUESTION_TOO_LONG`, `DEPTH_MISMATCH` | Malformed request. `DEPTH_MISMATCH` is a query/body `depth` disagreement — we never quote low and charge high, nor the converse | **No** |
| 402 | `payment_invalid`, `payment_insufficient`, `payment_expired` | The facilitator rejected the payment. Carries its verbatim reason; `payment_insufficient` also carries `required` and `provided` | **No** |
| 404 | `PROTOCOL_NOT_FOUND`, `KPI_NOT_FOUND` | Unknown protocol or KPI | **No** |
| 404 | `KPI_NOT_APPLICABLE` | The protocol declines this KPI. Carries the written reason and the KPIs it *does* publish | **No** |
| 409 | `payment_replayed` | This `payment_txid` has already been recorded | **No** |
| 422 | `TOO_FEW_PROTOCOLS`, `TOO_MANY_PROTOCOLS`, `KPI_NOT_APPLICABLE_TO_ANY` | `/compare` takes 2–5 protocols and needs the metric to apply to at least one | **No** |
| 422 | `OUT_OF_SCOPE`, `UNROUTABLE_QUESTION` | `/ask` — a forecast, a price target, advice, or something outside Algorand DeFi. Body lists what we do cover | **No** — probe freely |
| 502 | `UPSTREAM_UNAVAILABLE` | Tiers exhausted, or confidence at/below 0.40 — we will not sell a number whose error we cannot bound | **No** |
| 502 | `INSUFFICIENT_DATA` | `/compare` resolved fewer than 2 legs. A one-way "comparison" is not the product | **No** |
| 503 | `FACILITATOR_UNAVAILABLE` | Facilitator unreachable. `Retry-After: 5`. We fail closed, never open | **No** |
| 504 | `PAYMENT_WINDOW_EXPIRED` | The handler outran the payment's validity window. Usually `fresh=true` or `active_users_24h` | **No** |

`/compare` with ≥ 2 legs resolving returns **200** with `partial: true` and
`excluded_protocols`, each missing leg present in `facts[]` as an error fact
saying why — and that one *is* charged, because you got a usable comparison.

---

## 11. Running it locally

**Requirements:** Node ≥ 22, Redis, Postgres, network access to Algorand nodes
and the protocol APIs.

```bash
git clone https://github.com/anindhabiswas25/algoterminal
cd algoterminal
npm install

cp .env.example .env
# Set at minimum: X402_PAYTO, REDIS_URL, DATABASE_URL

npm run migrate     # apply migrations/*.sql
npm run dev         # tsx watch, http://localhost:3000
```

```bash
npm run build       # tsc → dist/
npm start           # node dist/index.js
npm run typecheck
npm run migrate:prod
```

Redis and Postgres are **required**, not optional. Without them the service would
boot into a configuration where every paid call is a 26-second upstream fetch —
unprofitable at $0.005 and unusable at any price. It refuses to start instead.

First boot is cold: give the refresher a few minutes before expecting warm reads.

### The other packages

```bash
cd mcp && npm install && npm test    # 96 tests, fully offline
cd web && npm install && npm run dev # Next.js 16 marketing site
cd examples && npm install && npm start
```

`mcp/test/harness.ts` throws on any unstubbed request — a test that reached the
live service would spend real money.

---

## 12. Configuration

Every variable is validated by `src/config/env.ts` at boot; the service refuses
to start if any is malformed. Full annotated list in
[`.env.example`](.env.example).

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | no | `development` \| `test` \| `production` |
| `PORT` | no | Default 3000; Railway injects its own |
| `X402_NETWORK` | **yes** | `mainnet` \| `testnet`. Selects CAIP-2 id and USDC ASA together |
| `X402_PAYTO` | **yes** | 58-char Algorand address that receives payment. Alphabet **and** checksum validated |
| `X402_FACILITATOR_URL` | **yes** | `https://facilitator.goplausible.xyz` |
| `ALGOD_URL` | **yes** | Connector reads. **Always MainNet** |
| `INDEXER_URL` | **yes** | Connector reads. **Always MainNet** |
| `REDIS_URL` | **yes** | L1 cache + stampede lock |
| `DATABASE_URL` | **yes** | L2 cache + payment ledger |
| `ANTHROPIC_API_KEY` | no | Enables `/ask`. Without it the route is ungated, unadvertised and marked unavailable |
| `OWN_PAYER_ADDRESSES` | no | Comma-separated. Our own addresses, for the weekly integrity alarm. Unset → `/health` reports `own_addresses_configured: false` rather than a clean bill of health |
| `METHODOLOGY_VERSION` | **yes** | Semver, bumped when a formula changes. Stamped on every fact and into every cache key |
| `PUBLIC_BASE_URL` | **yes** | Canonical external origin. Used in 402 bodies and headers, `llms.txt`, and the Bazaar listing |
| `TESTNET_BASE_URL` | no | Set on the MainNet service to advertise the free evaluation twin. The TestNet service leaves it unset |
| `LOG_LEVEL` | no | pino level, default `info` |

**The API never needs a private key**, because it only ever receives. Any
mnemonic variables in `.env.example` are for local scripts and must never reach a
deployed environment.

---

## 13. Deployment

Infrastructure is defined in code in [`.railway/railway.ts`](.railway/railway.ts):
two services (`api` for MainNet, `api-testnet` for TestNet) differing only in
`X402_NETWORK`, `X402_PAYTO` and `PUBLIC_BASE_URL`, sharing one Postgres and one
Redis in `iad`.

```bash
railway config plan     # safe, changes nothing
railway config apply
```

Sharing the stores is deliberate. The `payments` table carries a `NOT NULL
network` column so MainNet and TestNet settlements are distinguishable in one
queryable ledger, and the cache is network-independent by construction — so
MainNet starts warm rather than serving its first paid calls from a 26-second
upstream fetch.

Two deploy details that are easy to get wrong:

- **`preDeployCommand: npm run migrate:prod`.** Schema changes are applied by
  migration, never on boot. Two instances booting concurrently race on
  `CREATE TABLE IF NOT EXISTS`, and a schema that exists only as a side effect of
  a successful boot cannot be reviewed in a diff or rolled back independently.
  It runs `node dist/db/migrate-cli.js`, not `tsx` — the image is built with
  `--omit=dev`.
- **Every variable `env.ts` reads must be listed in `railway.ts`, including the
  optional ones.** A variable set only in the dashboard survives a deploy and is
  dropped by the next `railway config apply`. `preserve()` keeps the value without
  writing the secret into source.

`healthcheckPath` is `/health`, which is free and never gated — a liveness probe
must not be a payment path.

---

## 14. Repository layout

```
src/
  index.ts              boot: validate registry, start jobs, listen, graceful shutdown
  app.ts                Hono wiring: CORS → log → payment gate → routes → static
  pricing.ts            the route/price table — single source for charging AND advertising
  errors.ts             the error envelope
  config/
    env.ts              zod-validated environment; exits on anything malformed
    x402.ts             CAIP-2 ids, USDC ASAs, node URLs — typed by hand exactly once
  gate/
    middleware.ts       verify → handler → settle, with the ordering guarantees
    facilitator.ts      fail-closed wrapper around the facilitator client
    ledger.ts           the payments table: replay guard + settle-failure rows
    payload.ts          decode PAYMENT-SIGNATURE / X-PAYMENT, derive payment_txid
    deadline.ts         handler budget derived from the payment's validity window
    routes.ts           price/variant resolution per request
  routes/               thin HTTP handlers, zero protocol knowledge
  cache/                L0/L1/L2, stampede lock, keys, TTLs, metrics  (see cache/README.md)
  connectors/
    registry.ts         the one Map; boot-time coherence validation
    types.ts            the connector interface
    price/              the one sanctioned USD price ladder
    tinyman/ pact/ folks/   one directory per protocol, each with its own README
  standardize/
    schema.ts           the KpiFact envelope — the single definition
    kpis.ts             the 15-KPI registry: units, classes, TTLs, cross-class basis
    confidence.ts       derivation bases, penalties, caps, floors
    compare.ts          ranking and comparability caveats
  ask/                  router, capability matrix, grounding, synthesis
  facts/compute.ts      connector output → validated facts
  jobs/                 refresher · snapshotter · concentration
  db/                   pool + migration runner
  openapi/document.ts   the OpenAPI document, generated
migrations/             001 kpi_snapshots (L2) · 002 payments (ledger)
mcp/                    the MCP server, published as algoterminal-mcp
examples/               runnable x402 clients, Node + Python
web/                    Next.js 16 marketing site (separate lockfile, not yet the published site)
public/                 methodology.md, og-banner.png, favicon.png
.railway/railway.ts     infrastructure as code
```

---

## 15. Adding a protocol

The interface exists to make this cheap: **one new directory plus one line in
`registry.ts`, and nothing else in the codebase changes.** If a connector
requires editing the standardization layer, the cache, the routes or the payment
gate, the interface is wrong and should be fixed rather than worked around.

1. `src/connectors/<slug>/` with `index.ts`, `enumerate.ts`, `schema.ts`.
2. Implement `capabilities()`, `fetchRaw()` (impure), `toFacts()` (pure),
   `healthCheck()`.
3. **Declare conservatively.** `/catalog` is generated from `capabilities()`, so
   an over-claim is a public promise broken on the first call. The correct move
   for a hard KPI is to omit it — or, when its absence is itself a finding about
   the source, to `decline` it with a written reason.
4. `active_users_24h` requires non-empty `appIds`; without them the KPI is
   declined, never approximated. Enforced at boot.
5. Verify the source by hand first and write it up, as the three existing
   connector READMEs do: endpoint, auth, pagination, rate limits, exact fields
   read, and who pays whom.
6. Add the line to `registry.ts`. `/catalog`, `/health`, route validation, the
   refresher's hot set and the `/ask` capability matrix all pick it up with no
   further edit.

---

## 16. Revenue integrity and compliance

Volume figures are only worth something if they represent real demand, so the
controls are code that runs rather than SQL in a runbook.

- **Settled volume equals successfully-served requests**, by construction — the
  settle-after-2xx guarantee in [§6](#the-two-ordering-guarantees).
- **The weekly concentration job** (`src/jobs/concentration.ts`) runs two queries
  with deliberately different severities. A single payer above 40% of settled
  volume is a **report** at WARN — it may just be one enthusiastic integrator, but
  it should be identified before the number is treated as a win. **Our own
  addresses appearing in the ledger** is an **alarm** at ERROR: any row beyond the
  one logged verification payment is a stop signal, not a number to interpret.
  Both results are published on `/health`.
- **No self-generated volume.** Exactly one self-originated MainNet payment
  exists, and it is logged in `mainnet-verification.json` with its txid and
  purpose.
- **The MCP server ships no funded account and proxies no service wallet.** It
  signs with the user's own key, which never leaves their machine. Paying on
  users' behalf would be precisely the self-generated volume that disqualifies an
  entry.
- **Spend caps are enforced against the amount the server actually quotes in its
  402**, in a hook that runs before any transaction is built or signed. Calls are
  refused, never truncated — there is no "spend what is left" path.
- Every degradation path in the compliance reporting returns `null` rather than
  throwing. A report that takes the service down when Postgres hiccups is worse
  than one that says it could not run, and `/health` renders that honestly rather
  than as a clean bill of health.

---

## 17. License

MIT. See [LICENSE](LICENSE).
