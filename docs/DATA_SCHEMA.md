# AlgoTerminal — Standardized Data Schema & Methodology

**Status:** v1.2 — §3.5's Folks lending formulas corrected during the step-8 build (2026-09-09).
**`methodology_version`: `1.2.0`** — stamped on every response. Any change to a formula in §3 or §4 is a version bump.

This document is the product. Everything else is delivery. It is published at `/methodology` so buyers can audit our accounting rather than trust it.

---

## Changelog

### 1.2.0 — 2026-09-09

**What changed.** The `lending` class ships for the first time, and §3.5's fee formula is corrected: borrower interest is computed from **all** outstanding debt at a **debt-weighted blend of the variable and stable borrow rates**, not from variable debt at the variable rate.

| | 1.1.0 (as written) | 1.2.0 |
|---|---|---|
| Folks connector | specified, not built | live — 25 markets, on chain |
| `gross_fees_24h` (§3.5) | `Σ (variableBorrowTotal_usd × variableBorrowInterestRate) / 365` | `Σ (total_debt_usd × overallBorrowInterestRate) / 365` |
| `total_borrows` (§3.5) | variable debt | variable **+ stable** debt |
| Folks `gross_fees_24h` | $1,742.54 | **$1,989.14** |
| Folks `protocol_revenue_24h` | $36.93 | **$283.54** |
| retention cross-check divergence | **12.13%** — fires | **0.000000%** |
| markets with negative protocol revenue | 7 of 24 | 0 |
| `total_borrows` vs DefiLlama | understated 7.7% | **+0.36%** |

**Why.** Folks markets carry stable-rate debt as well as variable-rate debt, and stable borrowers pay the rate fixed when they borrowed. Live on 2026-09-09 stable debt was 1.8% of ALGO's, 21.6% of USDC's and **54.3% of ISOLATED_TINY's**. The 1.1.0 formula drops that debt from both the principal and the rate, so it understates what borrowers paid — while `supply_side_revenue_24h` is computed from `depositInterestRate`, which Folks itself derives from the *blended* rate. The two halves of §3.1 were therefore being computed on different populations, and the identity stopped reconciling: **7 of 24 markets came out with negative `protocol_revenue_24h`**, meaning depositors paid more than borrowers did.

**How it was caught.** By §3.5's own retention cross-check, which is exactly what that check was specified for. §3.5 says "if it fires, suspect your decimal scale before suspecting Folks" — so the scales were verified first, independently, against `@folks-finance/algorand-sdk@0.2.6`'s own `retrievePoolInfo` across all 25 live markets (largest disagreement: **0** for `supply_apr`, **9.6e-17** for the blended borrow rate). With the scaling ruled out, the formula was the only remaining candidate. Under the corrected formula the residual and the retention-rate prediction agree to floating-point noise.

**Why it is a version bump.** §3's opening promise: any change to a formula in §3 or §4. This changes a §3.5 formula and the value of five published KPIs, and it ships a new protocol class. Contrast the Pact change recorded in §3.4, which changed *what is published* without changing any formula or any surviving number, and is deliberately **not** a bump.

**What buyers see.** Folks appears on `/catalog` with 12 KPIs. Pact loses four (§3.4). Nothing about Tinyman changes.

### 1.1.0 — 2026-09-09

**What changed.** Tinyman V2 pools are enumerated from the chain, and a V2 pool's TVL is computed from its on-chain reserves rather than read out of the analytics API.

| | 1.0.0 | 1.1.0 |
|---|---|---|
| V2 enumeration (§3.3) | `v2_address` pointers on V1.1 records — **922 of 17,119 pools (5.4%)** | `GET /v2/accounts?application-id=1002541853` — **all 17,119, in 19 pages** |
| V2 TVL (§3.3) | the API's `liquidity_in_usd` | `Σ (reserves_N / 10^dec_N) × price_N`, via the §3.7 ladder |
| V2 fee split (§3.3) | 922 per-pool algod local-state reads | free — it arrives in the enumeration page |
| Price ladder (§3.7) | any price the ladder returned | a price below `MIN_PRICE_CONFIDENCE` = 0.10 is **rank 5, unpriced** |
| TVL confidence (§5) | `reported`, 0.95 | `usd_conversion`, 0.90 × a TVL-weighted price confidence |

**Why.** The 1.0.0 enumeration could only reach a V2 pool that had a V1.1 predecessor, so it missed every V2-native pair — which is where the liquidity is. Tinyman TVL came out at **$2.51M against DefiLlama's $5.80M, −56.7%**, and every figure was published as a documented lower bound. Under 1.1.0 it is **$5.38M against $5.76M, −6.6%** (live run, 2026-09-09).

**Why it is a version bump and not a bug fix.** The 1.0.0 numbers were not wrong under their own stated method; they were the honest output of a method with a documented hole. Changing how TVL is *computed* — a source change, a formula change, and a confidence-derivation change — is exactly what §3's opening promise says gets a version bump. Nothing has been published, so there is no compatibility burden here; the discipline starts now rather than at the first version where it costs something.

**What buyers see.** TVL rises ~2×. `pool_count` rises. `capital_efficiency`, `fee_apr` and `volume_to_tvl` fall, because the denominator grew faster than the fee flow did. TVL's stamped `confidence` **falls** (0.86 → 0.70): see §5.

---

## 1. Principles

1. **One meaning per metric name.** `gross_fees_24h` means the same economic thing for a DEX and for a lending market. If a protocol cannot support that meaning, the connector declines the KPI rather than approximating it under the same name.
2. **Never launder an estimate.** Anything not directly reported by the source is `is_estimated: true` with a documented `estimation_method` and reduced `confidence`.
3. **Follow the money, not the label.** We classify by *who pays* and *who receives*, not by what a protocol calls its own line items.
4. **Every number is reproducible.** `source[]` carries the exact upstream URL(s) and, for on-chain reads, the app id and round. A buyer can re-derive our number.
5. **Decline loudly.** A KPI we cannot compute returns 404 with `available_kpis`. It never returns a plausible-looking zero.

---

## 2. The `KpiFact` envelope

Every value the API emits — from `/metric`, inside `/compare`, and in `/ask`'s `facts[]` — is this object. There is exactly one shape.

