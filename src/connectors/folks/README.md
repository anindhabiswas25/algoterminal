# Folks Finance connector (`lending`)

**Class:** `lending` — the only one in v1, and the connector that proves the
§3.1 cross-type accounting policy actually works.
**Source:** on chain, via `ctx.algod`. The REST API is closed.
**SDK:** `@folks-finance/algorand-sdk@0.2.6`, pinned exactly.
**Spec:** `DATA_SCHEMA.md` §3.5. **Methodology:** 1.2.0.

---

## Who pays whom

**A borrower pays interest on their outstanding debt, continuously, at a rate
the market derives from its own utilisation.** That interest is the whole
revenue event. Most of it is credited to the depositors whose capital is being
borrowed; Folks keeps the rest — a per-market `retentionRate`, 10% to 30% on
the live markets, which is a reserve factor by another name.

In §3.1's terms: borrower interest is `gross_fees_24h`, depositor interest is
`supply_side_revenue_24h`, and the retained remainder is
`protocol_revenue_24h`.

**Borrower interest is the DEX swap fee of a lending protocol.** Both are the
price a user pays for the protocol's core service, and both split between the
parties supplying capital and the protocol itself. That one mapping is what
makes `take_rate` and `capital_efficiency` mean the same thing here as they do
for Tinyman — which is the entire reason this connector exists.

**Deposit interest is not a second fee.** It is the same dollars seen from the
receiving end. A connector that added deposit interest to borrow interest would
double-count the whole flow; that is the most common error in ad-hoc DeFi
comparisons, and §3.1 is written as an identity rather than three definitions
precisely to make it impossible to commit here.

One consequence is worth stating because it surprises people: **`gross_fees_24h`
is driven by borrows, not by deposits.** Only borrowed capital pays. Computing
fees from deposits inflates them by `1/utilization` — a factor of **2.97** on
the live protocol.

---

## Verification (§Step 2)

### The REST API is closed — re-verified 2026-09-09

```
GET https://api.folks.finance/v2/pools   -> 403 {"message":"Forbidden"}
GET https://api.folks.finance/v1/pools   -> 403 {"message":"Forbidden"}
GET https://api.folks.finance/pools      -> 403 {"message":"Forbidden"}
GET https://api.folks.finance/health     -> 403 {"message":"Forbidden"}
```

Anonymously and with a Chrome User-Agent; all four unchanged from the 2026-09-08
probe. §Step 2's source preference then selects option 2: on-chain application
state via algod, through the protocol's official SDK. There is no option 4 — we
do not scrape, proxy, or key a closed API. `scripts/folks-live.ts` re-runs these
four probes on every live run, so the day the API opens is a day we notice.

### What is read

25 lending markets, one application each, from `MainnetPools` in the pinned SDK.
Each market's entire configuration is in that application's **global state**,
packed as byte slices holding arrays of `uint64`:

| key | contents |
|---|---|
| `v` | variable-borrow curve, total, rate, index |
| `s` | stable-borrow curve, total, rate, and a 128-bit accrued-interest amount |
| `i` | retention rate, total deposits, deposit rate, deposit index, last update |
| `co` | config bits — deprecated, rewards paused, stable supported, flash loans |

---

## The fixed-point scales — §3.5's "do not skip"

§3.5 warns that a wrong decimal scale here "produces numbers that are entirely
plausible and entirely wrong." It is right, and the trap is sharper than it
looks: **two different scales coexist in one struct.**

| Field | Scale | SDK constant |
|---|---|---|
| `depositInterestRate`, `variableBorrowInterestRate`, `stableBorrowInterestRate` | 16 dp | `ONE_16_DP` |
| `retentionRate`, `optimalUtilisationRatio`, the `vr*`/`sr*` curve parameters | 16 dp | `ONE_16_DP` |
| `depositInterestIndex`, `variableBorrowInterestIndex` | **14 dp** | `ONE_14_DP` |
| `totalDeposits`, `totalVariableBorrowAmount`, `totalStableBorrowAmount` | 0 dp | `10^assetDecimals` |
| `overallStableBorrowInterestAmount` | 16 dp, 128-bit pair | `high × UINT64 + low` |

