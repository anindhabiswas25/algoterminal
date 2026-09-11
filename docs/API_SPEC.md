# AlgoTerminal — API Specification

**Status:** v1.0 (pre-implementation)
**Base URL (MainNet):** `https://api.algoterminal.xyz`
**Base URL (TestNet):** `https://testnet.algoterminal.xyz`
**x402 version:** `2` (v1 network identifiers accepted for compatibility)

---

## 1. Route and price table

This table is the contract. It is generated from `src/pricing.ts`, which is also what configures the payment middleware — the advertised price and the charged price cannot drift apart.

| Method | Route | Paid | Price (USDC) | Tier rationale |
|---|---|---|---|---|
| GET | `/health` | free | — | Liveness; must never require payment |
| GET | `/catalog` | free | — | Capability discovery; an agent must be able to learn what we sell before buying |
| GET | `/openapi.json` | free | — | Machine-readable spec |
| GET | `/llms.txt` | free | — | Agent discovery (llmstxt.org) |
| GET | `/methodology` | free | — | Published accounting policy (`DATA_SCHEMA.md`) |
| GET | `/metric/{protocol}/{kpi}` | **paid** | **$0.005** | Cache-backed lookup; >99% gross margin |
| GET | `/metric/{protocol}/{kpi}?fresh=true` | **paid** | **$0.02** | Forces an upstream round-trip; we sell recency honestly |
| GET | `/metric/{protocol}/{kpi}?kpi=active_users_24h` | **paid** | **$0.03** | Indexer aggregation is materially more expensive |
| GET | `/compare` | **paid** | **$0.05** flat, 2–5 protocols | Multi-source synthesis; flat price keeps agent budgeting simple |
| GET | `/compare?fresh=true` | **paid** | **$0.08** | Forces an upstream round-trip on *every* leg *[added: §3.2 always specified this price; the table omitted the row]* |
| POST | `/ask` | **paid** | **$0.15** | Two LLM calls + N cached lookups; ~80% margin |
| POST | `/ask?depth=deep` | **paid** | **$0.20** | Wider KPI sweep + longer synthesis budget |

**Free-tier rationale (compliance-relevant):** everything needed to *evaluate* AlgoTerminal is free. An agent can discover us, read the schema, read the methodology, and check our health without paying. Consequently every mainnet payment we receive represents a caller that decided our data was worth money — which is exactly the volume-integrity property `PRD.md` §7 requires.

**Dynamic pricing.** `/metric` and `/ask` prices vary by query param, implemented with the `DynamicPrice` function form of `PaymentOption.price`. The price is resolved *before* the 402 is emitted, so the caller is always quoted the exact amount it will be charged. We never quote low and charge high.

---

## 2. The x402 payment flow

### 2.1 Unpaid request → 402

