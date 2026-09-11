# AlgoTerminal — Connector Guide

**Status:** v1.3
**Changes since v1.2:** `AlgodClient` gains `getApplicationGlobalState` (build
step 8 — a Folks lending market is one application's global state, and its REST
API is closed); `ConnectorCapabilities` gains the optional `declined` map, so a
connector can decline a KPI *loudly*, with a reason `/metric` returns, rather
than merely omitting it (DATA_SCHEMA.md §1.5; Pact's `take_rate`).
**Changes since v1.1:** `AlgodClient` gains `getApplicationLocalState` (build step
4 — Tinyman V2's per-pool fee parameters are account local state, not
application global state); `IndexerClient.searchTransactions` returns a
`readonly` transactions array, matching `src/connectors/types.ts`.
**Changes since v1.0:** §1 gains `ToFactsOpts.now`, full contracts for the five
`ConnectorContext` services, and the three coherence rules the boot-time
registry validator enforces; `capabilities().sources` is renamed `sourceHosts`;
the §3 skeleton now compiles against §1.
**Goal:** adding protocol #4 is one new directory plus one line in the registry. Nothing else in the codebase changes.

If implementing a new connector requires editing the standardization layer, the cache, the routes, or the payment gate, the connector interface is wrong and should be fixed rather than worked around.

---

## 1. The interface

`src/connectors/types.ts`:

```ts
import type { KpiFact, KpiId, ProtocolClass, SourceRef } from '../standardize/schema';
import type { Basis } from '../standardize/types';
import type { Logger } from 'pino';

/** What a connector declares it can produce. Drives /catalog and route validation. */
export interface ConnectorCapabilities {
  id: string;                    // stable slug, lowercase: "tinyman". MUST equal the
                                 // key it is registered under in registry.ts (§Step 7)
  name: string;                  // display: "Tinyman"
  class: ProtocolClass;          // 'dex' | 'lending' | 'l1'
  kpis: KpiId[];                 // ONLY KPIs this connector can actually compute
  sourceHosts: string[];         // hostnames / "algod:host" for provenance + docs.
                                 // NOT RawSnapshot.sources — see the note below
  appIds?: number[];             // required, non-empty, if kpis includes
                                 // 'active_users_24h' (DATA_SCHEMA.md §4.1)
  supportsBasis: Basis[];        // must include the DATA_SCHEMA.md §3.6 default,
                                 // 'all_pools_usd_priced' — see the note below
  declined?: Partial<Record<KpiId, string>>;
                                 // KPIs deliberately declined, mapped to the
                                 // reason. Omitting a KPI from `kpis` already
                                 // declines it (KPI_NOT_FOUND); this is for
                                 // when silence is the wrong answer — a KPI
                                 // applicable to the class that a buyer will
                                 // expect, whose absence is itself a finding
                                 // about the source. `/metric` answers it with
                                 // 404 KPI_NOT_APPLICABLE carrying the reason.
                                 // A KPI may not be in both. See §Step 3.
}

/** Opaque to everything above the connector. Shape is the connector's business. */
export type RawSnapshot = {
  entities: unknown[];           // pools / markets, connector-native
  fetchedAt: string;             // RFC3339
  sources: SourceRef[];          // exact URLs / app ids + rounds actually read
  partial: boolean;              // true if some pages/entities failed
  excludedCount: number;         // entities dropped during fetch (not filtering)
};

export interface ConnectorContext {
  prices: PriceService;          // §4.3 — the ONLY sanctioned USD price source
  algod: AlgodClient;            // Nodely mainnet algod
  indexer: IndexerClient;        // Nodely mainnet indexer
  http: HttpClient;              // fetch + retry/backoff/timeout/UA (§4.1)
  log: Logger;                   // pino, from src/logger.ts
  now: () => Date;               // injected, so tests are deterministic
}

export interface Connector {
  capabilities(): ConnectorCapabilities;

  /** Fetch raw upstream data. I/O ONLY — no arithmetic, no USD, no KPI logic. */
  fetchRaw(ctx: ConnectorContext, opts: FetchOpts): Promise<RawSnapshot>;

  /**
   * Which asset ids this snapshot's facts need USD prices for. PURE.
   * Optional — omit it if none of your KPIs are USD-denominated.
   */
  priceAssets?(snapshot: RawSnapshot): readonly number[];

  /**
   * Convert raw → standardized facts. PURE: no I/O, no Date.now(), no randomness.
   * Same snapshot in ⇒ byte-identical facts out. This is what golden tests assert.
   * Must return a fact for every requested KPI, or omit it entirely — never a
   * zero, never a null without an `error`.
   */
  toFacts(snapshot: RawSnapshot, opts: ToFactsOpts): KpiFact[];

  /** Cheap liveness probe for /health. Must not be the full fetchRaw. */
  healthCheck(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }>;
}

export interface FetchOpts {
  basis: Basis;                  // 'all_pools_usd_priced' | 'verified_only'
  kpis: KpiId[];                 // lets a connector skip expensive fetches it
                                 // doesn't need (e.g. indexer scan for users)
}

export interface ToFactsOpts extends FetchOpts {
  prices: PriceTable;            // resolved BEFORE toFacts, so toFacts stays pure
  now: string;                   // RFC3339. Becomes each fact's `timestamp` (§2).
                                 // A STRING, not a Date and not a () => Date —
                                 // see the note below
  methodologyVersion: string;
}
```

**The `fetchRaw` / `toFacts` split is the load-bearing decision.** All I/O on one side, all arithmetic on the other. It buys three things: golden-file tests over recorded fixtures (so an accounting regression is caught in CI, which matters more here than anywhere else in the system); a cache that can store either raw snapshots or facts; and a reviewable diff when methodology changes, because the change is confined to a pure function.

The split is enforced **in the types**, not by convention. `toFacts` is synchronous, so it cannot `await`; and it receives no `ConnectorContext`, so it is handed nothing it could do I/O with. Everything on `ToFactsOpts` is inert data.

### 1.1 Four rules the types encode

**`ToFactsOpts.now` is an RFC3339 string.** Every `KpiFact` carries a `timestamp` (`DATA_SCHEMA.md` §2, "when WE computed it"), and `toFacts` has no clock, so the instant must arrive on `opts`. It is a string rather than a `Date` or a `() => Date` because a clock function is I/O wearing a small hat: pass one and `toFacts` returns a different `timestamp` on every call, which is exactly what the §Step 6 purity test asserts against. `ctx.now` stays a `() => Date` on the I/O side, where a connector legitimately needs to know when it is.

**`sourceHosts` is not `RawSnapshot.sources`.** They were both called `sources` before v1.1 and it read as a bug. `capabilities().sourceHosts` is the advertised, static list of hosts a connector reads from — documentation, published on `/catalog` as `sources` (`API_SPEC.md` §3.4). `RawSnapshot.sources` is the dynamic, per-fetch list of exact `SourceRef`s actually read, which becomes each fact's provenance (§1.4). One is a promise about where our numbers come from; the other is the receipt.

**`capabilities().id` must equal the registry key.** `/catalog` advertises the id, while every other reader — route validation, the refresher's hot set, `/health`, the `/ask` capability matrix — looks the connector up by key. A mismatch advertises a protocol whose `/metric/{protocol}/{kpi}` path 404s. Asserted at boot (§Step 7).

**`priceAssets` is how the caller knows what to price.** `toFacts` receives a `PriceTable` that must be resolved *before* it runs — that is what keeps it pure — but only the connector knows which assets its own entities touch, since `RawSnapshot.entities` is `unknown[]` and nothing above the connector may look inside it. Until the cache (step 5) there was no generic caller and Tinyman's tests imported its `assetIdsFor` directly; that works for a test and does not work for a pipeline that must run any registered connector. It is pure for the same reason `toFacts` is: it reads the snapshot and nothing else.

**`supportsBasis` must include `all_pools_usd_priced`.** It is the `DATA_SCHEMA.md` §3.6 default, so a request that omits `?basis=` resolves to it. A connector supporting only `verified_only` leaves the default request with no valid handler. Asserted at boot.

### 1.2 The shared service interfaces

`ConnectorContext` names five services. They are shared infrastructure a connector must use and must not reimplement (§4); their full contracts are:

```ts
/**
 * §4.1. Timeout 8s, 3 retries with exponential backoff + jitter, per-host
 * concurrency cap, identifying User-Agent, per-host counters on /health.
 *
 * Returns `unknown`, deliberately: §Step 4 requires every upstream payload to be
 * zod-validated at the boundary, and a typed return would let a connector skip
 * that by asserting a shape the upstream never promised.
 */
export interface HttpClient {
  getJson(url: string, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/**
 * §4.2. Pre-configured Nodely algod. `round` is first-class on every read
 * because an on-chain number without a round is not reproducible, and
 * reproducibility is a stated product guarantee (DATA_SCHEMA.md §1.4).
 */
export type AppStateValue =
  | { type: 'uint'; uint: number }
  | { type: 'bytes'; bytes: Uint8Array };

/** Decoded application state, keyed by the UTF-8 key name. */
export type AppState = Readonly<Record<string, AppStateValue>>;

export interface AlgodClient {
  baseUrl: string;
  status(): Promise<{ lastRound: number }>;
  getApplication(appId: number): Promise<{ round: number; application: unknown }>;
  /**
   * An ACCOUNT's local state under an application. `state` is null when the
   * account is not opted in — an absence, never an empty object that reads as
   * "every parameter is zero". Added at step 4: Tinyman V2 keeps each pool's
   * fee parameters in the pool account's local state under one validator app,
   * and per-account state under a controller app is a standard Algorand shape,
   * not one protocol's quirk.
   */
  /**
   * An APPLICATION's global state. `state` is null when the app does not exist
   * or publishes none — an absence, never an empty object reading as "every
   * parameter is zero". Added at step 8: Folks Finance keeps each lending
   * market's whole configuration in one application's global state and its
   * REST API is closed to anonymous callers, so this is the only path to a
   * Folks number. Application global state is the most standard shape on
   * Algorand, not one protocol's quirk, which is why it belongs here rather
   * than inside a connector re-parsing algod's envelope.
   */
  getApplicationGlobalState(appId: number): Promise<{ round: number; state: AppState | null }>;
  getApplicationLocalState(
    address: string,
    appId: number,
  ): Promise<{ round: number; state: AppState | null }>;
  getApplicationBox(appId: number, name: Uint8Array): Promise<{ round: number; value: Uint8Array }>;
}

/** One account's local state under a controller app (see below). */
export interface IndexerAccountState {
  address: string;
  round: number;
  state: AppState;
}

/** What one exhaustive `listAccountsByApplication` walk found. */
export interface IndexerAccountPage {
  accounts: readonly IndexerAccountState[];
  currentRound: number;
  pages: number;
  failedPages: number;      // non-zero implies `partial`
  skipped: number;          // deleted / schema drift / no local state
  partial: boolean;         // NEVER a silent truncation
  urls: readonly string[];  // the exact pages read, for SourceRefs
}

/**
 * §4.2. Pre-configured Nodely indexer.
 *
 * `searchTransactions` is the DATA_SCHEMA.md §4.1 path for `active_users_24h`:
 * filter by application id over the trailing-24h round range, page
 * exhaustively, collect distinct senders. Page with `next`/`nextToken`; never
 * truncate silently. Paging is the CALLER's, which is what lets a connector
 * bound the cost of an unbounded scan.
 *
 * `listAccountsByApplication` is the DATA_SCHEMA.md §3.3 path for enumerating
 * every account opted into a controller application — for Tinyman V2, every
 * pool, with its `asset_N_id` / `asset_N_reserves` / fee parameters already in
 * the page. Added at step 5. It pages INTERNALLY, the opposite of
 * `searchTransactions` and deliberately so: an account enumeration has a
 * finite known answer, and a caller that stopped early would be reporting a
 * protocol's TVL as whatever fraction it happened to read.
 */
export interface IndexerClient {
  baseUrl: string;
  searchTransactions(params: {
    applicationId: number;
    minRound?: number;
    maxRound?: number;
    limit?: number;
    next?: string;
  }): Promise<{ transactions: readonly unknown[]; nextToken?: string }>;
  listAccountsByApplication(appId: number): Promise<IndexerAccountPage>;
}

/** One resolved asset price, with the DATA_SCHEMA.md §3.7 ladder rank behind it. */
export interface PriceEntry {
  usd: number;                   // USD per WHOLE unit, already decimal-adjusted
  confidence: number;            // §3.7 contribution, multiplied into the fact's
  source: string;                // which rank produced it: "stable-hardcode", …
}

/**
 * A frozen table of prices, resolved BEFORE toFacts runs.
 *
 * Plain data, not an object with methods: a fixture file
 * (test/fixtures/<protocol>/prices.json, §Step 6) must be able to BE a
 * PriceTable, and an object carrying a live lookup could reach the network from
 * inside a supposedly pure toFacts. Look assets up with `priceOf(table, id)`,
 * which returns `null` for an unpriced asset so §3.6.1 can exclude the pool
 * rather than contribute a zero.
 */
export interface PriceTable {
  asOf: string;                            // RFC3339
  prices: Record<number, PriceEntry>;      // keyed by ASA id; ALGO is 0
}

/** §4.3 — the ONLY sanctioned USD price path. Resolve every asset in one call. */
export interface PriceService {
  resolve(assetIds: number[]): Promise<PriceTable>;
}
```

`Logger` is pino's, from `src/logger.ts`.

Test doubles for all five — plus a `makeContext()` with a frozen clock and a fake connector — live in `src/connectors/testing.ts`. Use them; do not hand-roll a stub whose `now` advances.

---

## 2. Step-by-step: adding a connector

### Step 1 — Classify the protocol

Pick exactly one `ProtocolClass`. Then answer, in writing, in the connector's `README.md`:

> **Who pays, what do they pay for, and how is that payment split between capital providers and the protocol?**

If you cannot answer this in three sentences, stop. You are not ready to map the protocol onto `DATA_SCHEMA.md` §3.1, and a connector that guesses here produces numbers that are worse than none — they look comparable and are not.

If the protocol fits no existing class (e.g. a perps venue, an NFT marketplace, a liquid staking token), **add a new class** to `DATA_SCHEMA.md` §3.2 with its own row of the cash-flow mapping, and bump `methodology_version` minor. Do not force it into `dex`.

### Step 2 — Verify the data source, by hand, before writing code

```bash
# Is it actually open? Check anonymously and with a browser UA.
curl -s -o /dev/null -w '%{http_code}\n' 'https://api.example.fi/pools'
curl -s -A 'Mozilla/5.0' 'https://api.example.fi/pools?limit=1' | jq .
```

Record in the connector README: status code, whether a key is required, pagination shape, rate limits, and **every field name you will read**.

This step is not ceremony. It is exactly how we learned that Folks Finance's REST API returns `{"message":"Forbidden"}` to anonymous callers and that Tinyman's pool list silently omits V2 pools regardless of the `version` param — two facts that each would have produced a confidently wrong connector.

**Source preference, in order:**
1. The protocol's own public API (open, no key).
2. On-chain application state via algod, ideally through the protocol's official SDK.
3. Indexer aggregation.
4. **No fourth option.** If a required datum is only available behind a paid or licensed API, the connector **declines that KPI**. It does not scrape, does not proxy a keyed service, and does not resell.

### Step 3 — Write `capabilities()` conservatively

Declare only KPIs you will compute from real data with a defensible formula. `/catalog` is generated from this, so an over-claim becomes a public promise we break on the first call.

The correct move when a KPI is hard is to omit it. `KPI_NOT_APPLICABLE` is a good response; a confidently wrong number is not.

**Omitting is a quiet decline; `declined` is a loud one.** Leaving a KPI out of `kpis` is enough most of the time — `/catalog` never advertises it and `/metric` answers `KPI_NOT_FOUND`. Use the `declined` map instead when the absence is itself a finding: the KPI is applicable to your class, a buyer will reasonably expect it from this protocol, and "not found" would read as a gap in *our* coverage rather than a gap in the *source's* disclosure. Pact is the worked case (`DATA_SCHEMA.md` §3.4): it declines `take_rate`, `protocol_revenue_24h`, `supply_side_revenue_24h` and `fee_apr` because `pact_fee_bps` is null on all 3,961 pools, and each reason names that. `/metric` then returns 404 `KPI_NOT_APPLICABLE` with the reason in the message.

Write the reason for the buyer, not for the codebase: say what the source does not publish, and name the KPI they should use instead.

Three declarations are checked at boot and will refuse the service a start if they are wrong (§Step 7): every KPI must be applicable to the class you picked in Step 1; declaring `active_users_24h` obliges you to list the `appIds` §4.1 computes it from; and `supportsBasis` must include `all_pools_usd_priced`, since that is what a request with no `?basis=` resolves to.

### Step 4 — Implement `fetchRaw`

Rules:
- Use `ctx.http` — never bare `fetch`. It carries the UA, timeout, retry/backoff, and per-host concurrency limit.
- Page exhaustively; do not silently truncate. If a page fails after retries, set `partial: true` and increment `excludedCount` rather than throwing away the whole snapshot.
- Populate `sources[]` with the **exact** URLs fetched. For on-chain reads, set `kind: 'onchain'`, `app_id`, and `round`. Provenance is a product feature (`DATA_SCHEMA.md` §1.4), not logging.
- **Validate every upstream payload with zod at the boundary.** Upstream schema drift is the likeliest production failure. An unparseable entity is skipped and counted, never coerced — a `NaN` that reaches a paid response is the worst outcome available.
- No arithmetic here. Not even a `parseFloat` that feeds a total.

### Step 5 — Implement `toFacts`

This is where `DATA_SCHEMA.md` §3 becomes code. For every KPI:

1. **Units:** divide by `10^decimals`; express rates as decimal fractions, never percents (`DATA_SCHEMA.md` §2.1).
2. **USD:** use `opts.prices` only. Never re-fetch a price here — `toFacts` is pure. If an asset is unpriced, exclude the entity and increment `coverage.excluded`; do not contribute a zero.
3. **Apply the §3.1 identity.** `gross_fees_24h = supply_side_revenue_24h + protocol_revenue_24h` must hold to within floating-point tolerance. **Assert it.** If it does not hold, you have misclassified a flow.
4. **Filters:** apply §3.6 uniformly. Set `coverage.basis`.
5. **Confidence:** compute per §5, from the base for the derivation plus penalties. Do not hand-pick a number that feels right.
6. **Estimation:** anything not directly reported gets `is_estimated: true` and a specific, human-readable `estimation_method`. "Estimated" alone is not an estimation method.
7. **Notes:** record anything a buyer would want to know — version splits, fallback constants used, the share of the aggregate that came from estimated components.

### Step 6 — Fixtures and golden tests

```
test/fixtures/<protocol>/
  pools-page-1.json         # verbatim recorded upstream response
  pools-page-2.json
  v2-accounts.json          # verbatim on-chain account records, in pages
  assets.json               # verbatim asset metadata, keyed by asset id
  v2-flows.json             # verbatim per-entity flow records
  prices.json               # frozen PriceTable
  expected-facts.json       # golden output of toFacts()
```

Required tests:

| Test | Asserts |
|---|---|
| `toFacts` golden | Byte-identical output for a frozen snapshot. Catches accounting regressions. |
| Cash-flow identity | `gross_fees == supply_side + protocol_revenue` on every fixture, ±1e-6 |
| Purity | Two `toFacts` calls on the same snapshot are identical; no `Date.now()` reached |
| Capability honesty | Every KPI in `capabilities().kpis` is produced by `toFacts` on the fixture |
| Schema conformance | Every fact validates against the `KpiFact` zod schema |
| Unpriced-asset handling | An asset removed from `prices.json` increases `coverage.excluded` and does **not** change `value` by contributing zero |
| Degradation | A truncated/corrupt fixture yields `partial: true` and reduced confidence, not a throw |

The golden test is the one that matters most. It is the difference between "our methodology is documented" and "our methodology is enforced."

**Record fixtures that exercise the exclusion paths.** A fixture holding only healthy entities lets every `coverage.excluded` branch rot untested while the suite stays green. `scripts/record-tinyman-fixtures.ts` picks its subset deliberately: the entities that dominate TVL, plus dust, plus empty pools, plus ones the price ladder cannot price. Its output is verbatim upstream records; only the *envelopes* (page boundaries, `next-token`) are synthesised, and the harness says so in a comment at the point where it does it.

**Regenerating the golden is a decision, not a build step.** `UPDATE_GOLDEN=1 npx vitest run test/connectors/<protocol>` rewrites it; you then read the diff and account for every number that moved. If a fixture re-recording and a methodology change land together, the diff conflates them — say so in the commit rather than presenting the combined delta as the methodology's effect.

**Stub what must never be called again.** When a change removes a code path, make the fixture *throw* on it rather than merely not exercising it. The Tinyman harness's `getApplicationLocalState` throws, because the 1.1.0 enumeration must never reintroduce 17,119 per-pool algod reads — a regression that would be invisible in the numbers and would quadruple the refresh time.

### Step 7 — Register

```ts
// src/connectors/registry.ts
import { exampleConnector } from './example';

export const registry = new Map<string, Connector>([
  ['tinyman', tinymanConnector],
  ['pact',    pactConnector],
  ['folks',   folksConnector],
  ['example', exampleConnector],   // ← the only line that changes
]);
```

The Map key **must** equal `capabilities().id`. Every reader above looks the connector up by key while `/catalog` advertises the id, so a mismatch advertises a protocol whose `/metric/{protocol}/{kpi}` path 404s (§1.1).

`validateRegistry()` runs at boot and refuses to start on an incoherent connector — the same fail-loud principle as env validation in `src/config/env.ts`. It rejects:

- a KPI not in the `DATA_SCHEMA.md` §4 registry, or declared twice
- a KPI not applicable to the declared class (`utilization` on a `dex`)
- a KPI that is both declared and `declined`, a `declined` reason that is blank, or a `declined` entry for a KPI the class already excludes
- `active_users_24h` with absent or empty `appIds` (§4.1)
- an id that is not a lowercase slug, or that disagrees with the Map key
- empty `kpis`, empty `sourceHosts`, or a `supportsBasis` missing the §3.6 default

All problems are reported at once, so a boot failure needs one restart rather than one per mistake. A connector declaring `utilization` on a `dex` is a bug that must never reach `/catalog`.

`/catalog`, route validation, the refresher's hot set, `/health`, and the `/ask` router's capability matrix all read from the registry. None of them need editing.

### Step 8 — Document

`src/connectors/<protocol>/README.md`, ~1 page:
- The Step 1 "who pays whom" paragraph.
- Source verification results from Step 2 (with dates — these go stale).
- Field-by-field normalization table, in the style of `DATA_SCHEMA.md` §3.3–3.5.
- Known quirks and how they are handled.
- Confidence rationale per KPI.

If the connector introduces a new formula or a new class, also update `DATA_SCHEMA.md` and bump `methodology_version`. **A connector merged without a `DATA_SCHEMA.md` update is a methodology change made in the dark**, and that is the one kind of change this product cannot tolerate.

---

## 3. Reference skeleton

This compiles against §1 as written. If you change it, keep it compiling — it is
the file three connector authors will copy, and a skeleton that only *looks*
right teaches its mistakes three times.

```ts
// src/connectors/example/index.ts
import { z } from 'zod';
import type { Connector, RawSnapshot, ToFactsOpts } from '../types';
import type { KpiFact, SourceRef } from '../../standardize/schema';
import { computeConfidence } from '../../standardize/confidence';

const PoolSchema = z.object({
  id: z.string(),
  tvl_usd: z.string(),
  volume_24h_usd: z.string(),
  fee_usd_24h: z.string(),
  protocol_fee_bps: z.number().nullable(),
  total_fee_bps: z.number(),
  is_deprecated: z.boolean().default(false),
});
type Pool = z.infer<typeof PoolSchema>;

// ctx.http.getJson returns `unknown` (§1.2), so the ENVELOPE gets validated too,
// not just the rows inside it. `res.results` on an unvalidated `unknown` is the
// single most common way a connector turns upstream drift into a NaN.
const PageSchema = z.object({ count: z.number(), results: z.array(z.unknown()) });

const BASE = 'https://api.example.fi';
const MIN_TVL_USD = 1_000;                       // DATA_SCHEMA.md §3.6.2

export const exampleConnector: Connector = {
  capabilities: () => ({
    id: 'example',
    name: 'Example DEX',
    class: 'dex',
    kpis: ['tvl', 'volume_24h', 'gross_fees_24h', 'supply_side_revenue_24h',
           'protocol_revenue_24h', 'take_rate', 'capital_efficiency',
           'fee_apr', 'volume_to_tvl', 'pool_count'],
    // 'active_users_24h' omitted: app ids not reliably enumerable. Declining
    // beats approximating (§Step 3).
    sourceHosts: ['api.example.fi'],
    supportsBasis: ['all_pools_usd_priced', 'verified_only'],
  }),

  async fetchRaw(ctx, opts): Promise<RawSnapshot> {
    const entities: Pool[] = [];
    const sources: SourceRef[] = [];
    let partial = false, excludedCount = 0, offset = 0;

    for (;;) {
      const url = `${BASE}/pools?limit=200&offset=${offset}`;
      const raw = await ctx.http.getJson(url).catch(() => null);
      const page = PageSchema.safeParse(raw);
      // A page we cannot even parse the envelope of is a partial snapshot, not
      // a thrown-away one (§Step 4).
      if (!page.success) { partial = true; break; }

      sources.push({ name: 'example-api', url, kind: 'rest',
                     retrieved_at: ctx.now().toISOString() });

      for (const row of page.data.results) {
        const parsed = PoolSchema.safeParse(row);
        if (parsed.success) entities.push(parsed.data);
        else { excludedCount++; ctx.log.warn({ row }, 'schema drift'); }
      }

      offset += 200;
      if (offset >= page.data.count) break;
    }
    return { entities, fetchedAt: ctx.now().toISOString(), sources, partial, excludedCount };
  },

  toFacts(snapshot: RawSnapshot, opts: ToFactsOpts): KpiFact[] {
    const all = snapshot.entities as Pool[];
    const pools = all.filter(p => !p.is_deprecated && parseFloat(p.tvl_usd) >= MIN_TVL_USD);

    const tvl        = sum(pools, p => parseFloat(p.tvl_usd));
    const volume     = sum(pools, p => parseFloat(p.volume_24h_usd));
    const grossFees  = sum(pools, p => parseFloat(p.fee_usd_24h));

    // Per-pool protocol share; null → 0 (conservative lower bound), DATA_SCHEMA §3.4
    let estimatedFeeShare = 0;
    const protocolRevenue = sum(pools, p => {
      const fees = parseFloat(p.fee_usd_24h);
      if (p.protocol_fee_bps == null) { estimatedFeeShare += fees; return 0; }
      return fees * (p.protocol_fee_bps / p.total_fee_bps);
    });
    const supplySide = grossFees - protocolRevenue;

    // §3.1 identity — assert, don't assume.
    assertClose(grossFees, supplySide + protocolRevenue, 1e-6);

    // Fields shared by every fact. `cache` and `stale` are required on a fact
    // carrying a value (§2); the connector emits the honest values for a fresh
    // computation and the cache layer (step 5) overwrites them on a hit.
    const base = {
      protocol: 'example',
      timestamp: opts.now,                       // RFC3339 string, injected (§1.1)
      as_of: snapshot.fetchedAt,
      source: [...snapshot.sources],           // copy: RawSnapshot.sources is
                                               // readonly, and a fact must not
                                               // alias the snapshot's array
      methodology_version: opts.methodologyVersion,
      cache: 'miss' as const,
      stale: false,
      coverage: { entities: pools.length,
                  excluded: snapshot.excludedCount + (all.length - pools.length),
                  basis: opts.basis },
    };

    const estimatedShare = grossFees > 0 ? estimatedFeeShare / grossFees : 0;
    // §5 penalties are a fixed vocabulary (PENALTIES in standardize/confidence.ts).
    // A connector picks from it; it never invents a penalty name or a float.
    const sparse = estimatedShare > 0.1 ? (['high_exclusion'] as const) : ([] as const);

    return [
      { ...base, metric: 'tvl', value: tvl, unit: 'USD',
        // `derivation` is an object, and `metric` is REQUIRED — it is what
        // applies the §4 per-KPI confidence caps (§4.4).
        confidence: computeConfidence({ derivation: { kind: 'reported' }, metric: 'tvl' }),
        is_estimated: false, estimation_method: null, notes: [] },

      { ...base, metric: 'protocol_revenue_24h', value: protocolRevenue, unit: 'USD',
        confidence: computeConfidence({ derivation: { kind: 'arithmetic' },
                                        penalties: sparse,
                                        metric: 'protocol_revenue_24h' }),
        is_estimated: estimatedShare > 0,
        estimation_method: estimatedShare > 0
          ? 'protocol_fee_bps absent on some pools; their protocol cut assumed 0 (lower bound)'
          : null,
        notes: estimatedShare > 0
          ? [`${(estimatedShare * 100).toFixed(1)}% of gross fees came from pools with no protocol_fee_bps; this is a lower bound.`]
          : [] },

      // A KPI that is null BY DEFINITION is omitted, or emitted as the §2 error
      // fact via makeErrorFact() — never as a bare `value: null`, which the
      // KpiFact schema rejects, and never as a plausible-looking 0 (§1.5).
      ...(tvl > 0
        ? [{ ...base, metric: 'capital_efficiency' as const,
             value: (grossFees * 365) / tvl, unit: 'RATIO' as const,
             confidence: computeConfidence({ derivation: { kind: 'arithmetic' },
                                             metric: 'capital_efficiency' }),
             is_estimated: false, estimation_method: null, notes: [] }]
        : []),
      // … remaining declared KPIs
    ];
  },

  async healthCheck(ctx) {
    const res = await ctx.http.getJson(`${BASE}/pools?limit=1`).catch(() => null);
    return res ? { ok: true } : { ok: false, detail: 'pools endpoint unreachable' };
  },
};
```

---

## 4. Shared infrastructure a connector must use (and must not reimplement)

### 4.1 `ctx.http`
Timeout 8s, 3 retries with exponential backoff + jitter, per-host concurrency cap (8), a `User-Agent` identifying AlgoTerminal with a contact URL, and per-host request counters exposed on `/health`. A connector that calls bare `fetch` bypasses all of it and will eventually get us rate-limited or banned from a source we depend on.

### 4.2 `ctx.algod` / `ctx.indexer`
Pre-configured Nodely clients with the same retry policy. For on-chain reads, always record the `round` in the `SourceRef` — an on-chain number without a round is not reproducible, and reproducibility is a stated product guarantee.

### 4.3 `PriceService`
The only sanctioned USD price path (`DATA_SCHEMA.md` §3.7); full contract in §1.2. Resolved before `toFacts` and passed in as a frozen `PriceTable`, which is what keeps `toFacts` pure and testable. A connector that fetches its own prices breaks purity, breaks the golden tests, and silently introduces a second pricing methodology — the exact failure mode this whole product exists to eliminate.

### 4.4 `computeConfidence`
Centralized in `src/standardize/confidence.ts`. Connectors declare a `derivation`, a list of `penalties`, and the `metric` the confidence is for; they never hardcode a confidence float. `metric` is required because the per-KPI hard caps in the §4 registry (today: `active_users_24h` at 0.80) are applied here — an omitted metric would silently bypass a cap `DATA_SCHEMA.md` §4.1 states applies always, on every protocol. Hardcoded confidences drift apart across connectors and make the number meaningless.

---

## 5. Checklist for a new connector PR

- [ ] Protocol class chosen; "who pays whom" paragraph written in the connector README
- [ ] Data source verified by hand (anonymous curl), results and date recorded
- [ ] Source is public and free; nothing licensed, keyed, scraped, or proxied
- [ ] `capabilities()` lists only KPIs actually computed, all applicable to the declared class
- [ ] `appIds` listed if `active_users_24h` is declared; `supportsBasis` includes the §3.6 default
- [ ] `capabilities().id` equals the key it is registered under
- [ ] `fetchRaw` does I/O only; zod-validates every upstream payload; pages exhaustively; records exact `sources[]`
- [ ] `toFacts` is pure; no `Date.now()`, no network, no randomness; `timestamp` comes from `opts.now`
- [ ] Cash-flow identity (§3.1) asserted in code **and** in a test
- [ ] Filters from `DATA_SCHEMA.md` §3.6 applied; `coverage` populated
- [ ] Confidence via `computeConfidence`; no hardcoded floats
- [ ] Every estimate has `is_estimated: true` and a specific `estimation_method`
- [ ] Fixtures recorded; all seven tests in Step 6 pass
- [ ] Registered in `registry.ts`; boot-time `validateRegistry()` passes; `/catalog` shows the protocol correctly
- [ ] Connector README written
- [ ] `DATA_SCHEMA.md` updated and `methodology_version` bumped if any formula or class is new
- [ ] `/health` reports the new connector