Read a 16 dp rate at 14 dp and ALGO's 1.96% deposit rate becomes 196% — a
number that is still positive, still plausible for a "high yield" headline, and
wrong by 100×.

So **no scale in this connector is written down as a literal.**
`constants.ts` names the SDK's own constant for each field, sourced from the
SDK's JSDoc (`dist/lend/formulae.js`, which annotates every parameter and
return with its dp) and from `retrievePoolInfo` (`dist/lend/deposit.js`, which
pairs each raw slot with the constant it is scaled by). The SDK version is
pinned exactly — `0.2.6`, not `^0.2.6` — because a minor release that re-scaled
a field would silently change every number we publish.

### The agreement test, and its result

`test/connectors/folks/folks.test.ts` §0 asserts our decoding and scaling
reproduce the SDK's own `retrievePoolInfo` on recorded state. Measured over all
25 live markets, 2026-09-09:

| quantity | largest disagreement with the SDK |
|---|---|
| `supply_apr` (the §3.5 requirement, tolerance 1e-6) | **0** |
| blended borrow rate | **9.6e-17** |
| retention rate, deposits, variable/stable borrows | **0** |

Zero, not "within tolerance." The fixture also carries `OPUL`, which has **10
asset decimals** rather than the usual 6 or 8, so the amount scaling is
exercised on a non-default case.

Verifying the scales *first and independently* is what made the formula error
below diagnosable instead of merely confusing.

---

## What §3.5 got wrong: the borrow rate

§3.5 specified:

```
gross_fees_24h = Σ (borrows_usd × variableBorrowInterestRate) / 365
```

with `borrows_usd` defined from `variableBorrowTotal`. **Folks markets carry
stable-rate debt as well**, and stable borrowers pay the rate that was fixed
when they borrowed. Live 2026-09-09, stable debt was 1.8% of ALGO's, 21.6% of
USDC's, and **54.3% of ISOLATED_TINY's** — more than half.

The literal formula drops that debt from both the principal and the rate, while
`supply_side_revenue_24h` is computed from `depositInterestRate` — which Folks
itself derives from the **blended** rate. The two halves of §3.1 were being
computed over different populations.

| | §3.5 as written | this connector |
|---|---|---|
| `gross_fees_24h` | $1,742.54 | **$1,989.14** |
| `protocol_revenue_24h` | $36.93 | **$283.54** |
| retention divergence | **12.13%** — fires the 5% detector | **0.000000%** |
| markets with negative protocol revenue | **7 of 24** | 0 |
| markets failing the 5% check individually | 8 of 24 | 0 |
| `total_borrows` vs DefiLlama | understated 7.7% | **+0.36%** |

Two of those rows say different things. The 12.13% divergence is the *detector
working*. The seven negative markets are the *incoherence*: a negative
`protocol_revenue_24h` means depositors were paid more than borrowers paid,
which is not an imprecision but an impossibility.

So this connector multiplies total debt by the debt-weighted blend of the two
rates — the SDK's `calcOverallBorrowInterestRate`:

```
overallBorrowInterestRate =
    (variableBorrowTotal × variableRate + overallStableBorrowInterestAmount)
  / (variableBorrowTotal + stableBorrowTotal)
```

`DATA_SCHEMA.md` §3.5 has been corrected to match, with a `methodology_version`
bump to **1.2.0** — a §3 formula changed and five published values moved, which
is exactly what §3's opening promise says gets a bump.

### How the diagnosis went, in order

§3.5 says: "if it fires, suspect your decimal scale before suspecting Folks."
That is good advice and it was followed:

1. The scales were verified against the SDK first, independently of any of our
   formulas. Largest disagreement: 0.