Any request to a paid route without a valid payment header:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: <base64 of the JSON below>
X-PAYMENT-REQUIRED: <same base64, v1 compatibility alias>
```

Decoded `PAYMENT-REQUIRED`:

```jsonc
{
  "x402Version": 2,
  "error": "payment_required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
      "asset": "31566704",
      "amount": "5000",
      "payTo": "<ALGOTERMINAL_PAYTO_ADDRESS>",
      "maxTimeoutSeconds": 60,
      "extra": {
        "decimals": 6,
        "feePayer": "<GOPLAUSIBLE_FEE_PAYER_ADDRESS>"
      }
    }
  ],
  "resource": "https://api.algoterminal.xyz/metric/tinyman/tvl",
  "description": "Standardized TVL for Tinyman, in USD, with provenance and confidence.",
  "mimeType": "application/json",
  "discovery": {
    "tags": ["x402-global-challenge", "defi", "algorand", "analytics", "kpi"],
    "category": "financial-data",
    "input_example":  { "method": "GET", "path": "/metric/tinyman/tvl" },
    "output_example": {
      "metric": "tvl", "protocol": "tinyman", "value": 6300000.0,
      "unit": "USD", "confidence": 0.95
    }
  }
}
```

Notes:
- `amount` is **atomic units**: 6 decimals, so `"5000"` = 0.005 USDC.
- `extra.feePayer` is GoPlausible's sponsor address — the caller needs **no ALGO**, only USDC.
- `network` is CAIP-2. TestNet: `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`, USDC ASA `10458941`.
- The response **body** (not just the header) restates price, resource, and description in plain JSON, so an agent that does not yet speak x402 still learns what it costs and why.

### 2.2 Paid retry

```http
GET /metric/tinyman/tvl HTTP/1.1
Host: api.algoterminal.xyz
PAYMENT-SIGNATURE: <base64 of the JSON below>
```

```jsonc
{
  "x402Version": 2,
  // The FULL requirement chosen from `accepts[]`, echoed back verbatim. This is
  // what the resource server matches on, and a payload without it is rejected
  // before verify. Corrected at build step 6: the earlier draft here put
  // `scheme` and `network` at the top level, which is the v1 shape.
  "accepted": {
    "scheme": "exact",
    "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "asset": "31566704",
    "amount": "5000",
    "payTo": "<ALGOTERMINAL_PAYTO_ADDRESS>",
    "maxTimeoutSeconds": 60,
    "extra": { "decimals": 6, "feePayer": "<GOPLAUSIBLE_FEE_PAYER_ADDRESS>" }
  },
  "payload": {
    "paymentGroup": [
      "<b64 msgpack: UNSIGNED fee-payer txn>",
      "<b64 msgpack: SIGNED USDC axfer, 5000 units → payTo>"
    ],
    "paymentIndex": 1
  }
}
```

`X-PAYMENT` is accepted as a v1 alias for `PAYMENT-SIGNATURE` and carries the same base64.

Fee-payer transaction requirements (index 0): sender **and** receiver are the fee-payer address; amount `0` µALGO; `FlatFee: true`; fee ≥ `2000` µALGO (covers both txns); note bytes `x402-fee-payer`; left **unsigned** for the facilitator to sign at settle. Max group size is 16.

### 2.3 Success

```http
HTTP/1.1 200 OK
Content-Type: application/json
PAYMENT-RESPONSE: <base64 settlement response: { success, transaction, txid, network, payer }>
X-AlgoTerminal-Cache: hit
X-AlgoTerminal-Methodology: 1.1.0
```

The x402 wire type names the settlement transaction `transaction`; this document called it `txid`. We emit **both**, with the same value, so a stock x402 client and this spec read the same receipt. `X-AlgoTerminal-Cache` carries the same value as the body's `cache` field.

**Ordering guarantee:** `/verify` runs before the handler; `/settle` runs only after the handler returns 2xx. A failed request is never settled. This is stated in the docs and in `/llms.txt` because it is a real purchasing consideration for an agent operator.

### 2.4 Payment error responses

| Status | `error` code | When | Charged? |
|---|---|---|---|
| 402 | `payment_required` | No payment header | No |
| 402 | `payment_invalid` | Facilitator `/verify` rejected; `detail` carries the facilitator's reason | No |
| 402 | `payment_insufficient` | Amount below the quoted price; `required`/`provided` in body | No |
| 402 | `payment_expired` | Older than `maxTimeoutSeconds` | No |
| 409 | `payment_replayed` | txid already recorded in our ledger | No |
| 503 | `facilitator_unavailable` | `/verify` unreachable. `Retry-After: 5`. **We fail closed.** | No |

A settle that fails *after* a successful response is not in this table, because it is not an error response: the caller keeps its 200 and its data. It carries `PAYMENT-RESPONSE` with `success: false` and an `X-AlgoTerminal-Settlement: failed` header, and it is recorded as a `settle_failed` row and surfaced on `/health` (`ARCHITECTURE.md` §5.2).

---

## 3. Endpoints

### 3.1 `GET /metric/{protocol}/{kpi}` — $0.005 / $0.02 / $0.03

The workhorse. One standardized KPI for one protocol.

**Path params**

| Name | Type | Values |
|---|---|---|
| `protocol` | string | `tinyman` \| `pact` \| `folks` — live set at `/catalog` |
| `kpi` | string | see `DATA_SCHEMA.md` §4 |

**Query params**

| Name | Type | Default | Effect |
|---|---|---|---|
| `fresh` | bool | `false` | Bypass L0/L1, force upstream fetch. **Raises price to $0.02.** |
| `basis` | enum | `all_pools_usd_priced` | `verified_only` applies the stricter filter (`DATA_SCHEMA.md` §3.6.5) |

**200 response** — a bare `KpiFact` (`DATA_SCHEMA.md` §2):

```jsonc
{
  "metric": "tvl",
  "protocol": "tinyman",
  "value": 6300000.0,
  "unit": "USD",
  "timestamp": "2026-09-08T14:32:11Z",
  "as_of": "2026-09-08T14:30:00Z",
  "source": [{
    "name": "tinyman-analytics",
    "url": "https://mainnet.analytics.tinyman.org/api/v1/pools/",
    "kind": "rest",
    "retrieved_at": "2026-09-08T14:30:02Z"
  }],
  "confidence": 0.95,
  "is_estimated": false,
  "estimation_method": null,
  "methodology_version": "1.0.0",
  "cache": "hit",
  "stale": false,
  "coverage": { "entities": 412, "excluded": 7, "basis": "all_pools_usd_priced" },
  "notes": ["Includes V1.1 and V2 pools; V2 resolved via v2_address."]
}
```

**Errors**

| Status | Code | Body detail |
|---|---|---|
| 404 | `PROTOCOL_NOT_FOUND` | `available_protocols: [...]` |
| 404 | `KPI_NOT_FOUND` | `available_kpis: [...]` |
| 400 | `INVALID_PARAM` | Unknown `basis`, non-boolean `fresh`, or a `basis` this protocol does not implement |
| 404 | `KPI_NOT_APPLICABLE` | e.g. `utilization` on a `dex`; includes the protocol's class and its applicable KPIs |
| 502 | `UPSTREAM_UNAVAILABLE` | All tiers exhausted including L2. **Not settled — caller not charged.** |

### 3.1.1 What you are buying when our cache is cold

Under a cold-key stampede one caller wins the fetch lock and the rest are served the last-known-good snapshot at reduced confidence (`ARCHITECTURE.md` §4.5). Behind a payment gate, those callers are paying for it, so the policy is stated here rather than left to inference. It is also published at `/llms.txt`.

**A labelled stale answer is charged for.** It is a correct answer to the question asked, and every part of its degradation is on the response: `cache: "stale"`, `stale: true`, a reduced `confidence`, an `X-AlgoTerminal-Cache: stale` header, and a `notes` entry giving the age and the penalty applied. A caller that does not want a stale number can see that it got one.

**A non-answer is not charged for.** Two cases, both 502 and therefore never settled:

- every tier exhausted, including L2 — the `UPSTREAM_UNAVAILABLE` row above;
- confidence at or below **0.40**, the §5 `l2_snapshot` floor. A fact sitting *on* the floor is one whose penalty chain bottomed out, so we can no longer bound its error. Selling a number whose error we cannot bound is what `DATA_SCHEMA.md` §1 rules out.

**`?fresh=true` is a no-stale-or-no-charge contract.** The higher price on that variant exists because the caller is buying recency (§1: "we sell recency honestly"). If we cannot produce a non-stale number, the request has not been fulfilled: it returns 502 and is not charged. Retry without `?fresh=true` to buy the labelled stale number at the base price.

Two alternatives were considered and rejected on mechanism, not taste. *Refusing to settle any stale serve* would return data and take no money — a free tier on a paid route, reachable by anyone willing to force a cold key, and `?basis=verified_only` on an unpopular KPI is cold by construction. *Pricing a degraded answer lower* is not expressible in the `exact` scheme: the amount is quoted in the 402, which is emitted before the handler runs, so the cache state is unknown at quoting time. x402 does support partial settlement, but only for schemes that declare it (`upto`), not `exact`.

### 3.2 `GET /compare` — $0.05 / $0.08

Same metric, 2–5 protocols, with the ranking computed for the caller.

This is the route the methodology exists for. `/metric` sells one number; this sells the claim that numbers from structurally different protocols belong on the same axis — which is the claim §3 of `DATA_SCHEMA.md` spends its length establishing. `capital_efficiency` across a DEX and a lending market is that claim being cashed.

**Query params**

| Name | Type | Required | Notes |
|---|---|---|---|
| `protocols` | csv | yes | 2–5 **distinct** ids; duplicates are collapsed before the bounds are checked. <2 → 400 `TOO_FEW_PROTOCOLS`, >5 → 400 `TOO_MANY_PROTOCOLS` |
| `metric` | string | yes | One KPI id |
| `basis` | enum | no | As §3.1 |
| `fresh` | bool | no | Applies to all legs; price rises to $0.08 |

**200 response**

```jsonc
{
  "metric": "capital_efficiency",
  "unit": "RATIO",
  "timestamp": "2026-09-08T14:32:11Z",
  "methodology_version": "1.0.0",
  "facts": [
    { "protocol": "tinyman", "value": 0.180, "confidence": 0.93, "...": "full KpiFact" },
    { "protocol": "folks",   "value": 0.031, "confidence": 0.85, "...": "full KpiFact" },
    { "protocol": "pact",    "value": null,  "confidence": 0.0,
      "error": { "code": "UPSTREAM_UNAVAILABLE", "message": "api.pact.fi timed out" } }
  ],
  "ranking": [
    { "rank": 1, "protocol": "tinyman", "value": 0.180 },
    { "rank": 2, "protocol": "folks",   "value": 0.031 }
  ],
  "ranking_basis": "rank 1 is the highest value; ranking is strictly descending by magnitude for every KPI, and implies nothing about which direction is better. …",
  "spread": { "max": 0.180, "min": 0.031, "ratio": 5.8065 },
  "comparability": {
    "confidence": 0.85,
    "note": "Composite confidence is the MINIMUM across legs, not the mean.",
    "caveats": [
      "tinyman is class 'dex', folks is class 'lending'; capital_efficiency is comparable because §3.1 defines gross_fees identically for both — swap fees paid by traders and interest paid by borrowers are both what users pay to use the protocol.",
      "The legs do not share one coverage basis: tinyman is measured on 'all_pools_usd_priced', while folks is measured on 'total_deposits'. …",
      "folks is estimated, not directly reported: annualized_rate_to_daily_simple. …"
    ]
  },
  "cache": "hit",
  "stale": false,
  "partial": true,
  "excluded_protocols": ["pact"]
}
```

**Not cached as a unit** (`ARCHITECTURE.md` §6). Each leg is fetched through the ordinary `/metric` cached path — same keys, same TTLs, same stampede lock, same L2 fallback — and the composite reports the **worst cache state across its legs** in `cache`/`stale` and in `X-AlgoTerminal-Cache`. Caching the composite would double the staleness surface for no gain, so there is no stored composite that can go stale independently of the numbers in it.

**`ranking` is strictly descending by value, for every KPI**, and every response says so in `ranking_basis`. Rank 1 is the largest number, *not* the "best" one.

The alternative — a per-KPI direction in the §4 registry, so `utilization` and `take_rate` would rank ascending — is rejected, because a direction column is a **normative** claim and §4 is a registry of what numbers *mean*. Every candidate for "lower is better" dissolves once you ask *for whom*: a low `take_rate` is good for LPs and bad for whoever holds the protocol's equity; a high `utilization` is capital working hard *and* thin exit liquidity, which a treasury agent and a risk agent read in opposite directions. Encoding an answer would ship an unfalsifiable judgement under an analytics label — the same thing §4.1 refuses when it declines to map wallets to humans. So we sort by magnitude, publish that we did, and leave "better" to the caller, who knows which side of the trade it is on. Equal values share a rank (1, 2, 2, 4).

**`spread.ratio` is `number | null`, and is never `Infinity`, `NaN` or negative.** It is `max / min`, and it is `null` whenever that quotient is not a meaningful multiple — when `min` is `0`, or negative, or the legs straddle zero. `max` and `min` are always the measured values; only the derived quotient is withheld, with a caveat saying why. This is not defensive decoration: Pact's `take_rate` was exactly `0.000000` before Pact declined the KPI (`DATA_SCHEMA.md` §3.4), and a residual KPI can go negative — §3.5's `protocol_revenue_24h` did, on 7 of 24 Folks markets, under the pre-1.2.0 formula. A single distinct value across all legs gives `ratio: 1`.

**Duplicate ids in `protocols` are collapsed**, and the 2–5 bounds are checked on the deduplicated list. `protocols=tinyman,tinyman` is therefore a free 400 `TOO_FEW_PROTOCOLS`, not a ranking of Tinyman against itself with a spread ratio of exactly 1.0 — which would be a confident-looking non-answer, and would be settled.

**`comparability.caveats` is generated per response and is empty when nothing warrants one.** A caveat a caller learns to skip is worse than no caveat, because the next one matters. It is emitted for: legs spanning protocol classes (naming the classes *and* the §3.1 basis on which they are nonetheless comparable, from the §4 registry's `crossClassBasis`); legs measured on different `coverage.basis` values; any `is_estimated` leg, naming its `estimation_method`; any leg below the §5 0.7 informational line; a withheld `spread.ratio`; and the exclusions themselves.

**Partial-result policy.** If ≥ 2 legs succeed, we return 200 with `partial: true` and settle the payment — the caller got a usable comparison. If < 2 succeed, we return 502 `INSUFFICIENT_DATA` and **do not settle**. Rationale: a two-way comparison is the product; a one-way "comparison" is not, and charging $0.05 for it would be taking money for a non-answer.

`comparability.caveats` is generated, not decorative. Comparing across protocol classes is legitimate *only because* of the §3 methodology, and the response says so explicitly — the honesty is part of what is being sold.

**KPI applicability.** The capability matrix is uneven — Pact declines four KPIs it cannot compute honestly (§3.4), `utilization`/`supply_apr`/`borrow_apr`/`total_borrows` are lending-only, `volume_24h`/`volume_to_tvl`/`fee_apr` are DEX-only. So:

- Applicable to **no** requested protocol → 422 `KPI_NOT_APPLICABLE_TO_ANY`, **not settled**. Nothing was computed and nothing could have been.
- Applicable to **some** → the rest become §2 error facts in `facts[]`, and if ≥ 2 remain it is an ordinary partial 200 and **is** settled.

The two unsold-fact rules from §3.1.1 apply per leg rather than per response: a leg at or below the 0.40 confidence floor, or a stale leg under `?fresh=true`, becomes an error fact instead of a value. A number we would not sell on its own is not one we will sell inside a ranking, where it is harder to notice. If that takes the comparison below two legs, the 502 below applies and nothing is charged.

**Errors:** 400 `TOO_FEW_PROTOCOLS` (<2 distinct), 400 `TOO_MANY_PROTOCOLS` (>5 distinct), 404 `KPI_NOT_FOUND` (not in the §4 registry), 404 `PROTOCOL_NOT_FOUND` (naming the unknown ids — a protocol we do not cover is a malformed request that will fail identically on retry, so it fails the whole call rather than becoming one error fact among several), 422 `KPI_NOT_APPLICABLE_TO_ANY`, 502 `INSUFFICIENT_DATA`. None of them is settled.

### 3.3 `POST /ask` — $0.15 / $0.20

Natural-language question → routed KPI fetch → cited synthesis.

**Request**

```jsonc
{
  "question": "Is Pact or Tinyman capturing more protocol revenue this week, and why?",
  "depth": "standard",          // "standard" ($0.15) | "deep" ($0.20)
  "max_facts": 12,              // 1–24, default 12
  "format": "both"              // "prose" | "facts" | "both" (default)
}
```

**200 response**

```jsonc
{
  "question": "Is Pact or Tinyman capturing more protocol revenue this week, and why?",
  "answer": "Tinyman captured more protocol revenue over the last 24h ($518 vs $NN), despite …",
  "facts": [ /* every KpiFact the answer is grounded in — full envelopes */ ],
  "plan": {
    "protocols": ["tinyman", "pact"],
    "kpis": ["protocol_revenue_24h", "gross_fees_24h", "take_rate", "tvl"],
    "comparison_type": "cross_protocol_ranking"
  },
  "citations": [
    { "claim": "Tinyman captured $518 in protocol revenue over 24h",
      "fact_index": 0 }
  ],
  "confidence": 0.85,
  "caveats": [
    "Pact protocol_revenue is a lower bound: 34% of gross fees came from pools with a null pact_fee_bps (DATA_SCHEMA.md §3.4)."
  ],
  "methodology_version": "1.0.0",
  "model": { "router": "claude-haiku-4-5", "synthesizer": "claude-sonnet-5" },
  "timestamp": "2026-09-08T14:32:11Z"
}
```

**Grounding guarantees** (enforced by the synthesis system prompt and asserted in tests):
- Every numeric claim in `answer` corresponds to a `KpiFact` in `facts[]`. No number is generated.
- **No forecasting, no price targets, no trading advice.** Descriptive only.
- Any fact with `confidence < 0.7` is explicitly caveated in prose.
- `facts[]` is always returned even when `format: "prose"` is requested, so a downstream agent can verify or ignore the narrative. The prose is a convenience layer over the data, never a substitute for it.

**Errors**

| Status | Code | Notes |
|---|---|---|
| 400 | `QUESTION_TOO_LONG` | > 500 chars |
| 422 | `UNROUTABLE_QUESTION` | Router could not map to covered protocols/KPIs. Body lists what we do cover. **Not settled** — the routing call is cheap and we eat it rather than charging for a non-answer. |
| 422 | `OUT_OF_SCOPE` | Question asks for a forecast, advice, or a non-Algorand-DeFi topic. **Not settled.** |
| 502 | `INSUFFICIENT_DATA` | Routed successfully but < 1 fact resolved. **Not settled.** |

Declining to charge for an unroutable question is a deliberate trust decision: an agent that learns it can probe `/ask` safely will integrate it; one that gets billed $0.15 for "we don't cover that" will not call twice.

### 3.4 `GET /catalog` — free

Generated live by iterating the connector registry and calling `capabilities()`. It is structurally impossible to advertise a KPI no connector implements.

```jsonc
{
  "service": "AlgoTerminal",
  "methodology_version": "1.0.0",
  "network": "algorand-mainnet",
  "payment": {
    "protocol": "x402", "version": 2, "scheme": "exact",
    "asset": "31566704", "asset_symbol": "USDC", "decimals": 6,
    "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "facilitator": "https://facilitator.goplausible.xyz",
    "payTo": "<ALGOTERMINAL_PAYTO_ADDRESS>",
    "fee_sponsored": true
  },
  "protocols": [
    { "id": "tinyman", "name": "Tinyman", "class": "dex",
      "kpis": ["tvl","volume_24h","gross_fees_24h","supply_side_revenue_24h",
               "protocol_revenue_24h","take_rate","capital_efficiency",
               "fee_apr","volume_to_tvl","active_users_24h","pool_count"],
      "sources": ["mainnet.analytics.tinyman.org"] },
    { "id": "pact", "name": "Pact", "class": "dex", "kpis": ["..."],
      "sources": ["api.pact.fi"] },
    { "id": "folks", "name": "Folks Finance", "class": "lending",
      "kpis": ["tvl","total_borrows","utilization","supply_apr","borrow_apr",
               "gross_fees_24h","supply_side_revenue_24h","protocol_revenue_24h",
               "take_rate","capital_efficiency","active_users_24h"],
      "sources": ["algod:mainnet-api.4160.nodely.dev"] }
  ],
  "routes": [
    { "path": "/metric/{protocol}/{kpi}", "method": "GET", "price_usdc": "0.005",
      "price_fresh_usdc": "0.02", "price_active_users_usdc": "0.03" },
    { "path": "/compare", "method": "GET", "price_usdc": "0.05",
      "price_fresh_usdc": "0.08" },
    { "path": "/ask", "method": "POST", "price_usdc": "0.15",
      "price_deep_usdc": "0.2" }
  ]
}
```

`routes[]` lists the **paid** routes only, generated from `src/pricing.ts` — the same module the payment middleware charges from (`ARCHITECTURE.md` §4.1). Every chargeable variant in the §1 table is advertised, including `price_active_users_usdc`: quoting two of a route's three prices is the drift that having one pricing module exists to prevent. The free routes carry no price and are discovered from `/llms.txt` and `/openapi.json`, so an agent never has to read a missing `price_usdc` as free-by-omission.

Prices are rendered from the atomic-unit integer that is actually charged (`"0.005"` from `5000` at 6 decimals), so trailing zeros are trimmed — `/ask?depth=deep` advertises `"0.2"`, not `"0.20"`.

`protocols[].sources` is the connector's declared `sourceHosts` (`CONNECTOR_GUIDE.md` §1.1): the hosts a protocol's numbers come from. Per-response provenance — the exact URLs, app ids and rounds read — is the `source[]` array on each `KpiFact` (§3.1), not this list.

### 3.5 `GET /health` — free

```jsonc
{
  "status": "ok",                 // "ok" | "degraded" | "down"
  "uptime_s": 84210,
  "methodology_version": "1.0.0",
  "connectors": {
    "tinyman": { "status": "ok", "last_success": "...", "success_rate_24h": 0.998 },
    "pact":    { "status": "ok", "last_success": "...", "success_rate_24h": 0.995 },
    "folks":   { "status": "ok", "last_success": "...", "success_rate_24h": 1.0 }
  },
  "cache": {
    "hit_rate_1h": 0.83,           // trailing hour, FRESH hits only; null before the first lookup
    "lookups_1h": 4210,            // what the rate is computed over
    "redis": "ok",
    "l0_entries": 38,
    "refresher": {                 // ARCHITECTURE.md §4.6 — one entry per cycle
      "fast": { "interval_s": 60,  "last_run_at": "...", "last_duration_ms": 13400,
                "last_ok": 1, "last_failed": 0, "skipped": 0, "overruns": 0, "running": false },
      "slow": { "interval_s": 600, "last_run_at": "...", "last_duration_ms": 64800,
                "last_ok": 1, "last_failed": 0, "skipped": 0, "overruns": 0, "running": false }
    },
    "snapshotter": { "interval_s": 900, "last_run_at": "...", "last_written": 11 }
  },
  "facilitator": { "status": "ok", "settle_failures_1h": 0 },
  "last_block_seen": 64845976
}
```

`status` is `degraded` if any connector's 24h success rate < 0.95, if the cache hit rate falls below 0.5, or if settle failures exceed 5% over 5 minutes.

A **stale** serve is not counted as a hit. It could be argued either way — a stale serve is fast and costs no upstream call — but the number here is the one `PRD.md` §5.1 sets a 70% target for, and that target is about the paid path being *warm*. A cache serving 90% stale entries is a refresher that has stopped working, and counting those as hits would hide the failure behind a healthy-looking number.

`last_duration_ms` sits beside `interval_s` on each cycle so a cycle drifting past its own period is visible rather than silent; `overruns` counts the times it has happened, and `skipped` the runs dropped because the previous one was still going.

### 3.6 `GET /llms.txt` — free

Per llmstxt.org. Written for an agent deciding whether to call us: what we cover, the exact response schema, price per route, the settle-after-success guarantee, and a copy-pasteable example. Content in `DEPLOYMENT.md` §6.2.

---

## 4. OpenAPI 3.1 skeleton

Served at `/openapi.json`. Abridged here to the parts that carry decisions; the implementation generates the full document from the same zod schemas that validate requests, so spec and behavior cannot diverge.

```yaml
openapi: 3.1.0
info:
  title: AlgoTerminal
  version: 1.0.0
  description: >
    Standardized, agent-native financial KPIs for Algorand DeFi.
    Paid per query in USDC over x402 (Algorand MainNet, GoPlausible facilitator).
    Methodology published at /methodology.
  x-x402:
    version: 2
    scheme: exact
    network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="
    asset: "31566704"
    facilitator: "https://facilitator.goplausible.xyz"
    fee_sponsored: true