```jsonc
{
  "metric": "gross_fees_24h",        // KPI id, from the registry in §4
  "protocol": "tinyman",             // protocol id, from the connector registry
  "value": 12847.32,                 // number | null. null ONLY with an error field
  "unit": "USD",                     // see §2.1
  "timestamp": "2026-09-08T14:32:11Z",  // when WE computed it
  "as_of": "2026-09-08T14:30:00Z",      // what moment the DATA describes
  "source": [                        // provenance, one entry per upstream read
    {
      "name": "tinyman-analytics",
      "url": "https://mainnet.analytics.tinyman.org/api/v1/pools/?limit=500",
      "kind": "rest",                // "rest" | "onchain" | "derived"
      "retrieved_at": "2026-09-08T14:30:02Z"
    }
  ],
  "confidence": 0.95,                // 0.0–1.0, §5
  "is_estimated": false,
  "estimation_method": null,         // required string when is_estimated is true
  "methodology_version": "1.2.0",
  "cache": "hit",                    // "hit" | "miss" | "stale"
  "stale": false,
  "coverage": {                      // what the aggregate actually covers
    "entities": 412,                 // pools/markets included
    "excluded": 7,                   // excluded by the filters in §3.6
    "basis": "all_pools_usd_priced"
  },
  "notes": []                        // human/agent-readable caveats, e.g.
                                     // "V2 protocol fee ratio read from app
                                     //  global state; V1.1 uses documented 0.05%"
}
```