2. Only then was the formula the remaining candidate.
3. Under the blended rate the residual and the retention-rate prediction agree
   to floating-point noise — and that agreement is a real three-way check, not a
   restatement: gross fees come from borrows and the borrow rate, supply-side
   revenue from deposits and the deposit rate, and `retentionRate` is a third
   independent field. A wrong scale on any one of them breaks it.

The order matters. Had the formula been "fixed" first, the scales would have
been left unverified and the agreement would have been a coincidence nobody
checked.

---

## Normalization

| Our KPI | Formula | Notes |
|---|---|---|
| `tvl` | `Σ deposits_usd` | **Total deposits.** Not deposits − borrows, not deposits + borrows. §3.5, and `coverage.basis: total_deposits` |
| `total_borrows` | `Σ (variable + stable) × price` | Both debt types |
| `utilization` | `Σ borrows_usd / Σ deposits_usd` | A ratio of **sums**, so deposit-weighted by construction |
| `supply_apr` | deposit-USD-weighted mean `depositInterestRate` | §4 |
| `borrow_apr` | borrow-USD-weighted mean **blended** borrow rate | §4 |
| `gross_fees_24h` | `Σ (borrows_usd × blended rate) / 365` | Estimated; see below |
| `supply_side_revenue_24h` | `Σ (deposits_usd × depositInterestRate) / 365` | Computed independently, not as a residual |
| `protocol_revenue_24h` | `gross − supply_side` | Residual, validated against `retentionRate` |
| `take_rate` | `protocol_revenue / gross` | Omitted below $1 of fees (§4) |
| `capital_efficiency` | `gross × 365 / tvl` | The flagship cross-type ratio |
| `active_users_24h` | distinct senders, 32 app ids, trailing 24h | §4.1; capped at 0.80 |
| `pool_count` | included markets | Markets, not pools |

Prices come from the §3.7 ladder via `ctx.prices`, never from Folks' own oracle.
The oracle exists (`MainnetOracle`, 14 dp prices) and using it would introduce a
second pricing methodology into a product whose entire proposition is having one
(§4.3). It is a candidate *cross-check*, not a source; not adopted yet.

### Why `utilization` is a ratio of sums

An unweighted mean of per-market utilisations would let a market holding $3 at
99% utilisation outvote one holding $12M at 3%. The live numbers show the size
of that: ALGO sits at 0.688 and xALGO at 0.003, and the protocol-wide answer is
0.337 because the sums are what matter.

### The `/365`, and why every flow is `is_estimated`

It is a simple-interest daily slice of an **annualized, instantaneous** rate. It
answers "what did borrowers pay in the last 24h at the current rate" — the same
trailing-24h question the DEX connectors answer — but it is not compounded and
it is a snapshot rather than an integral over the day. If rates moved during the
day, this reflects the current rate, not the average one. So every flow KPI
carries `is_estimated: true` and `estimation_method:
'annualized_rate_to_daily_simple'`.

The exact method is post-MVP and its inputs are already being collected: diffing
`depositInterestIndex` and `variableBorrowInterestIndex` between two snapshots
24h apart gives realized rather than run-rate interest. This connector reads
both indices into the snapshot and performs **no arithmetic** with them, so the
snapshotter accumulates the history that method needs.

---

## Coverage

The market list is the SDK's pinned `MainnetPools` — 25 markets on 2026-09-09.
There is no pagination and no cursor, so "did we see everything" is answered by
counting rather than by trusting a `next-token`.

**That the list lives in the SDK is a real dependency.** A market Folks deploys
but has not yet shipped in an SDK release is invisible to us until we bump the
pin. The alternative — enumerating from the pool-manager application on chain —
is the post-MVP improvement; it is not needed yet because the SDK is the
protocol's own release artifact and the market set changes a few times a year,
but it is a dependency rather than a non-issue and is recorded as one.

Which markets are excluded, and why, is in `DATA_SCHEMA.md` §3.5's filter block.
The short version: unpriceable or unreadable markets only. **No dust floor and
no exclusion by the deprecation flag** — Folks publishes 25 curated markets, not
22,679 pools, so §3.6's dust problem does not exist here, and dropping the three
deprecated markets would understate a protocol that is still winding them down.
The deprecated count is reported in `notes` instead.