servers:
  - url: https://api.algoterminal.xyz
    description: MainNet (paid, real USDC)
  - url: https://testnet.algoterminal.xyz
    description: TestNet (paid in TestNet USDC, ASA 10458941 — use this to integrate)

paths:
  /metric/{protocol}/{kpi}:
    get:
      operationId: getMetric
      summary: One standardized KPI for one protocol
      x-price-usdc: "0.005"
      x-price-usdc-fresh: "0.02"
      parameters:
        - { name: protocol, in: path, required: true, schema: { type: string, enum: [tinyman, pact, folks] } }
        - { name: kpi, in: path, required: true, schema: { type: string } }
        - { name: fresh, in: query, schema: { type: boolean, default: false } }
        - { name: basis, in: query, schema: { type: string, enum: [all_pools_usd_priced, verified_only], default: all_pools_usd_priced } }
      responses:
        '200': { description: KPI fact, content: { application/json: { schema: { $ref: '#/components/schemas/KpiFact' } } } }
        '402': { $ref: '#/components/responses/PaymentRequired' }
        '404': { $ref: '#/components/responses/NotFound' }
        '502': { $ref: '#/components/responses/UpstreamUnavailable' }

  /compare:
    get:
      operationId: compareMetric
      x-price-usdc: "0.05"
      x-price-fresh-usdc: "0.08"
      parameters:
        - { name: protocols, in: query, required: true, schema: { type: string }, example: "tinyman,pact,folks" }
        - { name: metric, in: query, required: true, schema: { type: string }, example: "capital_efficiency" }
        - { name: basis, in: query, schema: { type: string, enum: [all_pools_usd_priced, verified_only] } }
        - { name: fresh, in: query, schema: { type: string, enum: ["true", "false"] } }
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/CompareResponse' } } } }
        '400': { description: Fewer than 2 or more than 5 distinct protocols; NOT charged }
        '402': { $ref: '#/components/responses/PaymentRequired' }
        '404': { description: Unknown KPI or unknown protocol id; NOT charged }
        '422': { description: KPI applicable to no requested protocol; NOT charged }
        '502': { description: Fewer than 2 legs resolved; NOT charged }

  /ask:
    post:
      operationId: ask
      x-price-usdc: "0.15"
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: '#/components/schemas/AskRequest' } } }
      responses:
        '200': { content: { application/json: { schema: { $ref: '#/components/schemas/AskResponse' } } } }
        '402': { $ref: '#/components/responses/PaymentRequired' }
        '422': { description: Unroutable or out of scope; NOT charged }

