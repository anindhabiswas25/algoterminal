# Tinyman connector (`dex`)

**Class:** `dex` · **Registry key:** `tinyman` · **KPIs:** all 11 §4 KPIs applicable to `dex`
**Source verification date: 2026-09-09** (enumeration, fee split, price ladder, timings; the analytics-API details were verified 2026-09-08 and re-probed 2026-09-09). Every claim below was checked live; the results go stale, so re-run §Verification before trusting them.
**`methodology_version: 1.1.0`** — see `DATA_SCHEMA.md` §Changelog and §3.1 / §5.1 below for what changed and why it was a version bump.

---

## 1. Who pays whom

A trader swapping on Tinyman pays a fee on every swap, charged as a fraction of the input amount — 0.30% on V1.1 pools and, on the V2 pools that hold most of the liquidity today, whatever `total_fee_share` that pool's on-chain state says (0.36% on almost every live pool). **That swap fee is `gross_fees_24h`**: it is the whole price a user pays for the service, and nothing else counts — not staking rewards, not Algorand governance ALGO, not liquidity-mining emissions.

The fee is then split. Most of it is left in the pool, where it accrues to the liquidity providers who supplied the capital — that portion is **`supply_side_revenue_24h`**, and it is not Tinyman's money. The remainder is swept to Tinyman's treasury as protocol fees — that portion is **`protocol_revenue_24h`**, and it is the number comparable to a company's revenue.

The split is a **per-pool** number, not a protocol-wide constant. V1.1 takes 5 of its 30 bps (a 16.7% cut). V2 takes `1 / protocol_fee_ratio` of its total fee share, read from that pool's own chain state — measured across all 17,119 live V2 pools on 2026-09-09, that is 1/4 (25%) on 9,900 of them and 1/6 (16.7%) on 7,219. Using one constant across both would misstate the split by up to 50% and would drift further every time liquidity migrates between versions, which is precisely why `DATA_SCHEMA.md` §3.3 specifies it per pool.

---

## 2. Source verification

| Question | Answer |
|---|---|
| Endpoint | `https://mainnet.analytics.tinyman.org/api/v1/pools/` |
| Auth | **None.** Anonymous `curl` returns `200`; no key, no browser UA needed |
| Pagination | DRF `?limit=&offset=`, envelope `{count, next, previous, results}`. `limit` honoured up to at least 5,000 |
| Rate limit | **Yes, and undocumented.** 8 unpaced concurrent requests → `429` with `Retry-After: 18` and a `{"type":"Throttled"}` body. ~400 sequential requests over several minutes never throttled |
| Ordering | `?ordering=` is accepted and ignored |
| `count` | `7418` — but see §3.2: only ~5,500 addresses are distinct |
| V2 listing | **Impossible on this API.** `addresses=`, `address__in=`, `ids=`, `address=` are all accepted and ignored; only single-address lookup (`/pools/{address}/`) works. Hence §3.1 |
| Assets endpoint | `/api/v1/assets/` — `?ids=<csv>` **is** a real filter. 35,250 assets |
| On-chain | `https://mainnet-api.4160.nodely.dev` (algod), `https://mainnet-idx.4160.nodely.dev` (indexer). Anonymous, no key |
| V1.1 validator app | `552635992` — confirmed by reading a V1.1 pool account's `apps-local-state` |
| V2 validator app | `1002541853` — likewise, and its creator is `4HIR5U2J…ZV27U4` |
| V2 pool enumeration | `GET /v2/accounts?application-id=1002541853&limit=1000` on the indexer — **17,119 accounts, 19 pages, 12.9 s**. `exclude=assets,created-assets,created-apps` is honoured and drops ~14% of the payload without touching `apps-local-state` |
| V2 pool local state | `asset_1_id`, `asset_2_id`, `asset_1_reserves`, `asset_2_reserves`, `asset_N_protocol_fees`, `total_fee_share`, `protocol_fee_ratio`, `issued_pool_tokens`, `asset_N_cumulative_price`, `lock` — all present on all 17,119 |

