# Pact connector (`dex`)

`DATA_SCHEMA.md` §3.4 · `CONNECTOR_GUIDE.md` §Step 8 · methodology_version 1.1.0

---

## Who pays whom

A swapper pays a fee on every trade through a Pact pool, set per pool and
ranging from 2 to 100 basis points. That fee is `gross_fees_24h`: it is the
price a user pays for the protocol's core service, and the top of the funnel.

The LPs who supplied that pool receive it. Pact's own cut is published per pool
as `pact_fee_bps`, a slice of the same `fee_bps` — so where that field is
populated, `protocol_revenue_24h = fees × pact_fee_bps / fee_bps` and the
remainder is `supply_side_revenue_24h`.

**On every one of the 3,961 pools in the live catalogue, `pact_fee_bps` is
`null`.** So the split is a number this connector does not have. It does not
guess one: an unknown cut is taken as zero, the pool still contributes its full
fee to `gross_fees_24h` and `supply_side_revenue_24h`, and `protocol_revenue_24h`
is published as a documented lower bound. What that means in practice is set out
under [The zero problem](#the-zero-problem), because at 100% the bound stops
being informative and the fact says so in its own `notes`.

---

## Verification (§Step 2)

Hand-verified against the live API on **2026-09-09**, anonymously, before any
code was written. These results go stale; re-run them before trusting this
section.

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'https://api.pact.fi/api/pools?limit=1'   # 200
curl -s -A 'Mozilla/5.0' -o /dev/null -w '%{http_code}\n' 'https://api.pact.fi/api/pools?limit=1'  # 200
```

| | |
|---|---|
| Endpoint | `GET https://api.pact.fi/api/pools` |
| Auth | **None.** Identical response anonymously and with a browser UA. |
| Envelope | `{ count, limit, offset, results[] }` |
| Catalogue size | **3,961** pools (`count`), all ids distinct |
| Pagination | `?limit=&offset=`, **silently capped at 500** — see [Quirks](#quirks) |
| Rate limiting | None observed. 8 concurrent pages: 200 on all, ~4s wall. |
| Full walk cost | 8 pages, **~4.1s** |
| Duplicates | **None.** 3,961 rows, 3,961 distinct `id`. (Contrast Tinyman's V1.1 list, which returns 7,418 rows over ~5,500 addresses.) |

**Every field read, and what the catalogue actually contains:**

| Field | Type | Live census (3,961 pools) |
|---|---|---|
| `id`, `on_chain_id`, `on_chain_address` | number, string, string | `id === Number(on_chain_id)` on every pool |
| `version` | number | `201` on 3,951; `100` on 10 |
| `tvl_usd` | decimal string | never null; Σ = **$1,320,943** |
| `volume_24h`, `volume_7d` | decimal string | never null; **already USD** (see below) |
| `fee_usd_24h`, `fee_usd_7d` | decimal string | never null; Σ 24h = **$165.29** |
| `fee_amount_24h`, `fee_amount_7d` | number | **`0` on all 3,961** — the field is dead |
| `fee_bps` | int | `100`×2092, `30`×743, `2`×605, `5`×424, `36`×41, `10`×24, `15`×24, `4`×8 |
| `pact_fee_bps` | int \| null | **`null` on all 3,961** |
| `pool_type` | string | `CONST`×3824, `MANAGED_WEIGHTED`×96, `STBL`×41 |
| `apr_7d`, `apr_7d_all` | decimal string | a fraction (max `0.769606`); **identical on every pool** |
| `apr_governance` | decimal string | **`0.000000` on all 3,961** |
| `is_verified` / `auto_verified_100k` / `auto_verified_1m` | bool | — |
| `is_deprecated` | bool | true on 10 — **exactly the `version: 100` pools** |
| `primary_asset` / `secondary_asset` `.price` | decimal string | **never null**; `"0.00000000"` on 738 primary / 1,600 secondary sides |

---

## What §3.4 got wrong

All three were found by the hand-verification above, before implementation. Each
is the kind that produces a confidently wrong connector rather than a failing
one, which is exactly why §Step 2 exists.

### 1. `volume_24h` is already USD — it must **not** be converted

§3.4 states, as its headline instruction, that `volume_24h` is denominated in
units of the primary asset and must be multiplied through the §3.7 ladder. It is
not, and the correction is not a matter of judgement: it rests on a constraint a
pool cannot violate.

**A pool cannot charge more fee than its own `fee_bps` on the volume that passed
through it.** So for each pool, `fee_usd_24h / volume_usd ≤ fee_bps / 10,000`.
Testing both readings against that, over the 263 live pools with a measurable
fee and volume:

| Reading | Pools where the implied fee rate is physically possible |
|---|---|
| `volume_24h` **is USD** | **262 / 263** |
| `volume_24h` × `primary_asset.price` (§3.4) | 74 / 263 — and 189 imply a fee **larger** than the pool's own rate, by up to 9.0×10⁷ |

Of the 52 pools where §3.4's reading is plausible, **44 have a primary asset
priced at exactly `1.00000000`** (USDC), where the two readings are arithmetically
identical and the test cannot distinguish them. The discriminating cases all go
the same way: `Gold/GoldDAO`, primary priced at $147.28, implies $185 of volume
from its fees, reports `volume_24h` of 223, and would report **$32,936** under
§3.4's conversion. `POW/HOG`, primary priced at $0.00027, would imply a fee rate
of 313,919 bps on a 100 bps pool.

In aggregate over the included pools: **$79,510 read as USD, against $51,934,791
converted** — a 653× overstatement, on a venue whose entire 24h fee take is
$95. `volume_to_tvl` would have read 54.8 instead of 0.082.

This connector therefore sums `volume_24h` directly, and every `volume_24h` and
`volume_to_tvl` fact says so in its `notes`, naming §3.4 and this file.

### 2. `pact_fee_bps` is null on 100% of pools, not "frequently"

§3.4 describes the field as "frequently null" and designs the lower-bound
treatment around a *mixture* of populated and null pools — the fact's `notes`
state the null share "so a buyer can see how tight the bound is". At 100% there
is no mixture and the bound is `protocol_revenue ≥ $0`, which is true of every
protocol that has ever existed. See [The zero problem](#the-zero-problem).

### 3. Smaller field-level corrections

- `pool_type` is `CONST`, `MANAGED_WEIGHTED` or `STBL`. §3.4 gives
  `"CONSTANT_PRODUCT"`, which no pool carries. Nothing depends on it here.
- `fee_amount_24h` / `fee_amount_7d` are listed as an asset-units cross-check.
  They are `0` on every pool, so they cross-check nothing.
- `apr_governance` is listed as a field to exclude per §3.1. It is `0.000000` on
  every pool, so the exclusion is currently free. It is still applied and still
  stated: the exclusion is a commitment about what `fee_apr` means, not a
  description of this week's data.
- `primary_asset.price` is never `null`; the unknown case is `"0.00000000"`.
  §3.4's pseudocode guards `if non-null and > 0`, whose first clause never fires
  and whose second does all the work.
- §3.4 assigns literal confidences (`0.95` for a reported split, `0.55` for the
  fallback). Neither is a row in §5's derivation table, and `computeConfidence`
  cannot produce `0.55` from any combination of §5 base and penalties.
  `CONNECTOR_GUIDE` §4.4 forbids a connector hardcoding the float, so the
  nearest §5 rows govern: `arithmetic` (0.90) for a reported split and
  `fallback_constant` (0.70) for the absent one.
- The catalogue is **3,961** pools, not the 3,954 §3.4 records for 2026-09-08.

---

## Normalization

```
included(pool)   = !is_deprecated                                  (§3.6.3)
                 && isPriced(primary) && isPriced(secondary)       (§3.6.1)
                 && tvl_usd >= MIN_TVL_USD                         (§3.6.2)
                 && (basis != verified_only || is_verified || auto_verified_100k)   (§3.6.5)

TVL_usd          = Σ  parseFloat(tvl_usd)
volume_24h       = Σ  parseFloat(volume_24h)        // already USD; NOT converted
gross_fees_24h   = Σ  parseFloat(fee_usd_24h)       // total charged to swappers

protocol_share(pool) = pact_fee_bps != null && fee_bps > 0
                          ? pact_fee_bps / fee_bps
                          : 0.0                     // unknown, never guessed
protocol_revenue_24h    = Σ ( fee_usd_24h × protocol_share(pool) )
supply_side_revenue_24h = gross_fees_24h − protocol_revenue_24h    // §3.1 identity, asserted

take_rate          = protocol_revenue_24h / gross_fees_24h     (omitted below $1 of fees)
capital_efficiency = gross_fees_24h × 365 / TVL_usd
fee_apr            = supply_side_revenue_24h × 365 / TVL_usd   (apr_governance excluded, §3.1)
volume_to_tvl      = volume_24h / TVL_usd
pool_count         = |included|
```

`MIN_TVL_USD` and `MAX_EXCLUSION_RATIO` are **imported** from
`src/standardize/types.ts`, not redefined here — §3.6 applies the same filters to
every DEX connector, and a connector that redefines them imports its own
methodology. A test asserts the import and the absence of a local definition.

### No price ladder, and why that is not a shortcut

Pact computes and publishes `tvl_usd`, `volume_24h` and `fee_usd_24h` in
dollars. There is no USD *conversion* for this connector to perform, so it
declares no `priceAssets` and `toFacts` never reads `opts.prices`. Every dollar
figure is §5's `reported` row.

The visible consequence is that **Pact's `tvl` carries a higher confidence than
Tinyman's** — 0.86 against 0.70 — even though Tinyman's is computed from
on-chain reserves and Pact's is a number we copied. That is §5 working as
written: `confidence` grades the derivation, not our satisfaction with it, and a
figure the source reports in the requested unit is a stronger derivation than one
we assembled from reserves and prices. It is also a figure we cannot audit, which
is what the DefiLlama cross-check exists for.

### Ratios use total TVL, not a flow-covered subset

Tinyman's turnover ratios divide by `flowTvl` because its TVL and its 24h flows
come from different sources with different coverage. Pact returns TVL, volume and
fees **on the same record for every pool**, so numerator and denominator describe
the same set by construction and no correction is needed. Every ratio's `notes`
says so, so the contrast with §3.3 is legible rather than looking like an
omission.

---

## The zero problem, and how it was resolved

`pact_fee_bps` is null on all 3,961 pools. Under §3.4 as originally written, the
live catalogue produced:

```
gross_fees_24h          = $94.21
protocol_revenue_24h    = $0.00      is_estimated: true
supply_side_revenue_24h = $94.21     is_estimated: true
take_rate               = 0.000000   is_estimated: true
fee_apr                 = capital_efficiency, exactly
```

An earlier revision of this file raised the last four for the methodology owner
rather than deciding them unilaterally. **They have been decided: Pact declines
all four.**

### Why the bound had to go

§3.4's lower-bound treatment is right for a *sparse* field, where "42% of gross
fees came from null-split pools" tells a buyer how tight the bound is. At 100%
it degenerates into `protocol_revenue ≥ $0` — true of every protocol that has
ever existed — and what ships is a `$0.00` and a `0.000000`.

A `notes[]` entry saying the bound constrains nothing is correct and does not
solve it, because **the number travels without the note**. The concrete harm is
`/compare?metric=take_rate`: Pact's `0.000` sorts below Tinyman's `0.248`, and an
agent reads that ranking as *"Pact captures no revenue."* The truth is *"Pact
does not publish its cut."* Those are different claims and only one of them is
supported. §1.5 — decline loudly rather than return a plausible-looking zero —
is not ambiguous about which one we may ship.

### Why `supply_side_revenue_24h` and `fee_apr` went too

They are the same unsupported claim wearing the other sign. With
`protocol_share = 0`, the §3.1 residual gives

```
supply_side_revenue_24h = gross_fees_24h − 0 = gross_fees_24h    (exactly)
```

which asserts **"LPs receive 100% of Pact's swap fees."** That is a statement
about Pact's economics, not a measurement, and it is very likely false — a DEX
with a `pact_fee_bps` field in its own schema is a DEX that has a cut. `fee_apr`
is `supply_side_revenue_24h × 365 / tvl`, so it carries the claim through
unchanged and additionally comes out numerically identical to
`capital_efficiency`. That identity looked like a curiosity; it is really the
tell that one of the two numbers is not measuring what its name says.

### What survives, and why it is enough

`gross_fees_24h` — what swappers actually paid — needs no split at all. It is
`Σ fee_usd_24h`, reported directly by Pact, and it is unchanged by any of this.
`capital_efficiency` is built on it and is likewise unaffected.

**Pact publishes one leg of §3.1 instead of three, and says which one.** That is
a strictly more honest position than three legs where two are assumptions. The
identity itself is still computed and still asserted in code — `splitFees()` runs
`assertCashFlowIdentity()` on every `toFacts` call — because a misclassified flow
is a bug whether or not its result reaches a response. What changed is
publication, not arithmetic.

### The evidence that this is a publication change and not a methodology change

Regenerating the golden fixture removed exactly four facts and left every other
number **byte-identical**:

| | before | after |
|---|---|---|
| `tvl` | 832,860.6724947598 | 832,860.6724947598 |
| `volume_24h` | 74,500.39194900001 | 74,500.39194900001 |
| `gross_fees_24h` | 75.29041569999997 | 75.29041569999997 |
| `capital_efficiency` | 0.03299591713003221 | 0.03299591713003221 |
| `volume_to_tvl` | 0.0894512064374954 | 0.0894512064374954 |
| `pool_count` | 40 | 40 |
| `protocol_revenue_24h` | 0 | *declined* |
| `supply_side_revenue_24h` | 75.29041569999997 | *declined* |
| `take_rate` | 0 | *declined* |
| `fee_apr` | 0.03299591713003221 | *declined* |

**No `methodology_version` bump.** No formula in §3 or §4 changed; every
surviving value is identical to the digit. §1.1 and §1.5 already required the
decline, so publishing the zeroes was a failure to apply 1.1.0 as written —
prompted by §3.4's factual error about the source ("frequently null" against an
actual 100%). Correcting a connector into compliance with the published
methodology is a bug fix. Bumping would invalidate every cache key to signal a
change in numbers that did not change. Recorded in `DATA_SCHEMA.md` §3.4.

### What a caller sees

```
GET /metric/pact/take_rate
404  KPI_NOT_APPLICABLE
{
  "message": "\"pact\" declines \"take_rate\": take_rate is protocol_revenue_24h /
              gross_fees_24h, and Pact does not publish the numerator:
              `pact_fee_bps` is null on all 3,961 pools. A take_rate of 0.000000
              would rank Pact below every protocol that discloses its cut, for a
              reason that is about disclosure rather than economics
              (DATA_SCHEMA.md §1.5, §3.4).",
  "detail": { "declined": true, "available_kpis": [...] }
}
```

`KPI_NOT_APPLICABLE` rather than `KPI_NOT_FOUND` is deliberate. `take_rate` *is*
applicable to a `dex` and a buyer will reasonably expect it here, so a bare "not
found" would read as a hole in our coverage rather than a hole in Pact's
disclosure. The mechanism is the generic `declined` field on
`ConnectorCapabilities`; no route knows Pact's name.

The reason also rides on the facts that *are* published — `gross_fees_24h` and
`capital_efficiency` each carry a note explaining where the other legs went — so
a buyer who never requests the declined KPI still learns why it is absent.

---

## Quirks

### `?limit=` is silently capped at 500

The single most dangerous behaviour of this API, because it produces no error.

```
?limit=100 -> "limit": 100, 100 rows
?limit=500 -> "limit": 500, 500 rows
?limit=501 -> "limit": 500, 500 rows
?limit=1000 -> "limit": 500, 500 rows      <-- asked for 1000, got 500
?limit=5000 -> "limit": 500, 500 rows
```

A walk that requests `limit=1000` and strides by **1,000** reads rows 0–499,
1000–1499, 2000–2499, 3000–3499: **2,000 of 3,961 pools**, with no error, no
truncation flag, and a `count` that keeps agreeing with itself.

`fetchPools` therefore strides by `page.limit` — the server's own statement of
what it served — never by what was requested, and reconciles the collected row
count against `count` afterwards, setting `partial` on a shortfall. The recorded
fixtures echo `limit: 40` while the connector requests 500, so a regression to
request-striding fetches a URL the harness does not serve and fails loudly.

**This same cap is a live defect in `src/connectors/price/index.ts`** — see
[Note on §3.7 rank 3](#note-on-37-rank-3).

### Deprecated pools are not dormant

`is_deprecated` is true on exactly the 10 `version: 100` pools — Pact's previous
generation. §3.6.3 excludes them, and this connector does, without exception.

It is worth knowing what that costs. One of those ten is an ALGO/USDC pool
holding **$298,267** — 23% of Pact's entire TVL — and it was, on the verification
run, **the single highest-volume pool on the venue** ($41,863 of 24h volume,
$62.79 of fees). "Deprecated" here labels a contract generation, not an abandoned
pool.

Excluding it is the methodology's call and is applied as written, but it is the
largest single reason our TVL sits below DefiLlama's, so the `tvl` and
`pool_count` facts say so in `notes` rather than leaving a buyer to discover a
25% gap unaided.

### A missing price arrives as `"0.00000000"`, not `null`

738 primary and 1,600 secondary asset sides carry a price of exactly zero. Pact
computes `tvl_usd` from those prices, so a pool with a zero-priced side reports a
TVL counting only its other half.

That is precisely §3.6.1's "no reliable USD price for at least one side",
arriving as a number rather than an absence — and a number that sums, multiplies
and never announces itself. `isPriced()` treats `null` and `<= 0` identically, and
such pools are excluded and counted. Among pools that would otherwise be
included, this is **1 pool holding $1,196**; across the whole catalogue it is
1,993 exclusions, nearly all of them dust.

### Every pool is its own application

`on_chain_id` is the pool's Algorand application id, and there are 3,961 distinct
ones. There is no single validator app to filter indexer transactions against, so
`active_users_24h` is **declined** (§4.1, §Step 3) and no `appIds` are declared.
Computing it would mean 3,961 paged indexer walks per refresh; computing it over
a subset would silently answer a different question than the KPI names.

---

## Coverage, and what the filters do

Live run, 2026-09-09, `all_pools_usd_priced`:

| | |
|---|---|
| Enumerated | 3,961 |
| Included | **88** |
| Excluded — deprecated (§3.6.3) | 10, holding $299,765 |
| Excluded — zero-priced side (§3.6.1) | 1,993 |
| Excluded — below $1,000 (§3.6.2) | 1,870 |
| Verified / unverified among included (§3.6.4) | 85 / 3 |

`coverage.entities + coverage.excluded` always reconciles to the full
enumeration, so a buyer can check the arithmetic. At 97.8% excluded, §5's
high-exclusion penalty fires on every Pact fact and will continue to — that is
the intended reading, and the same one §3.6 records for Tinyman.

---

## Cross-check: DefiLlama

`https://api.llama.fi/protocol/pact`, 2026-09-09. A divergence signal only,
never a value source (§3.5).

| | |
|---|---|
| Ours, after §3.6 | **$946,573** |
| Ours, before §3.6 | $1,320,943 |
| DefiLlama | $1,275,845 |
| Divergence, filtered | **−25.8%** |
| Divergence, raw | **+3.5%** |

The two lines answer different questions, and printing only the first would
misread the situation entirely. **+3.5% raw** says our enumeration of the source
is complete and correctly parsed — the failure mode that produced Tinyman
1.0.0's −56.7% is absent here. **−25.8% filtered** says §3.6 removes $374,370,
of which $299,765 is the deprecated pools and $73,763 is sub-$1,000 dust.

So the gap is not a bug and not an enumeration hole; it is the methodology
declining to count pools DefiLlama counts. It nonetheless exceeds the 20% band,
which is a decision for the methodology owner rather than something to ship past
— see the launch notes.

---

## Confidence rationale (§5)

| KPI | Derivation | Base | Penalties | Live |
|---|---|---|---|---|
| `tvl` | `reported` — Pact publishes USD | 0.95 | high_exclusion ×0.9 | **0.86** |
| `volume_24h` | `reported` | 0.95 | high_exclusion | 0.86 |
| `gross_fees_24h` | `reported` | 0.95 | high_exclusion | 0.86 |
| `capital_efficiency` | `arithmetic`, composite minimum | 0.90 | high_exclusion | 0.81 |
| `volume_to_tvl` | `arithmetic`, composite minimum | 0.90 | high_exclusion | 0.81 |
| `pool_count` | `arithmetic` | 0.90 | high_exclusion | 0.81 |
| `protocol_revenue_24h`, `supply_side_revenue_24h`, `take_rate`, `fee_apr` | — | — | — | **declined** (§"The zero problem") |

Every one is produced by `computeConfidence`; no float is hardcoded.

The four declined KPIs used to land at 0.63 — below §5's 0.7 "directional" line,
via the `fallback_constant` row. That grade was accurate and was not sufficient:
a confidence tells a buyer how much to trust a number, and these were not weak
numbers but unsupported claims. §5 grades derivations; it cannot rescue a figure
whose derivation is "assume the thing we do not know is zero". That is what the
decline is for, and it is the distinction between the two mechanisms.

`validation_skip` (×0.85) is added whenever a row fails zod at the boundary. It
did not fire on any live run: all 3,961 rows parse.

---

## Performance

Measured 2026-09-09:

| Phase | Requests | Time |
|---|---|---|
| Catalogue walk (page 1, then 7 concurrently) | 8 | **~4.1s** |
| `toFacts` | 0 | <10ms |
| **Full refresh** | **8** | **~4.1s** |

There is no TVL-only mode and no `opts.kpis` fast path, because there is nothing
to skip: one walk yields every KPI. Contrast Tinyman, whose full refresh is
71–88s and whose TVL-only path exists precisely because its flow lookups are one
request per pool.

Inside the refresher's fast cycle the group costs more than 4.1s, because
`computeFacts` resolves prices for every connector and `PriceService.resolve`
always resolves ALGO — even for a connector that requested no assets. Whichever
group runs first pays for the §3.7 ladder and the rest hit its 60s cache; the
cost is shifted between groups rather than added to the cycle. See the launch
notes for the measured split.

---

## Files

| | |
|---|---|
| `index.ts` | capabilities, `fetchRaw`, `toFacts`, `healthCheck` |
| `enumerate.ts` | the paginated walk, and the stride-by-echoed-limit guard |
| `schema.ts` | zod boundary validation, and `isPriced` |
| `test/connectors/pact/pact.test.ts` | the seven §Step 6 tests, plus the §3.4 corrections |
| `test/fixtures/pact/` | 91 verbatim pool records in 3 pages, plus one labelled synthetic |
| `scripts/record-pact-fixtures.ts` | re-records the fixtures |
| `scripts/pact-live.ts` | one live end-to-end run with the DefiLlama cross-check |

### Note on §3.7 rank 3

§3.7 rank 3 reads `primary_asset.price` / `secondary_asset.price` for assets in a
Pact pool with ≥$50k `tvl_usd`. It lives in `src/connectors/price/index.ts`, not
here, and this connector does not use it — but it is Pact data, so it was
verified as part of this work. **It has never produced a price**, for the
`?limit=` reason above. Details in the launch notes; the fix is one line in a
file outside this directory and has deliberately not been made here.