components:
  schemas:
    CompareResponse:
      type: object
      required: [metric, unit, timestamp, methodology_version, facts, ranking, ranking_basis, spread, comparability, cache, stale, partial, excluded_protocols]
      properties:
        metric:              { type: string }
        unit:                { type: string, enum: [USD, RATIO, COUNT, ASSET_UNITS] }
        timestamp:           { type: string, format: date-time }
        methodology_version: { type: string }
        facts:               { type: array, items: { $ref: '#/components/schemas/KpiFact' } }
        ranking:
          type: array
          description: Strictly descending by value. Rank 1 is the largest, not the "best". Ties share a rank.
          items:
            type: object
            required: [rank, protocol, value]
            properties:
              rank:     { type: integer, minimum: 1 }
              protocol: { type: string }
              value:    { type: number }
        ranking_basis:       { type: string, description: States the sort direction on every response. }
        spread:
          type: [object, "null"]
          required: [max, min, ratio]
          properties:
            max: { type: number }
            min: { type: number }
            ratio:
              type: [number, "null"]
              description: >-
                max / min, or null when min is zero or negative and the quotient
                would not be a meaningful multiple. Never Infinity, NaN or negative.
        comparability:
          type: object
          required: [confidence, note, caveats]
          properties:
            confidence: { type: number, minimum: 0, maximum: 1, description: The MINIMUM across legs, never the mean. }
            note:       { type: string }
            caveats:    { type: array, items: { type: string }, description: Generated per response; empty when nothing warrants one. }
        cache:               { type: string, enum: [hit, miss, stale], description: Worst state across the legs. }
        stale:               { type: boolean }
        partial:             { type: boolean }
        excluded_protocols:  { type: array, items: { type: string } }

    KpiFact:
      type: object
      required: [metric, protocol, value, unit, timestamp, source, confidence, methodology_version]
      properties:
        metric:              { type: string }
        protocol:            { type: string }
        value:               { type: [number, "null"] }
        unit:                { type: [string, "null"], enum: [USD, RATIO, COUNT, ASSET_UNITS, null] }
        timestamp:           { type: string, format: date-time }
        as_of:               { type: string, format: date-time }
        source:              { type: array, items: { $ref: '#/components/schemas/SourceRef' } }
        confidence:          { type: number, minimum: 0, maximum: 1 }
        is_estimated:        { type: boolean }
        estimation_method:   { type: [string, "null"] }
        methodology_version: { type: string }
        cache:               { type: string, enum: [hit, miss, stale] }
        stale:               { type: boolean }
        coverage:            { $ref: '#/components/schemas/Coverage' }
        notes:               { type: array, items: { type: string } }
    SourceRef:
      type: object
      required: [name, kind, retrieved_at]
      properties:
        name:         { type: string }
        url:          { type: string }
        kind:         { type: string, enum: [rest, onchain, derived] }
        retrieved_at: { type: string, format: date-time }
        app_id:       { type: [integer, "null"], description: "Set when kind=onchain" }
        round:        { type: [integer, "null"], description: "Set when kind=onchain" }
    Coverage:
      type: object
      properties:
        entities: { type: integer }
        excluded: { type: integer }
        basis:    { type: string }
  responses:
    PaymentRequired:
      description: x402 payment required
      headers:
        PAYMENT-REQUIRED:
          schema: { type: string }
          description: Base64-encoded x402 v2 payment requirements
      content: { application/json: { schema: { $ref: '#/components/schemas/PaymentRequiredBody' } } }
```

---

## 5. Cross-cutting conventions

- **Errors** are always `{ "error": { "code": "UPPER_SNAKE", "message": "...", "detail": {...} } }`. Codes are stable across versions; messages are not.
- **Timestamps** are RFC 3339 UTC with a `Z` suffix. Always two of them: `timestamp` (when we computed) and `as_of` (what moment the data describes). Conflating these is how stale data gets sold as fresh.
- **Numbers** are JSON numbers, never strings — upstream sources emit decimal strings and normalizing that away is part of what the caller is paying for.
- **Rate limiting** applies to free routes only (60 req/min/IP). Paid routes are self-limiting by cost; adding a rate limit on top of a payment gate would be charging for a request we then refuse.
- **CORS:** `*` on free routes. Paid routes are for server-side agents; browsers are not the target and a permissive CORS policy there would only invite confused clients.
- **Versioning:** breaking changes to the envelope ship under `/v2/...`. Changes to a *formula* ship as a `methodology_version` bump, announced at `/methodology`, with the previous version pinnable via `?methodology=1.0.0` for one quarter. A data product whose numbers change silently is not a data product.