An error fact (used inside `/compare` so one bad protocol doesn't fail the whole call):

```jsonc
{
  "metric": "utilization", "protocol": "tinyman", "value": null, "unit": null,
  "timestamp": "...", "error": {
    "code": "KPI_NOT_APPLICABLE",
    "message": "utilization is defined for lending protocols only; tinyman is class 'dex'"
  }, "confidence": 0.0, "methodology_version": "1.2.0"
}
```

### 2.1 Units

| `unit` | Meaning | Representation |
|---|---|---|
| `USD` | US dollars | float, full precision (`12847.32`) |
| `RATIO` | Dimensionless fraction | float. **`0.0369` means 3.69%.** Never a percent, never a string. |
| `COUNT` | Whole things (users, pools) | integer |
| `ASSET_UNITS` | Whole units of a named asset | float, already divided by `10^decimals`; `asset_id` required in `notes` |

**No percentages anywhere in the API.** Upstream sources disagree about this (Tinyman's `annual_percentage_rate: "0.036882"` is a fraction; Pact's `tvl_24h_change_pct: "0.00"` is a percent). Normalizing at the boundary is precisely the standardization work we are selling.

### 2.2 Protocol classes

Every protocol declares exactly one class. The class determines which KPIs are applicable (§4).

| Class | Meaning | v1 members |
|---|---|---|
| `dex` | AMM/orderbook; users pay a fee to swap | `tinyman`, `pact` |
| `lending` | Users deposit and borrow; borrowers pay interest | `folks` *(live since 1.2.0)* |
| `l1` | Base chain; users pay transaction fees | *(post-MVP)* |

---

## 3. The cross-type accounting policy

This is the heart of the standardization. The problem: a DEX's "fee" and a lending market's "interest" are different words for the same economic event — **a user paying to use the protocol** — and every downstream comparison depends on treating them identically.

### 3.1 The universal cash-flow decomposition

For any protocol, in any 24h window:

```
gross_fees_24h  =  supply_side_revenue_24h  +  protocol_revenue_24h
   (what users             (what capital              (what the protocol
    paid to use             providers earned)          itself captured)
    the protocol)
```

Read strictly:

- **`gross_fees_24h`** — total value paid **by users of the protocol** for the service, in the last 24h. It is a cost *to users*, and the top of the funnel. Nothing else counts: not token emissions, not incentives, not governance rewards, not airdrops.
- **`supply_side_revenue_24h`** — the portion of `gross_fees_24h` that accrues to the parties supplying capital (LPs, depositors). Not the protocol's money.
- **`protocol_revenue_24h`** — the portion the protocol itself keeps (treasury, protocol fee, reserve factor). **This is the number that is comparable to a company's revenue**, and the one most misreported in the wild, because most sources publish `gross_fees` and call it revenue.
- **`take_rate` = `protocol_revenue_24h / gross_fees_24h`** — the protocol's cut. Dimensionless, and directly comparable across a DEX and a lending market. This ratio is the clearest single demonstration that the standardization works.

**Explicitly excluded from all three, for every protocol class:**
- Token incentives / liquidity mining emissions (a cost paid in dilution, not revenue).
- Governance rewards (Algorand governance ALGO is an external subsidy, not protocol revenue). Note that Pact's `apr_governance` is exactly this and is therefore excluded from `fee_apr` — see §3.3.
- Unrealized price appreciation of treasury holdings.
- Bridge, listing, or one-off fees not paid per-use.

### 3.2 Class mapping: what counts as "a user paying to use the protocol"

| Class | The paying event | `gross_fees` | `supply_side_revenue` | `protocol_revenue` |
|---|---|---|---|---|
| `dex` | A swap | Total swap fee charged on all swaps in 24h | LP share of that fee | Protocol share of that fee |
| `lending` | Accruing interest on a borrow | Total interest accrued by borrowers in 24h | Interest credited to depositors | Retained portion (reserve/retention) |
| `l1` | Submitting a transaction | Total txn fees paid in 24h | 0 (Algorand pays no fee share to validators) | Total fees to the fee sink |

The lending row is the one that requires an explicit statement, because it is where naive comparisons break: **borrower interest is the DEX swap fee of a lending protocol.** Both are the price a user pays for the protocol's core service; both split between capital suppliers and the protocol. Once that is fixed, `take_rate`, `capital_efficiency`, and `protocol_revenue` are apples-to-apples by construction.

Deposit interest is *not* a second source of fees. It is `supply_side_revenue` — the same dollars, viewed from the receiving end. Counting both would double-count the entire flow. (This is the single most common error in ad-hoc DeFi comparisons, and avoiding it is why §3.1 is written as an identity rather than three independent definitions.)

### 3.3 Connector: Tinyman (`dex`)

**Sources:** the Nodely indexer (`/v2/accounts`) for V2, and `https://mainnet.analytics.tinyman.org/api/v1/` — open, no key — for V1.1 and for all 24h flows. Verified live 2026-09-09.

Tinyman is two venues sharing a brand. They are enumerated differently, valued differently, and both are counted.

#### Enumeration

**V2 — from the chain, completely.** A V2 pool is a logic-sig **account** opted into the single validator application `1002541853`, and the pool's entire state is that account's **local** state. So the pool set is exactly the account set:

```
GET /v2/accounts?application-id=1002541853&limit=1000&exclude=assets,created-assets,created-apps
```

paged through `next-token`. Measured 2026-09-09: **17,119 accounts in 19 pages, 12.9 s**. Each account's local state carries `asset_1_id`, `asset_2_id`, `asset_1_reserves`, `asset_2_reserves`, `total_fee_share`, `protocol_fee_ratio` and `issued_pool_tokens` — so **a V2 pool is fully described on-chain, with no analytics call at all.** The walk pages exhaustively and **never truncates silently**: a page that fails after retries sets `partial`, is counted in `coverage.excluded`, and is stated in `notes`.

> **Superseded in 1.1.0.** Until 1.1.0 this section enumerated V2 by collecting `v2_address` from V1.1 records and fetching each one. That pointer only exists on a pool that *had* a V1.1 predecessor, so the walk reached **922 of 17,119 pools (5.4%)** and missed the largest pairs on the venue (tALGO/xALGO, tALGO/USDC, Folks/ALGO). The result was $2.51M against DefiLlama's $5.80M. See the Changelog.

**V1.1 — still the analytics API.** `GET /api/v1/pools/?limit=1000&offset=N`. There is no V1.1 equivalent of the V2 validator app to enumerate against: a V1.1 pool is an lsig account opted into `552635992`, but its reserves are not laid out in local state the way V2's are, so the analytics record remains the only complete description. V1.1 is ~$183k of the venue; the asymmetry is documented rather than hidden.

**Known upstream quirks (both must be handled):**

- **The V1.1 list returns duplicates.** 7,418 rows over ~5,500 distinct `address` values — offset pagination over a set the server re-orders. The dedupe-by-address guard is load-bearing for the V1.1 list *itself*.
- **It throttles.** Eight unpaced concurrent requests earn `429` with `Retry-After: 18`; handled by `ctx.http`'s §4.1 retry policy, not by the connector.

**Double-counting guard:** a V1.1 pool and a V2 pool holding the same pair are **distinct venues holding distinct liquidity**. Both are counted. What must never happen is one record arriving twice under two keys — dedupe by `address`.

#### TVL

```
V2 pool:   tvl = (asset_1_reserves / 10^dec1) * price_1
                 + (asset_2_reserves / 10^dec2) * price_2      [prices from §3.7]
V1.1 pool: tvl = parseFloat(liquidity_in_usd)
TVL_usd  = Σ_pools tvl,  over pools passing §3.6
```

`dec_N` is **not** on-chain state — asset decimals come from `/api/v1/assets/?ids=<csv>`, the same endpoint the §3.7 rank-2 gate uses, and ids already carried by a V1.1 record are not re-fetched. A pool whose decimals or prices cannot be resolved is **excluded and counted**, never scaled by `10^0` and never contributed as a zero.

**Cross-check, not a source.** For the pools whose analytics record is also read (the flow set below), our on-chain TVL is compared with the source's own `liquidity_in_usd` and the mean divergence is reported in every `tvl` fact's `notes`. Measured 2026-09-09: **1.46%** across the 49 pools of the recorded fixture, and 0.4% / 0.4% / 1.0% on the three largest live pools. That is an independent corroboration of the reserve formula from a completely different data path. It never changes a value.

#### Volume and fees — a narrower coverage, stated

On-chain pool state has **no 24h flow**: local state holds a cumulative `asset_N_protocol_fees` balance and a point-in-time reserve, and neither is a rate. So V2 `volume_24h` and `gross_fees_24h` come from the analytics API, one `GET /api/v1/pools/{address}/` per pool.

**Decision: keep the analytics API for flows, fetched only for the pools that pass §3.6.** The alternative — differencing `asset_N_protocol_fees` between snapshots — is a better number and is genuinely on-chain, but it requires a snapshot history we do not have until the step-6 refresher exists and has run. It is **post-MVP**, behind its own version bump.

The consequence is stated rather than smoothed over: **TVL and flows come from different sources with different coverage.**

- TVL covers every enumerated pool that passes §3.6 (411 on 2026-09-09).
- Flows cover the pools whose lookup succeeded (390 of 390 attempted on that run), plus every V1.1 pool.
- Every flow KPI carries a `notes[]` entry naming both counts and the share of included TVL they represent.
- Below 90% flow coverage by TVL, the flow KPIs take §5's high-exclusion penalty.
- `capital_efficiency`, `fee_apr` and `volume_to_tvl` use the **flow-covered TVL** as their denominator, not total TVL, and say which they used. A ratio whose numerator and denominator describe different pools is not a ratio.
- A pool whose flow lookup fails keeps its TVL and contributes **nothing** to the flow KPIs. It never contributes a zero, which would be indistinguishable from a genuinely quiet pool (§1.5).

```
volume_24h     = Σ_pools-with-flows  last_day_volume_in_usd
gross_fees_24h = Σ_pools-with-flows  last_day_fees_in_usd
```

`last_day_fees_in_usd` is the **total** fee charged to swappers, so it maps directly to `gross_fees_24h`. It must **not** be reported as `protocol_revenue`.

#### Fee split

Per-version and, for V2, per-pool:

```
V1.1: total swap fee = 30 bps, of which 25 bps -> LPs, 5 bps -> protocol.
      protocol_share = 5/30 = 0.16667

V2:   protocol_share = 1 / protocol_fee_ratio, read from the pool ACCOUNT's
      LOCAL state under app 1002541853 — which since 1.1.0 arrives in the
      enumeration page itself, so it is read for every pool, always, at no
      extra request. Measured 2026-09-09 across all 17,119: protocol_fee_ratio
      is 4 on 9,900 pools (a 25% cut) and 6 on 7,219 (16.7%). A flat constant
      would misstate one of them.

      Fallback: if protocol_fee_ratio is missing or <= 0, use 1/6 with
      is_estimated = true, confidence base 0.70, and a note naming the fallback.

protocol_revenue_24h    = Σ_pools ( pool.gross_fees * protocol_share(pool) )
supply_side_revenue_24h = gross_fees_24h - protocol_revenue_24h
```

The per-pool `protocol_share` (not a single protocol-wide constant) matters because V1.1 and V2 coexist with different economics, and V2's own split is not uniform.

**Nullability that must be handled** (measured over the full V1.1 catalogue): `liquidity_in_usd` is null on 369 of ~5,500 pools; `total_annual_percentage_rate` is null on 5,469, so nothing may depend on it. A record failing validation is skipped and counted, never coerced.

**`current_unclaimed_protocol_fees`** is a cumulative on-chain balance of protocol fees not yet swept. It is **not** a 24h flow and is never used as `protocol_revenue_24h`.

#### Cost

Measured end to end on 2026-09-09 (see `src/connectors/tinyman/README.md` §Performance):

| Phase | Requests | Time |
|---|---|---|
| V2 account walk ‖ V1.1 list | 19 ‖ 8 | 12.9 s |
| Asset decimals ‖ §3.7 ladder | 48 ‖ ~60 | 22.6 s |
| Per-pool flow lookups | 390 | 30.1 s |
| **Full refresh** | ~530 | **71-88 s** |
| **TVL-only refresh** (`opts.kpis` excludes every flow KPI) | ~90 | **13-14 s** |

End to end, including the caller's price resolve: **78-105 s** full, **26-28 s** TVL-only, against ~252 s under 1.0.0. The full path does not fit a 60 s refresh cycle and the reason is upstream — Tinyman has no bulk V2 endpoint and throttles at 8 concurrent requests — so §4's TTLs are the lever: `tvl` at 300 s and the flow KPIs at 600 s mean a 60 s hot-set cycle should buy TVL only. See `src/connectors/tinyman/README.md` §7.1.

### 3.4 Connector: Pact (`dex`)

**Source:** `https://api.pact.fi/api/pools` — open, no key, paginated (`count`/`offset`/`limit`, 3,954 pools as of verification 2026-09-08).

**Raw fields pulled per pool:**

| Field | Type | Use |
|---|---|---|
| `id`, `on_chain_id`, `on_chain_address` | — | Entity key |
| `tvl_usd` | decimal string | TVL |
| `volume_24h`, `volume_7d` | decimal string | Volume (denominated in the primary asset, **not USD** — see below) |
| `fee_usd_24h`, `fee_usd_7d` | decimal string | **Gross** swap fees in USD |
| `fee_amount_24h`, `fee_amount_7d` | number | Fee in asset units; cross-check only |
| `fee_bps` | int | Total pool fee in basis points |
| `pact_fee_bps` | int \| **null** | Protocol's cut in bps — **null on 100% of pools** *[corrected]* |
| `pool_type` | `"CONSTANT_PRODUCT"` \| `"STBL"` \| … | Classification, filtering |
| `apr_7d`, `apr_7d_all`, `apr_governance` | decimal string (fraction) | Fee APR; **`apr_governance` is excluded per §3.1** |
| `is_verified`, `auto_verified_100k`, `auto_verified_1m`, `is_deprecated` | bool | Inclusion filter (§3.6) |
| `primary_asset.price`, `secondary_asset.price` | decimal string | USD pricing, and the volume conversion below |

**Normalization:**

```
TVL_usd        = Σ_pools  parseFloat(tvl_usd)
gross_fees_24h = Σ_pools  parseFloat(fee_usd_24h)
```

**Volume requires conversion.** Pact's `volume_24h` is expressed in units of the primary asset, whereas Tinyman's `last_day_volume_in_usd` is already USD. Comparing them raw is exactly the class of error this product exists to prevent.

```
volume_24h_usd = Σ_pools ( parseFloat(volume_24h) * price_usd(primary_asset) )

price_usd(a):
   1. pool.primary_asset.price if non-null and > 0            (confidence 0.90)
   2. price service (§3.7)                                     (confidence 0.85)
   3. otherwise EXCLUDE the pool from volume_24h_usd and increment
      coverage.excluded — never contribute an unpriced 0.
```

**Fee split.**

```
if pact_fee_bps != null and fee_bps > 0:
    protocol_share = pact_fee_bps / fee_bps                     (confidence 0.95)
    is_estimated   = false
else:
    protocol_share = 0.0                                        (confidence 0.55)
    is_estimated   = true
    estimation_method = "pact_fee_bps absent; protocol cut assumed 0 for this
                        pool (conservative). Pool contributes to gross_fees_24h
                        and supply_side_revenue_24h only."

protocol_revenue_24h    = Σ_pools ( fee_usd_24h * protocol_share )
supply_side_revenue_24h = gross_fees_24h - protocol_revenue_24h
```

Assuming zero (rather than guessing a default cut) makes `protocol_revenue` a documented **lower bound** when `pact_fee_bps` is sparse. The fact's `notes` states the share of gross fees that came from pools with a null `pact_fee_bps`, so a buyer can see how tight the bound is. Guessing would produce a number that looks authoritative and is not.

**[corrected] `pact_fee_bps` is null on 100% of pools, not "frequently".** Measured against the live catalogue on **2026-09-09: 3,961 of 3,961 pools**, every page, no exceptions — the field is not sparse, it is absent. The original probe wrote "frequently null" from a sample and the difference turns out to be the whole question.

**Consequence: Pact declines `protocol_revenue_24h`, `supply_side_revenue_24h`, `take_rate` and `fee_apr`.**

The lower-bound treatment above is the right rule for a sparse field and is retained as written. At 100% it degenerates. The bound becomes `protocol_revenue >= $0` — true of every protocol that has ever existed — and what actually ships is `protocol_revenue_24h = $0.00` and `take_rate = 0.000000`, both flagged `is_estimated` with a note saying the bound constrains nothing. The note is correct and does not help, because **the number travels without the note**. `/compare?metric=take_rate` would rank Tinyman's 0.248 above Pact's 0.000, and an agent reading that ranking would conclude "Pact captures no revenue" when the truth is "Pact does not publish its cut". §1.5 governs: we decline loudly rather than return a plausible-looking zero.

`supply_side_revenue_24h` and `fee_apr` go with them, for the mirror-image reason. With `protocol_share = 0` the residual gives `supply_side_revenue_24h = gross_fees_24h` **exactly**, which asserts *"LPs receive 100% of Pact's swap fees"* — a claim about Pact's economics we have no evidence for and that is very likely false. `fee_apr = supply_side_revenue_24h × 365 / tvl` inherits the claim intact, and comes out numerically identical to `capital_efficiency`; that coincidence is the tell.

What survives is the leg that needs no split. `gross_fees_24h` is `Σ fee_usd_24h`, which Pact reports directly, and `capital_efficiency` is built on it. **Pact publishes one leg of §3.1 rather than three, and says which one.** `/metric` answers each declined KPI with `404 KPI_NOT_APPLICABLE` naming the reason; `/catalog` does not advertise them. §3.1 remains an identity and is still asserted in code over the computed split (`splitFees` in `src/connectors/pact/index.ts`) — the arithmetic is checked whether or not its result is published.

**This is not a `methodology_version` bump.** Stated explicitly because the rule in §3's preamble is "any change to a formula in §3 or §4", and it is worth being precise about which side of that line this falls on:

- **No formula changed.** The fee-split rule, the filters, the confidence derivations and the aggregation are all exactly as written. Regenerating the Pact golden fixture removed four facts and left `tvl`, `volume_24h`, `gross_fees_24h`, `capital_efficiency`, `volume_to_tvl` and `pool_count` **byte-identical** — same values, same confidences. A version bump exists to tell a consumer that a number computed under the old version is no longer comparable; here every number that still exists is unchanged, and bumping would invalidate every cache key for no semantic change.
- **The methodology already required this.** §1.1 — "if a protocol cannot support that meaning, the connector declines the KPI rather than approximating it under the same name" — and §1.5 both mandate the decline. Publishing the zeroes was a **failure to apply 1.1.0 as written**, prompted by a factual error about the source ("frequently" vs 100%). Correcting a connector into compliance with the published methodology is a bug fix, not a new methodology.
- What did change is **what Pact advertises**, which is visible on `/catalog` and in the connector README, and is recorded here rather than in the changelog for that reason.

### 3.5 Connector: Folks Finance (`lending`)

**Source: on-chain.** `https://api.folks.finance/*` returns `{"message":"Forbidden"}` to anonymous callers (verified across `/v2/pools`, `/v1/pools`, `/pools`, `/health`, with and without a browser UA, 2026-09-08; **re-verified 2026-09-09 — all four still 403**). We therefore do **not** design around it. The connector reads lending-pool application state directly via algod (`https://mainnet-api.4160.nodely.dev`) using `@folks-finance/algorand-sdk` (v0.2.6, the official SDK), which exposes pool-info retrieval over app global state.

> **Implementation note (do not skip):** the exact accessor and field names must be read off `@folks-finance/algorand-sdk@0.2.6` at implementation time and pinned. Folks encodes rates and indices as fixed-point integers and the SDK exports the corresponding `ONE_*_DP` scale constants — every rate/index below must be divided by the SDK's documented constant for that field, not by an assumed one. Write a fixture test that asserts a known pool's `supply_apr` is within 1e-6 of the SDK's own derived value before wiring anything downstream. A silently wrong decimal scale here would corrupt every Folks KPI while looking entirely plausible.
>
> **[1.2.0] Resolved, and recorded so it is never inferred again.** The scales, read off the SDK's own JSDoc (`dist/lend/formulae.js`) and its `retrievePoolInfo` (`dist/lend/deposit.js`):
>
> | Field | Scale | SDK constant |
> |---|---|---|
> | `depositInterestRate`, `variableBorrowInterestRate`, `stableBorrowInterestRate` | 16 dp | `ONE_16_DP` |
> | `retentionRate`, `optimalUtilisationRatio`, the `vr*`/`sr*` curve parameters | 16 dp | `ONE_16_DP` |
> | `depositInterestIndex`, `variableBorrowInterestIndex` | **14 dp** | `ONE_14_DP` |
> | `totalDeposits`, `totalVariableBorrowAmount`, `totalStableBorrowAmount` | 0 dp (asset units) | `10^assetDecimals` |
> | `overallStableBorrowInterestAmount` | 16 dp, as a 128-bit pair | `high × UINT64 + low` |
>
> **Two scales coexist in one struct** — rates at 16 dp, indices at 14 dp — which is exactly why none may be assumed. The required test passes: over all 25 live markets on 2026-09-09 the largest disagreement with the SDK's own `retrievePoolInfo` was **0** for `supply_apr` and **9.6e-17** for the blended borrow rate. Verifying the scales *first*, independently, is what made the §3.5 formula error below diagnosable rather than confusing.

**Raw values pulled per lending pool (per-asset market):**

| Value | Meaning |
|---|---|
| `depositTotal` (a.k.a. total deposits), in asset units | Supplied liquidity |
| `variableBorrowTotal` (+ stable borrow total if present), in asset units | Outstanding debt |
| `depositInterestRate` | Annualized rate paid **to** depositors (fixed-point) |
| `variableBorrowInterestRate` (and stable equivalent) | Annualized rate paid **by** borrowers (fixed-point) |
| `overallStableBorrowInterestAmount` | Σ (stable principal × the rate it was fixed at). An amount×rate, not a rate — it is what makes a blended borrow rate computable |
| `retentionRate` | Protocol's share of borrower interest (fixed-point fraction) |
| `depositInterestIndex`, `variableBorrowInterestIndex` | Cumulative indices; used for the flow cross-check below |
| asset id + decimals | Unit normalization |

**Normalization:**

```
For each market m, with P_m = price_usd(asset_m) from §3.7:

  deposits_usd(m) = depositTotal_m / 10^decimals_m * P_m

  // [1.2.0] BOTH debt types. Stable-rate debt is real debt: 54.3% of
  // ISOLATED_TINY's, 21.6% of USDC's on 2026-09-09. See the fee block below.
  borrows_usd(m)  = (variableBorrowTotal_m + stableBorrowTotal_m) / 10^decimals_m * P_m

  TVL_usd = Σ_m deposits_usd(m)
```

**TVL definition for lending — stated explicitly, because sources disagree.** We define lending TVL as **total deposits** (total value supplied to the protocol), *not* deposits minus borrows ("available liquidity"), and *not* deposits plus borrows. Rationale: it is the capital the protocol has actually attracted, it is the denominator that makes `capital_efficiency` meaningful, and it matches how a DEX's TVL is the capital sitting in its pools. Any consumer wanting available liquidity can compute `tvl * (1 - utilization)` from two KPIs we already publish. The definition is recorded in the fact's `coverage.basis` as `total_deposits`.

**[1.2.0] Which §3.6 filters apply to a lending market.** §3.6 is scoped to DEX connectors, and the reason is worth stating rather than leaving as an accident of wording. Its filters exist because enumerating a DEX means enumerating every pool anyone ever created — 22,679 for Tinyman, most of them dust or dead tokens. Folks has **25 markets, listed by the protocol itself**; there is no dust problem to solve, and applying a $1,000 floor would drop real protocol markets while making our TVL disagree with Folks' own for no gain. So for `lending`:

1. **Exclude** a market whose asset the §3.7 ladder cannot price — mandatory, since the chain reports asset units and every dollar KPI is a conversion. Counted in `coverage.excluded`, never contributed as a zero.
2. **Exclude** a market whose application state cannot be read or decoded. Counted, and the snapshot is marked `partial`.
3. **No dust floor, and no exclusion by the on-chain deprecation flag.** Deprecated markets still hold real deposits and are still being wound down; excluding them would understate the protocol. The count of deprecated markets included is reported in `notes` instead.

`coverage.basis` is `total_deposits` rather than a §3.6 basis, and `?basis=verified_only` is **not** supported: it selects on a DEX curation flag that has no lending analogue, and answering it with the default would silently return a different number than the one asked for.

**Utilization:**

```
utilization = Σ_m borrows_usd(m) / Σ_m deposits_usd(m)      // RATIO, protocol-wide
```

Protocol-wide utilization is deposit-weighted by construction (a ratio of sums, not a mean of ratios), which is the correct aggregation — an unweighted mean across markets would let a dust market with 99% utilization dominate.

**Fee flows — the lending analogue of swap fees:**

```
// [1.2.0] overallBorrowInterestRate_m is the DEBT-WEIGHTED blend of the
// variable and stable rates — the SDK's calcOverallBorrowInterestRate:
//     (variableBorrowTotal * variableRate + overallStableBorrowInterestAmount)
//     / (variableBorrowTotal + stableBorrowTotal)
gross_fees_24h          = Σ_m ( borrows_usd(m) * overallBorrowInterestRate_m ) / 365
supply_side_revenue_24h = Σ_m ( deposits_usd(m) * depositInterestRate_m )      / 365
protocol_revenue_24h    = gross_fees_24h - supply_side_revenue_24h
```

**[corrected, 1.2.0] The rate is the blend, not the variable rate.** Until 1.2.0 this block read `Σ (borrows_usd × variableBorrowInterestRate)` with `borrows_usd` defined from `variableBorrowTotal` alone. That drops stable-rate debt from both the principal and the rate, while `supply_side_revenue_24h` is computed from `depositInterestRate` — which Folks derives from the *blended* rate. The two sides of §3.1 were being computed over different populations. Measured live 2026-09-09 across 25 markets: gross fees understated by 12.4%, protocol revenue by 87%, `total_borrows` by 7.7%, and **7 of 24 markets returned a negative `protocol_revenue_24h`** — depositors paid more than borrowers, which is impossible rather than imprecise. The retention cross-check below fired at 12.13% and is what surfaced it. See the 1.2.0 changelog.

Notes on this block, in order of how easy each is to get wrong:

- **`gross_fees` is driven by `borrows`, not `deposits`.** Borrowers pay; depositors receive. Using deposits here is the classic error and would inflate fees by `1/utilization` — on the live protocol on 2026-09-09 that is a factor of 2.97.
- **The `/365` is a simple-interest daily slice of an annualized rate.** It answers "what did borrowers pay in the last 24h at the current rate," which is the same trailing-24h question the DEX connectors answer. It is *not* compounded, and it is an instantaneous-rate snapshot rather than a true integral over the day, so it is `is_estimated: true`, `estimation_method: "annualized_rate_to_daily_simple"`, confidence capped at 0.85 (§5). If rates moved materially during the day, our figure reflects the current rate, not the average one.
- **`protocol_revenue` is computed by residual, then validated against `retentionRate`.** Compute `expected = gross_fees_24h * retentionRate_weighted`, weighting each market's `retentionRate` by the gross fees it contributed. If `|residual − expected| / gross_fees_24h > 0.05`, keep the residual (it is the true accounting identity) but add a `note` reporting the divergence and drop confidence by 0.1. The residual is authoritative because §3.1 is an identity; the retention rate is a cross-check on our decimal scaling — a mismatch here is the most likely symptom of the fixed-point bug warned about above.

  **[1.2.0] It works, and it earned its place.** Under the corrected formula the divergence is **0.000000%** live: the residual and the retention-rate prediction agree to floating-point noise. That agreement is a genuine three-way check, not a restatement — gross fees come from borrows and the borrow rate, supply-side revenue from deposits and the deposit rate, and `retentionRate` is a third independent field. A wrong scale on any one of them breaks it. Under the pre-1.2.0 formula it read **12.13%**, which is how the formula error was found.
- **A future exact method** (post-MVP): diff `depositInterestIndex` and `variableBorrowInterestIndex` between two snapshots 24h apart to get realized rather than run-rate interest. The snapshotter is already writing the data needed for this; it becomes available once we have 24h of history, and will raise confidence to 0.95.

**Cross-check:** `https://api.llama.fi/protocol/folks-finance-lending` publishes `currentChainTvls.Algorand` and `.Algorand-borrowed` (verified live: $23.83M / $12.20M on 2026-09-08; $24.38M / $12.45M on 2026-09-09). We compare our TVL to theirs and, if they diverge by more than 10%, add a `note` with both figures. DefiLlama is **never** a value source — only a divergence signal, since its methodology is its own and adopting it would defeat the purpose of having ours.

**[1.2.0] The TVL divergence is the DEFINITION, and that is checkable.** Measured 2026-09-09:

| | ours | DefiLlama | divergence |
|---|---|---|---|
| `total_borrows` | $12,458,496 | $12,413,942 | **+0.36%** |
| `tvl` (total deposits) | $36,958,555 | $24,376,995 | **+52.14%** |
| deposits − borrows | $24,500,059 | $24,376,995 | **+0.85%** |

The borrow figures agree to a third of a percent, so the pricing and the market coverage are sound. The 52% TVL gap is **entirely** the definitional choice this section makes: DefiLlama publishes Folks' TVL as *available liquidity* (deposits minus borrows), while we define lending TVL as *total deposits*. Restating ours on their definition closes the gap to 0.85%.

This is why the divergence is reported rather than acted on. A 52% gap looks like a bug and is not one; it is two defensible definitions, and the like-for-like restatement is what distinguishes the two cases. **A connector that "fixed" this by adopting DefiLlama's definition would be adopting DefiLlama's methodology** — which §1.4 and this paragraph both exist to prevent. Both divergences, raw and post-filter, plus the like-for-like restatement, are printed by `scripts/folks-live.ts`.

The same care applies to `utilization`. Ours is `borrows / deposits` = 0.3371. Dividing DefiLlama's `borrowed` by DefiLlama's `TVL` gives 0.5110 — but that is `borrows / (deposits − borrows)`, which is not a utilisation at all. Reconstructing their implied deposits as `TVL + borrowed` gives **0.3382**, against our 0.3371: a difference of 0.0011.

### 3.6 Inclusion filters (applied identically to all DEX connectors)

Aggregating every pool means aggregating thousands of dust and scam pools, which corrupts TVL and makes `capital_efficiency` meaningless. The default basis is `all_pools_usd_priced`:

1. **Exclude** pools with no reliable USD price for at least one side — §3.7 exhausted, *or* the best price it found sits below `MIN_PRICE_CONFIDENCE` (§3.7 rank 5). Counted in `coverage.excluded`.
2. **Exclude** pools with `tvl_usd < $1,000`. Below this, rounding and price noise exceed signal.
3. **Exclude** deprecated pools (`is_deprecated: true` on Pact).
4. **Include** unverified pools that pass 1–3, but report the verified/unverified split in `notes`. Excluding by verification flag alone would import each protocol's curation policy into our numbers, which breaks comparability between a protocol that verifies aggressively and one that doesn't.
5. **`?basis=verified_only`** is an optional query param that additionally requires `is_verified` (Tinyman) / `is_verified || auto_verified_100k` (Pact). `coverage.basis` always states which was used.

The threshold and the flags are constants in `src/standardize/types.ts`, versioned with `methodology_version`.

**A note on the exclusion ratio.** Enumerating V2 from the chain means enumerating every pool ever created, including 10,236 with empty reserves and thousands more holding a few dollars of a dead token. On 2026-09-09, 411 of 22,679 enumerated pools passed these filters, so §5's high-exclusion penalty fires on every Tinyman fact and will continue to. That is the intended reading: a venue whose reported aggregate describes 1.8% of its nominal pool count is a venue where the filters are doing most of the work, and the confidence says so. `coverage.entities + coverage.excluded` always reconciles to the full enumeration, so a buyer can check the arithmetic.

### 3.7 Price service

Resolution order per asset, first hit wins:

| Rank | Source | Confidence contribution |
|---|---|---|
| 1 | USDC (`31566704`), USDt, and other verified stables → hardcoded `1.00` | 1.00 |
| 2 | Tinyman: price **derived from pool reserves**, `reserves_in_usd / (reserves / 10^decimals)`, taking the deepest pool side; gated on the asset's `liquidity_in_usd` ≥ $50k from `/api/v1/assets/?ids=<csv>` *[corrected]* | 0.95 |
| 3 | Pact `primary_asset.price` / `secondary_asset.price`, for assets in a pool with ≥ $50k `tvl_usd` | 0.90 |
| 4 | `https://api.vestigelabs.org/assets/list` — carries its own `confidence` field, which we **multiply** into ours. Its `price` is denominated in **ALGO, not USD** *[corrected]*, so it is multiplied by the ALGO price from ranks 1–3; if ALGO is unpriced, the whole rung is skipped | 0.85 × upstream confidence |
| 5 | none, **or a price whose resolved confidence is below `MIN_PRICE_CONFIDENCE` (0.10)** → asset is unpriced; every pool touching it is excluded (§3.6.1) | — |

**[1.1.0] The rank-5 confidence gate.** A price the ladder itself grades below 0.10 — the same floor §5 applies to a fact — is not a measurement, and the asset falls to rank 5. This is new in 1.1.0 because before 1.1.0 it could not have mattered: the ladder's output decided only which pools were *includable*, and a nonsense price on a dust pool changed nothing. Now it multiplies on-chain reserves.

The failure it prevents is not hypothetical. Verified live 2026-09-09: Vestige quotes **Barya** and **Golden Nuggets** — two assets with $0.00 and $15.34 of liquidity between them — with `confidence` values of 6.0e-10 and 6.7e-10. Ungated, those two rows alone reported **$69.2 billion** of Tinyman V2 TVL, roughly a fifth of Algorand's market capitalisation, produced silently by a pool nobody would ever look at. With the gate, Tinyman V2 TVL is $5.24M and those assets are two visible, counted exclusions. The gate costs 220 of 6,883 live pools and $3,949 of one-sided value (measured below); it is one of the cheapest guarantees in this document.

**[1.1.0] Rank 2 was re-examined and deliberately left alone.** With V2 reserves now on-chain for 17,119 pools, rank 2 could in principle bootstrap a price for any asset paired against an already-priced one, instead of relying on the analytics API's USD reserve figures. Measured before deciding: across every live V2 pool, the pools with exactly one priced side hold **$3,949** of priced value in total, the largest single one being $3,154. Bootstrapping would therefore add under ~$8k of TVL — 0.15% — on pools that almost all fail the §3.6 $1k floor anyway, while introducing a propagation step whose pricing error compounds hop by hop. **Not adopted.** The measurement is recorded here so the question does not get re-opened from first principles.

**The rank-4 ALGO guard still holds.** Re-verified 2026-09-09: Vestige returns ALGO at exactly `price: 1.0, confidence: 1.0`, and ALGO resolves through rank 2 at $0.1009. The guard — skip rank 4 entirely if that row ever stops being exactly `1.0` — is unchanged and still active.

**[corrected] Two things about this ladder that the original probe missed, both verified live 2026-09-08.**

*Rank 2 has no price field to read.* `/api/v1/assets/` publishes `liquidity_in_usd`, `last_day_volume_in_usd` and `last_day_price_change`, and no price at all. "`liquidity_in_usd`-backed price" therefore means a price *derived* from pool reserves, with the assets endpoint supplying the $50k gate. `?ids=<csv>` is a real filter on that endpoint, which is what keeps the gate from costing 36 pages of a 35,250-asset catalogue.

*Rank 4 quotes in ALGO.* Vestige returns ALGO at exactly `price: 1.0, confidence: 1.0` and USDC at `10.028`, against a spot ALGO of ~$0.0997. Read as USD, every rank-4 asset would have been ~10x too expensive — silently, since nothing downstream would look wrong. The service converts with the rank-1–3 ALGO price and guards the assumption: if Vestige's ALGO row ever stops being exactly `1.0`, rank 4 is skipped entirely and its assets fall to rank 5 (a visible exclusion) rather than being trusted.

ALGO (asset id `0`) is priced by the same ladder; it is the denominator of a large share of pools, so its price confidence propagates widely. It is resolved on every call whether or not it was requested, because rank 4 cannot run without it. Prices cache for 60s (`ARCHITECTURE.md` §6) — the shortest TTL in the system, because a stale price silently corrupts every USD-denominated KPI downstream.

---

## 4. KPI registry

`class` column: which protocol classes the KPI is defined for. Requesting an inapplicable pair returns 404 / `KPI_NOT_APPLICABLE`, never a zero.

| KPI id | Unit | Classes | Definition | TTL |
|---|---|---|---|---|
| `tvl` | USD | dex, lending | DEX: Σ pool liquidity. Lending: Σ total deposits (§3.5). | 300s |
| `volume_24h` | USD | dex | Σ USD notional swapped, trailing 24h. | 600s |
| `gross_fees_24h` | USD | dex, lending | Total paid by users, §3.1. | 600s |
| `supply_side_revenue_24h` | USD | dex, lending | Portion to LPs/depositors, §3.1. | 600s |
| `protocol_revenue_24h` | USD | dex, lending | Portion the protocol keeps, §3.1. **The comparable "revenue".** | 600s |
| `take_rate` | RATIO | dex, lending | `protocol_revenue_24h / gross_fees_24h`. Null if gross_fees < $1. | 600s |
| `capital_efficiency` | RATIO | dex, lending | `(gross_fees_24h * 365) / tvl` — annualized fees generated per dollar of capital. **The flagship cross-type ratio.** | 600s |
| `fee_apr` | RATIO | dex | `(supply_side_revenue_24h * 365) / tvl` — LP yield from fees only, incentives excluded (§3.1). | 600s |
| `volume_to_tvl` | RATIO | dex | `volume_24h / tvl` — turnover. DEX-only by construction. | 600s |
| `supply_apr` | RATIO | lending | Deposit-weighted mean `depositInterestRate`. | 120s |
| `borrow_apr` | RATIO | lending | Borrow-weighted mean `variableBorrowInterestRate`. | 120s |
| `utilization` | RATIO | lending | `total_borrows_usd / total_deposits_usd`, §3.5. | 120s |
| `total_borrows` | USD | lending | Σ outstanding debt, USD. | 300s |
| `active_users_24h` | COUNT | dex, lending | §4.1 below. | 900s |
| `pool_count` | COUNT | dex, lending | Entities passing §3.6 filters. | 900s |

**Why `capital_efficiency` is the flagship:** it is the one ratio that answers the buyer's actual question — *where is capital working hardest?* — and it is only computable *because* §3.2 made `gross_fees` mean one thing across classes. A DEX at 0.18 and a lending market at 0.06 is a directly meaningful comparison. That sentence is the entire product thesis in one line.

### 4.1 `active_users_24h` — a deliberately conservative definition

**Definition:** the count of distinct Algorand addresses that submitted at least one transaction in the trailing 24h whose effect was a *core protocol interaction* — for a DEX, a swap or a liquidity add/remove; for a lending market, a deposit, withdraw, borrow, or repay.

**Computation:** Nodely Indexer, `/v2/transactions` filtered by `application-id` (the protocol's app ids) over the trailing-24h round range, paged, collecting distinct `sender`. App ids are declared per-connector, not hardcoded in the standardization layer.

**Documented limitations, surfaced in every such fact's `notes`:**
- Counts **addresses, not humans.** One person with three wallets is three; a router contract batching for many users may be one. We do not attempt de-duplication, because any heuristic would be unfalsifiable.
- Interactions routed through an aggregator are attributed to the aggregator's sender.
- `confidence` is capped at **0.80** for this KPI, always, on every protocol. It is the least reliable metric we publish and it is labeled as such rather than being quietly presented alongside a TVL figure that is 20× more trustworthy.

If a connector cannot enumerate its app ids reliably, it **declines** this KPI. It does not approximate it.

### 4.2 Deliberately absent from v1

`p_f_ratio`, `p_s_ratio`, `market_cap`, `fdv`, `treasury` — all require token valuation data and a circulating-supply policy, which is a separate methodology with its own failure modes. Publishing a half-considered P/F ratio would undercut the credibility of the ratios we did think through. Post-MVP, behind a `methodology_version` bump.

---

## 5. Confidence scoring

`confidence ∈ [0,1]`, computed as `base × penalties`, floored at 0.1 and rounded to 2dp.

**Base, by derivation:**

| Derivation | Base |
|---|---|
| Directly reported by the protocol's own API in the requested unit | 0.95 |
| Directly read from on-chain state | 0.95 |
| Arithmetic on directly-reported values (sums, residuals, ratios) | 0.90 |
| Requires a USD price conversion | 0.90 × price_confidence (§3.7) |
| Requires a documented estimation (e.g. annualized→daily, §3.5) | 0.85 |
| Requires a fallback constant (e.g. Tinyman V2 default fee ratio) | 0.70 |
| Indexer aggregation over addresses (`active_users_24h`) | **0.80 hard cap** |

**Multiplicative penalties:**

| Condition | Multiplier |
|---|---|
| Served stale from L1 past TTL | 0.90 |
| Served from L2 last-known-good snapshot | 0.70, and `confidence` floored at **0.4** |
| `coverage.excluded / (entities + excluded) > 0.10` | 0.90 |
| DefiLlama cross-check divergence > 10% | 0.90 |
| Folks retention-rate cross-check divergence > 5% | subtract 0.10 (additive, §3.5) |
| Any upstream field failed zod validation and was skipped | 0.85 |

**Composite facts** (`/compare`, and any ratio spanning two facts) take the **minimum** confidence of their inputs, not the mean. A comparison is only as trustworthy as its weakest side, and averaging would hide exactly the case a risk agent needs to see.

**A sum built from many prices takes the TVL-weighted mean of their price confidences** (new in 1.1.0). This is not an exception to the minimum rule; it is a different object. The minimum rule governs a composite spanning *two facts*, where the weak leg is half the answer. An aggregate over hundreds of pools is a sum of dollars, and the minimum there would let a single $1,000 pool priced at 0.10 grade a $5.4M number that is 97% ALGO, USDC and tALGO. The weighted mean grades the dollars, which is what the number is. Within one pool the minimum still applies: a pool's TVL is only as well-priced as its worse-priced side.

**Why Tinyman TVL's confidence went DOWN in 1.1.0, from 0.86 to 0.70.** The reserves are read on-chain, which is the 0.95 row — but the fact is denominated in USD, and reserves are not dollars. Converting them is exactly what the `usd_conversion` row is for, so TVL is graded `0.90 × price_confidence` (0.90 × ~0.86 weighted, × the high-exclusion penalty) rather than the 0.95 `reported` row the analytics API's own USD figure earned. It would have been easy to argue the other way — the measurement is unambiguously better, it reaches 100% of the venue instead of 5.4% — and the stamped number would then have gone up. It reads the other way here on purpose: **`confidence` grades the derivation, not our satisfaction with it.** A 1.0.0 TVL was a dollar figure Tinyman asserted and we copied; a 1.1.0 TVL is a dollar figure we computed, and its weak link is the price, which is now visible in the grade. The improvement in *accuracy* is the −56.7% → −6.6% move against DefiLlama, and that belongs in the cross-check, not in the confidence.

**Contract with buyers:** `confidence ≥ 0.9` = safe to act on. `0.7–0.9` = directionally sound, check `notes`. `< 0.7` = informational; `/ask` must explicitly caveat it in prose. This ladder is published at `/methodology`.

---

## 6. Worked example — the comparison that shows the methodology working

`GET /compare?protocols=tinyman,folks&metric=capital_efficiency`

```
Tinyman (dex)
  gross_fees_24h  = Σ last_day_fees_in_usd over the V1.1 + V2 pools passing
                    §3.6 that carried a 24h flow
                  = $1,111.20
  tvl             = Σ (V2 on-chain reserves × §3.7 prices) + Σ V1.1 liquidity_in_usd
                  = $5,379,486          (411 pools; DefiLlama says $5,761,501)
  capital_efficiency = 1111.20 * 365 / 5_379_486 = 0.0754  (7.5% annualized)

Folks (lending)
  gross_fees_24h  = Σ (borrows_usd * overallBorrowInterestRate) / 365
                  = $1,989.14          (12,387,392 borrowed at a blended 5.88%)
  tvl             = Σ deposits_usd = $36,958,555     (25 markets, total deposits)
  capital_efficiency = 1989.14 * 365 / 36_958_555 = 0.0196  (2.0% annualized)
```

*(Both sides are now live runs of 2026-09-09 — `scripts/tinyman-live.ts` and `scripts/folks-live.ts`. Until 1.2.0 the Folks side of this example was illustrative, and it was illustrative in a way worth naming: it used DefiLlama's $23.8M as if that figure were total deposits, when DefiLlama publishes Folks TVL as deposits minus borrows. The example therefore divided a real fee by a denominator on someone else's definition and produced 0.031 instead of 0.0196 — a 58% overstatement of the flagship ratio, in the document that defines it. Replaced with measured values.)*

Two protocols with entirely different mechanics, one number, honestly comparable — because `gross_fees` was defined once (§3.1), mapped per class (§3.2), and computed with the same filters (§3.6) and the same USD ladder (§3.7). Every step is visible in `source[]`, `notes[]`, and `confidence`.

That is the product.