**Fields read per pool** (§3.3's table, as the API actually types them):

| Field | Upstream type | Used for |
|---|---|---|
| `address` | string | Entity key, and the §3.3 dedupe key |
| `version` | `"1.1"` \| `"2.0"` | Fee-split policy selection |
| `asset_1.id`, `asset_2.id` | **string** (not int) | §3.6.1 price lookup |
| `asset_1.decimals`, `asset_2.decimals` | int | Price derivation in the §3.7 ladder |
| `is_verified` | bool | `?basis=verified_only`, and the §3.6.4 note |
| `liquidity_in_usd` | decimal string, **nullable** | `tvl` |
| `last_day_volume_in_usd` | decimal string | `volume_24h` — already USD |
| `last_day_fees_in_usd` | decimal string | **`gross_fees_24h`** (LP + protocol) |
| `v2_address` | string, nullable | The V2 enumeration pointer |

**Fields read per V2 pool** come from the chain, not from this API — `apps-local-state[id=1002541853]` on the pool account, delivered by the enumeration walk itself. The analytics API is read for a V2 pool only to obtain its **24h flows** (`last_day_volume_in_usd`, `last_day_fees_in_usd`, plus `is_verified` for `?basis=verified_only` and `liquidity_in_usd` as a cross-check), and only for the pools that clear §3.6. Asset **decimals** are the one non-chain input to the V2 TVL formula; they come from `/api/v1/assets/?ids=`, which is immutable ASA metadata rather than a flow.

---

## 3. Quirks, and how each is handled

### 3.1 The list endpoint returns only V1.1, and no parameter changes that

`version`, `pool_version`, `v2`, `contract_version` and `is_v2` are all accepted and all silently ignored — every one still returns `count: 7418` and nothing but `"version": "1.1"` rows. There is no `/api/v2/pools/`, and no address filter: `addresses=`, `address__in=`, `ids=` and `address=` are all ignored too (re-probed 2026-09-09). The endpoint can *look up* any V2 pool by address; it cannot *list* one.

**Since methodology_version 1.1.0, V2 is not enumerated through this API at all.** A V2 pool is a logic-sig account opted into validator app `1002541853`, so the pool set is the account set:

```
GET /v2/accounts?application-id=1002541853&limit=1000&exclude=assets,created-assets,created-apps
```

paged through `next-token`. **17,119 accounts, 19 pages, 12.9 s** (2026-09-09), and each account's local state already carries `asset_1_id`, `asset_2_id`, `asset_1_reserves`, `asset_2_reserves`, `total_fee_share`, `protocol_fee_ratio` and `issued_pool_tokens`. `enumerateV2Pools` in `enumerate.ts`.

#### What the old algorithm cost

Until 1.1.0 V2 was reached through `v2_address` on V1.1 records — a pointer that only exists on a pool that *had* a V1.1 predecessor. That reached **922 of 17,119 (5.4%)**, and the unreachable remainder held the biggest pairs on the venue:

| pool | TVL | reachable via `v2_address`? |
|---|---|---|
| tALGO / xALGO | $479,622 | no |
| tALGO / USDC | $251,526 | no |
| Folks Finance / ALGO | $124,117 | no |
| Alpha Arcade / USDC | $117,357 | no |

| | 1.0.0 | 1.1.0 |
|---|---|---|
| V2 pools enumerated | 922 | 17,119 |
| Tinyman TVL | $2.51M | $5.38M |
| DefiLlama (`api.llama.fi/protocol/tinyman`) | $5.80M | $5.76M |
| divergence | **−56.7%** | **−6.6%** |

There was no symptom. The §3.1 identity balanced, `coverage` reconciled, the ratios looked plausible — only the magnitude was wrong, by a factor of two. That is why the enumeration is a named, separately tested function, and why `tinyman.test.ts` asserts the V2 count *exceeds the number of `v2_address` pointers the recorded V1.1 pages carry*: an assertion the old algorithm could not have satisfied.

#### The residual −6.6%

Not reconciled to zero, and not claimed to be. The remaining gap is the sum of: V1.1 pools DefiLlama counts that our §3.6 filters exclude, pools whose assets fall to §3.7 rank 5 (220 of 6,883 live pools), the ~60s of drift between our snapshot and theirs, and — most likely the largest term — a genuinely different methodology on their side, which we deliberately do not adopt (`DATA_SCHEMA.md` §3.5: DefiLlama is a divergence signal, never a value source). A −6.6% divergence against an independent aggregator, from a completely different data path, is the strongest evidence available that the on-chain formula is right; a *zero* divergence would mean we had reimplemented their method rather than ours.

### 3.1b V1.1 stays on the analytics API

There is no V1.1 equivalent of the V2 validator app to enumerate against: a V1.1 pool is an lsig account opted into `552635992`, but its reserves are not laid out in local state the way V2's are, so the analytics record remains the only complete description. V1.1 is ~$183k of the venue. The asymmetry is documented rather than hidden, and it is why `tvl` is graded as a composite of two differently-derived parts (§5).

**The on-chain formula is independently corroborated.** For the 390 pools whose analytics record is also read for flows, our on-chain TVL is compared with the source's own `liquidity_in_usd`: mean divergence **1.46%** on the recorded fixture (49 pools), and 0.4-1.0% on the three largest live pools. That number is reported in every `tvl` fact's `notes`. It is a signal, never a value (`DATA_SCHEMA.md` §3.3).

### 3.2 The list endpoint returns duplicates

Paging all 7,418 rows yields **5,493 distinct addresses**. Offset pagination over a set the server re-orders hands the same pool back under two offsets. §3.3's double-counting guard is therefore load-bearing for the V1.1 list itself, not only for the V1.1↔V2 join, and `dedupeByAddress` is applied to both, first-occurrence-wins.

A V1.1 pool and the V2 pool at its `v2_address` are **distinct venues holding distinct liquidity, and both are counted.** What never happens is one record entering the aggregate twice.

### 3.3 The V2 fee parameters are not where §3.3 originally said they are

`DATA_SCHEMA.md` §3.3 originally said to read `total_fee_share` and `protocol_fee_ratio` from "the pool application's global state". They are not there. A V2 pool is a **logic-sig account** opted into the single validator application `1002541853`, and the fee parameters are that **account's local state**:

```
$ curl -s https://mainnet-api.4160.nodely.dev/v2/accounts/2PIFZW53…COZRNMM
  apps-local-state[1002541853]:  total_fee_share=36  protocol_fee_ratio=4
```

**Since 1.1.0 this costs nothing.** The account walk that enumerates V2 pools returns that same local state in the same page, so the split is read for **every** pool, always — where 1.0.0 spent 922 separate algod `getApplicationLocalState` calls to read it for 5.4% of them. Measured across all 17,119 pools (2026-09-09):

| `protocol_fee_ratio` | `total_fee_share` | pools | protocol's cut |
|---|---|---|---|
| 4 | 36 | 9,900 | 25.0% |
| 6 | 30 | 7,219 | 16.7% |

The cost of assuming instead of reading is not marginal: a flat 1/6 would understate `protocol_revenue_24h` by 50% on the 9,900 pools that charge 1/4. And the split is genuinely *not uniform*, which is exactly what `DATA_SCHEMA.md` §3.3 warns a protocol-wide constant would hide.

The 1/6 fallback survives only for state that is present and malformed (`protocol_fee_ratio` missing or `<= 0`). It is no longer reachable by breaking a fetch, so it is tested directly against `protocolShareOf` rather than through a fixture whose algod read fails. `getApplicationLocalState` remains on `AlgodClient` — it is a standard Algorand shape and Folks Finance (step 8) will want it — but the Tinyman fixture harness now **throws** if anything calls it, so a regression that reintroduces 17,119 per-pool reads fails the suite instead of merely slowing the service down.

### 3.4 `liquidity_in_usd` is nullable

Null on 369 of 5,493 pools. §3.3 documents it as "decimal string". A pool with a null TVL, volume or fee figure is **excluded and counted in `coverage.excluded`** — not coerced to zero, and not treated as schema drift, since this is the shape the API genuinely has. `total_annual_percentage_rate` is null on 5,469 of 5,493; it is a cross-check field we do not read, and a schema requiring it would reject 99.6% of the catalogue.

### 3.5 The API throttles

Handled entirely by `ctx.http` (§4.1): 3 retries, exponential backoff with full jitter, and `Retry-After` obeyed when present. Nothing in this connector calls bare `fetch`.

---

## 4. Normalization

```
included pools = §3.6 filters (below), applied to V1.1 ∪ V2, deduped by address

# 1.1.0: TVL is per-version. V2 is computed from chain state; V1.1 is reported.
tvl(V2 pool)            = (asset_1_reserves / 10^dec1) * price_1
                        + (asset_2_reserves / 10^dec2) * price_2
tvl(V1.1 pool)          = liquidity_in_usd
tvl                     = Σ liquidity_in_usd
volume_24h              = Σ last_day_volume_in_usd          (already USD)
gross_fees_24h          = Σ last_day_fees_in_usd            (TOTAL: LP + protocol)

protocol_share(pool)    = 5/30                    if version == "1.1"
                        = 1 / protocol_fee_ratio  if V2 local state was read
                        = 1/6                     otherwise (is_estimated)

protocol_revenue_24h    = Σ (last_day_fees_in_usd × protocol_share(pool))
supply_side_revenue_24h = gross_fees_24h − protocol_revenue_24h     ← §3.1 residual

take_rate               = protocol_revenue_24h / gross_fees_24h     (omitted if gross < $1)
capital_efficiency      = gross_fees_24h × 365 / tvl
fee_apr                 = supply_side_revenue_24h × 365 / tvl
volume_to_tvl           = volume_24h / tvl
pool_count              = |included pools|
active_users_24h        = |distinct senders to apps 552635992, 1002541853 over ~24h of rounds|
```

`assertCashFlowIdentity` checks `gross == supply_side + protocol_revenue` to ±1e-6 **in code**, on every call, before any fact is built. A violation means a flow has been misclassified, and it throws rather than shipping a balanced-looking response.

**Two things `last_day_fees_in_usd` is not.** It is not `protocol_revenue` — reporting it as such is the most common error in the wild and would overstate Tinyman's revenue by ~4x. And `current_unclaimed_protocol_fees` is a cumulative on-chain balance of fees not yet swept, not a 24h flow; it is never used for `protocol_revenue_24h`.

### 4.1 §3.6 filters

1. Both asset sides must have a §3.7 price. Unpriced ⇒ excluded, counted, **never a zero contribution.**
2. `liquidity_in_usd >= $1,000`.
3. Tinyman has no `is_deprecated` flag; the filter is a no-op here.
4. Unverified pools are **included**, with the verified/unverified split reported in `notes`.
5. `?basis=verified_only` additionally requires `is_verified`.

`assetIdsFor(snapshot)` is what gets handed to the price service, and it names only the assets of pools already above the $1k floor. The filters are conjunctive, so a pool below the floor is excluded regardless of pricing; asking the ladder about its assets would add thousands of dust ids to a rank-2 rung that costs a full pass over the pool catalogue.

---

## 5. Confidence rationale, per KPI

| KPI | Derivation | Why |
|---|---|---|
| `tvl` | **min(** `reported` 0.95 for the V1.1 dollars, `usd_conversion` 0.90 × price_confidence for the V2 dollars **)** | Since 1.1.0 TVL is a sum of two differently-derived parts, so §5's composite rule applies. The V2 reserves are on-chain and exact, but the fact is **dollars**, and converting reserves into dollars is what `usd_conversion` grades. See §5.1 |
| `volume_24h`, `gross_fees_24h` | `reported` (0.95) | Tinyman publishes both **in USD**, in the unit we emit. We sum them; we do not convert them. Contrast Pact, whose volume is in asset units and therefore lands on `usd_conversion` (§3.4) |
| `protocol_revenue_24h`, `supply_side_revenue_24h` | `arithmetic` (0.90), or `fallback_constant` (0.70) if any V2 fee share fell back | The split is arithmetic on reported values and an on-chain ratio. A share that came from a constant rather than from chain state is a fallback, and §5 prices that honestly rather than blending it away |
| `take_rate`, `capital_efficiency`, `fee_apr`, `volume_to_tvl` | `arithmetic`, then **min** with their inputs | §5: a composite takes the minimum confidence of its inputs, never the mean — a ratio is only as trustworthy as its weaker leg |
| `pool_count` | `arithmetic` (0.90) | A count of a filtered set, not a reported figure |
| `active_users_24h` | `indexer_address_aggregation`, **hard-capped at 0.80** | §4.1's cap, applied by `computeConfidence` |

Penalties applied: `high_exclusion` when `excluded / (entities + excluded) > 0.10` — which it now *always* is, since enumerating from the chain means enumerating all 17,119 V2 pools including 10,236 with empty reserves — `validation_skip` when any record failed zod validation, and a second `high_exclusion` on the flow KPIs when 24h flows cover under 90% of included TVL.

### 5.1 Why `tvl`'s stamped confidence went DOWN in 1.1.0 (0.86 → 0.70)

The measurement got unambiguously better: it reaches 100% of the venue instead of 5.4%, and it agrees with DefiLlama to −6.6% instead of −56.7%. The stamped number went the other way, and that is deliberate.

Before 1.1.0, V2 TVL was a dollar figure Tinyman asserted and we copied — §5's `reported` row, 0.95. Now it is a dollar figure we compute from on-chain integers and §3.7 prices. The reserves are exact; the **prices** are not, and they are now inside the value rather than only inside the include/exclude decision. §5's `usd_conversion` row exists for precisely that, so `tvl` is graded `0.90 × price_confidence`, where `price_confidence` is the TVL-weighted mean across the V2 pools (~0.86 on the live run), then the high-exclusion penalty.

`confidence` grades the derivation, not our satisfaction with it. The improvement in accuracy is the DefiLlama number, and it belongs in the cross-check.

**Prices now enter `tvl`'s confidence and no other KPI's.** Volume and fees are still reported in USD by the source, so they are still `reported`. That asymmetry is real and is what the two rows above encode.

### 5.2 The §3.7 rank-5 gate exists because of this change

Once a price multiplies a reserve, a nonsense price becomes a nonsense dollar. On the first live run of the new formula, Vestige's quotes for **Barya** and **Golden Nuggets** — two dead assets it labels with `confidence` 6.0e-10 and 6.7e-10 — produced a single pool worth **$69,226,295,474**. The total read $69.2B, and nothing else in the response looked wrong.

`MIN_PRICE_CONFIDENCE = 0.10` (`src/standardize/types.ts`, the same value as §5's global confidence floor) sends any such price to rank 5, which excludes and counts every pool touching it. Measured cost of the gate: 220 of 6,883 live pools, holding $3,949 of one-sided priced value.

---

## 6. `active_users_24h` — declared, but expensive

App ids are enumerable (both confirmed on-chain, §2), so §4.1's decline clause does not apply and the KPI is declared. Two things a caller should know:

- **It costs a lot.** Measured on a full live run (2026-09-08): **25,381 application transactions** across both validator apps over rounds 64823261-64854759, yielding 607 distinct senders. The indexer returns ~9.8KB per transaction with no field projection available, so a scan moves roughly **250MB** and dominated a run whose pool enumeration alone took 229s (1.0.0; it is now 13s). `FetchOpts.kpis` gates it: `fetchRaw` performs no indexer I/O unless `active_users_24h` was requested, and `scripts/tinyman-live.ts` needs `--users` to run it at all. The cache and refresher (step 5) are what make this viable on a $0.005 call — served live, this one KPI costs more than the rest of the catalogue combined.
- **The 24h window is approximate.** Neither `AlgodClient.status()` nor the §1.2 `IndexerClient` exposes a block timestamp, so the round window is `lastRound − 31,500`, from a measured 2.7436 s/round. The fact is `is_estimated: true` and reports both the window it *requested* and the window the returned transactions *actually spanned*.

A page that fails after retries **omits the KPI entirely**. A distinct-address count over three quarters of a scan is not a smaller version of the answer; it is a different and unfalsifiable number.

---

## 7. Known issue for the route/cache step

`RawSnapshot.sources` records **every** URL fetched, as §1.4 requires. 1.1.0 cut this by roughly 4x — 19 indexer pages, 8 V1.1 pages, 48 asset chunks and ~390 flow lookups, so **451 `SourceRef`s** on the live run against ~1,819 before. `toFacts` still copies that array onto each of the 11 facts, so a `/metric` response is still several hundred kilobytes of provenance.

This is not a connector bug — the receipt is genuinely that long, and truncating it silently would break the §1.4 reproducibility guarantee. It is a decision the query layer owes an answer to at step 5 (a provenance digest with the full list behind a `?sources=full` or a `/provenance/{id}` link is the obvious shape). Flagging it here rather than pre-empting it in the connector.

---

## 7.1 Performance

Measured 2026-09-09 (`scripts/tinyman-live.ts`, and a phase-level instrumented run):

| Phase | Requests | Time |
|---|---|---|
| V2 account walk ‖ V1.1 list | 19 ‖ 8 | 12.9 s |
| Asset decimals ‖ §3.7 ladder | 48 ‖ ~60 | 22.6 s |
| Per-pool V2 flow lookups | 390 | 30.1 s |
| **`fetchRaw`, full** | ~530 | **71-88 s** (3 runs) |
| **`fetchRaw`, TVL-only** (`opts.kpis` excludes every flow KPI) | ~90 | **13-14 s** (3 runs) |

End to end, including the price resolve the caller does before `toFacts`:

| | 1.0.0 | 1.1.0 full | 1.1.0 TVL-only |
|---|---|---|---|
| `fetchRaw` | 181 s | 71-88 s | 13-14 s |
| price resolve | 71 s | 7-15 s (mostly cached) | 12-15 s |
| **end to end** | **~252 s** | **78-105 s** | **26-28 s** |

The full path's spread is upstream variance on `mainnet.analytics.tinyman.org`, not ours: the 390 flow lookups are the term that moves. The TVL-only path is stable across runs because it touches that host only for the V1.1 list and the asset chunks.

**What made it faster**

1. **The enumeration replaced 1,844 requests with 19.** 922 per-address V2 fetches and 922 algod local-state reads became one indexer walk that returns both.
2. **Every chunked or paged fetch runs concurrently.** The §3.7 ladder walked its `/assets/?ids=` and Vestige chunks in a `for` loop — 48 requests at ~1 s of round-trip each, serially. `ctx.http` already caps per-host concurrency at 8, so the loop was protecting nothing the semaphore was not. Same for both catalogue walks: page 1 alone (it carries `count`), then the rest at once.
3. **The V1.1 list uses `limit=1000`.** 8 pages instead of 15; the endpoint honours it.
4. **Flows are fetched only for pools that clear §3.6** — 390, not 17,119.
5. **The price ladder caches per asset for 60 s** (`ARCHITECTURE.md` §6), so `fetchRaw`'s scoping resolve and the caller's resolve before `toFacts` are one ladder run, not two.

**Why the full path does not reach 60 s, and what the floor is**

The floor is roughly **65 s**, and all of it is upstream latency rather than our arithmetic:

- **~13 s, the indexer walk.** 19 pages chained by `next-token`, so it cannot be parallelised. 31 MB of JSON.
- **~23 s, the §3.7 ladder.** It pages the Tinyman and Pact pool catalogues in full and asks Vestige about ~2,000 assets.
- **~30 s, the 390 flow lookups.** Tinyman has no bulk V2 endpoint — no `addresses=`, no `ids=` — and throttles at 8 concurrent (`429`, `Retry-After: 18`; 8 of them fired on the live run even at the §4.1 cap). One request per pool at a concurrency of 8 is the shape of the API, not a choice we can optimise around.

**The lever that does fit in 60 s is `opts.kpis`.** §4 gives `tvl` a 300 s TTL and the flow KPIs a 600 s one, so a refresher holding the hot set warm on a 60 s cycle has no reason to buy flows on every pass: a TVL-only refresh is 26-28 s end-to-end and produces the identical TVL (verified: the same $5,379,486 and the same −6.6% DefiLlama divergence as the full run). The recommendation is a 60 s TVL cycle and a flows cycle at 300–600 s, rather than a 60 s cycle that quietly runs 78 s long.

---

## 8. Verification

```bash
# the V1.1 fixture pages (verbatim upstream payloads)
curl -s 'https://mainnet.analytics.tinyman.org/api/v1/pools/?limit=50' \
  > test/fixtures/tinyman/pools-page-1.json

# everything else — v2-accounts, assets, v2-flows, prices, active-users —
# recorded through our own code, from a representative subset of the real
# enumeration (top pools by TVL, plus dust, plus empty, plus unpriceable)
MAINNET_ALGOD_URL=https://mainnet-api.4160.nodely.dev \
MAINNET_INDEXER_URL=https://mainnet-idx.4160.nodely.dev \
  npx tsx --env-file=.env scripts/record-tinyman-fixtures.ts

# the golden file
UPDATE_GOLDEN=1 npx vitest run test/connectors/tinyman

# a live end-to-end run, with the DefiLlama divergence check
MAINNET_ALGOD_URL=https://mainnet-api.4160.nodely.dev \
  npx tsx --env-file=.env scripts/tinyman-live.ts [--users] [--tvl-only]
```