---

## Active users

Declared, unlike on Pact — and the difference is worth stating, because §4.1's
rule is the same in both cases and the evidence is what differs.

§4.1 says a connector that cannot reliably enumerate its app ids **declines**
the KPI. Pact cannot: every pool is its own application, 3,961 of them. Folks
can: the SDK pins 25 market applications and six loan applications, and the
deposits application manages deposit escrows.

Verified before declaring, 2026-09-09, over the trailing 24h:

| | |
|---|---|
| applications scanned | 32 |
| transactions | 10,279 |
| distinct senders | **141** |
| senders that were Folks application addresses | **0** |
| indexer requests / wall time | 65 / 20 s |

The zero matters. If inner transactions were attributed to application accounts
the count would be measuring the protocol talking to itself. They are not: the
indexer's `application-id` filter returns top-level transactions, whose senders
are user addresses.

**The deposit-staking application is deliberately not scanned.** Staking an
f-token for rewards is not a deposit, withdraw, borrow or repay. §4.1 defines
this count by the interaction, not by the brand, and including it would widen
the definition for one protocol and break the comparison the count exists for.

The scan runs only when `active_users_24h` is requested — `opts.kpis` gates it —
which is what keeps the fast refresh cycle to 25 global-state reads.

---

## Cross-check: DefiLlama

`https://api.llama.fi/protocol/folks-finance-lending`, 2026-09-09:

| | ours | DefiLlama | divergence |
|---|---|---|---|
| `total_borrows` | $12,458,496 | $12,413,942 | **+0.36%** |
| `tvl` (total deposits) | $36,958,555 | $24,376,995 | **+52.14%** |
| deposits − borrows | $24,500,059 | $24,376,995 | **+0.85%** |

Both divergences are reported because they answer different questions, and here
the pair is diagnostic in a way either alone would not be.

The borrow figures agree to a third of a percent. That is independent
corroboration of the prices, the market coverage, and the decision to count
stable debt — 25 markets, a dozen assets, two independent pricing
methodologies, landing within 0.36%.

The 52% TVL gap is **not** a measurement error. DefiLlama publishes Folks' TVL
as *available liquidity* — deposits minus borrows — while §3.5 defines lending
TVL as *total deposits*. Restating ours on their definition closes it to 0.85%.
That restatement is what turns "we disagree by half" into "we disagree about a
definition, and by nothing else," and it is printed on every live run.

A connector that "fixed" the gap by adopting DefiLlama's definition would be
adopting DefiLlama's methodology. DefiLlama is a divergence signal, never a
value source.

**`utilization` needs the same care.** Ours is `borrows / deposits` = 0.3371.
Naively dividing DefiLlama's `borrowed` by their `TVL` gives 0.5110 — but that
is `borrows / (deposits − borrows)`, which is not a utilisation at all.
Reconstructing their implied deposits as `TVL + borrowed` gives **0.3382**,
against our 0.3371. The live script prints the wrong figure alongside the right
one, labelled, because it is the mistake this check exists to catch.

---

## Confidence rationale (§5)

Live values, 2026-09-09:

| KPI | Derivation | Base | Live |
|---|---|---|---|
| `tvl` | `usd_conversion` — 0.90 × TVL-weighted price confidence | 0.90 × ~0.90 | **0.81** |
| `total_borrows` | `usd_conversion`, borrow-weighted | 0.90 × ~0.96 | 0.87 |
| `supply_apr` | `onchain` | 0.95 | **0.95** |
| `borrow_apr` | `onchain` | 0.95 | 0.95 |
| `utilization` | `arithmetic`, then §5's composite minimum | 0.90 | 0.81 |
| `gross_fees_24h` | `documented_estimation` ∧ `usd_conversion` | min(0.85, 0.87) | **0.85** |
| `supply_side_revenue_24h` | same | | 0.85 |
| `protocol_revenue_24h` | composite minimum of the two above | | 0.85 |
| `take_rate` | composite minimum | | 0.85 |
| `capital_efficiency` | composite minimum (inherits TVL's price risk) | | 0.81 |
| `active_users_24h` | `indexer_address_aggregation` | 0.80 cap | 0.80 |
| `pool_count` | `arithmetic` | 0.90 | 0.90 |

Every one comes from `computeConfidence`; no float is hardcoded.

Three choices worth defending:

**TVL is graded as a USD conversion, not as an on-chain read**, even though the
deposits are read directly from chain state. Asset units are not dollars, and
converting them is where the risk is — the same reasoning that *lowered*
Tinyman's TVL confidence in 1.1.0. `confidence` grades the derivation, not our
satisfaction with it.

**`supply_apr` and `borrow_apr` are graded `onchain` (0.95), not as
conversions.** Their values are rates read directly from chain state; USD only
decides how the per-market rates are *weighted*. A bad price shifts the
weighting, but the result stays a rate bounded by the markets' own rates — it
cannot become a wrong dollar figure. Grading them as conversions would misstate
what can go wrong with them.

**Flow KPIs take the minimum of two derivations.** They are both a documented
estimation (the `/365`, 0.85) and a USD conversion (0.90 × price confidence). A
flow can be no better than either leg: taking only the estimation row would hide
a bad price, and taking only the price row would hide the `/365`.

`folks_retention_divergence` — the additive −0.10 of §5 — did **not** fire on
any live run. It is exercised by a test that tampers with a deposit rate, so the
penalty path is covered rather than merely available.

---

## Performance

Measured 2026-09-09, live mainnet.

**This connector, on its own** (`scripts/folks-live.ts`):

| Phase | Requests | Time |
|---|---|---|
| 25 market global-state reads | 50 (state + round each) | ~22 s cold |
| §3.7 price resolve, 22 distinct assets | ~60 | 15-22 s |
| Active-users indexer scan (slow cycle only) | 65 | ~20 s |

**Inside the real fast refresh cycle** (`scripts/refresh-cycle-bench.ts`, three
connectors, five runs):

| | folks | pact | tinyman | cycle | vs 60 s interval |
|---|---|---|---|---|---|
| Cold (fresh process, empty price cache) | 13.7-14.6 s | 3.3-3.9 s | 26.2-26.9 s | **43.2-44.9 s** | fits |
| Warm (steady state, §3.7 entries alive) | 1.6-1.9 s | 3.9-4.5 s | 12.6-13.3 s | **18.1-19.4 s** | fits |

A long-running refresher lives in the warm row; the cold row bounds a restart.
Folks costs 1.6-1.9 s warm because its 25 chain reads are cheap and the price
ladder — its expensive half — is shared with the other two connectors and
already resolved by the time its group runs.

**One cold run of the five took 66.7 s and overran the interval**, on the
first cold start of the session before any DNS or TLS reuse. It is recorded
rather than dropped as an outlier: the refresher's response to an overrun is to
skip the overlapping run, which loses one refresh silently unless someone is
watching `overruns` on `/health` — which is exactly why that counter exists. It
bounds a restart, not the steady state, and the fast cycle's KPIs have 120-300 s
TTLs, so one skipped run does not expose a stale answer.

## Files

| File | Contents |
|---|---|
| `constants.ts` | Everything taken from the SDK: market list, app ids, and **every scale constant**, each naming its source |
| `schema.ts` | Global-state decoding and the single place a scale is applied (`scaleMarket`) |
| `enumerate.ts` | I/O: the market reads and the active-users scan |
| `index.ts` | `capabilities`, `fetchRaw`, `toFacts`, `healthCheck`; the §3.5 arithmetic |
| `../../../scripts/folks-live.ts` | Live run: source re-verification, fact table, identity, retention check, both DefiLlama divergences |
| `../../../scripts/record-folks-fixtures.ts` | Fixture recorder, including the SDK's own derived values |
