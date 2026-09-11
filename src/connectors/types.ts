import type { Logger } from 'pino';

import type { KpiFact, KpiId, ProtocolClass, SourceRef } from '../standardize/schema.js';
import type { Basis } from '../standardize/types.js';

/**
 * CONNECTOR_GUIDE.md §1 — the connector interface.
 *
 * The property this file exists to protect: adding protocol #4 is one new
 * directory plus one line in `registry.ts`, and nothing else in the codebase
 * changes. If implementing a connector requires editing the standardization
 * layer, the cache, the routes or the payment gate, this interface is wrong and
 * should be fixed rather than worked around.
 */

// ---------------------------------------------------------------------------
// Capabilities — what a connector declares it can produce
// ---------------------------------------------------------------------------

/**
 * Drives `/catalog` and route validation. §Step 3: declare conservatively —
 * `/catalog` is generated from this, so an over-claim is a public promise we
 * break on the first call. The correct move when a KPI is hard is to omit it.
 */
export interface ConnectorCapabilities {
  /** Stable slug, lowercase: "tinyman". Must match `SLUG_RE` in `registry.ts`. */
  readonly id: string;
  /** Display name: "Tinyman". */
  readonly name: string;
  /** Exactly one class (DATA_SCHEMA.md §2.2); it determines KPI applicability. */
  readonly class: ProtocolClass;
  /**
   * ONLY the KPIs this connector can actually compute.
   *
   * Typed `KpiId[]`, not `string[]`, so a connector cannot declare a KPI that
   * does not exist in the §4 registry — that is a compile error rather than a
   * `/catalog` entry we cannot serve.
   */
  readonly kpis: readonly KpiId[];
  /**
   * Hostnames / "algod:host" a connector reads from. Advertised on `/catalog`
   * as `sources` (API_SPEC.md §3.4).
   *
   * Deliberately NOT called `sources`: {@link RawSnapshot.sources} is the
   * per-fetch list of exact `SourceRef`s actually read, which becomes each
   * fact's provenance. One is a promise about where our numbers come from, the
   * other is the receipt, and giving them one name read as a bug.
   */
  readonly sourceHosts: readonly string[];
  /**
   * Algorand application ids. REQUIRED (non-empty) when `kpis` includes
   * `active_users_24h`: DATA_SCHEMA.md §4.1 computes that KPI by filtering
   * indexer transactions on these ids, and a connector that cannot enumerate
   * them declines the KPI rather than approximating it. Enforced at boot by
   * `validateCapabilities` in `registry.ts`.
   */
  readonly appIds?: readonly number[];
  /** Which `?basis=` values this connector implements (DATA_SCHEMA.md §3.6). */
  readonly supportsBasis: readonly Basis[];
  /**
   * KPIs this connector has DELIBERATELY declined, mapped to the reason.
   *
   * Omitting a KPI from {@link kpis} is already a decline — `/metric` answers
   * it with `KPI_NOT_FOUND` and `/catalog` never advertises it. This field is
   * for the case where silence is the wrong answer: a KPI that is applicable to
   * the class, that a buyer will reasonably expect from this protocol, and
   * whose absence is itself a finding about the source.
   *
   * The motivating case is Pact's `take_rate` (DATA_SCHEMA.md §3.4). Pact is a
   * `dex`, every other `dex` publishes a take rate, and `pact_fee_bps` is null
   * on 100% of pools — so the honest answer is not "no such metric" but "the
   * source does not publish its cut". §1.5 requires declining loudly; a bare
   * `KPI_NOT_FOUND` declines quietly, and an agent comparing take rates would
   * read it as a gap in our coverage rather than a gap in Pact's disclosure.
   *
   * Route behaviour is generic (`src/routes/metric.ts`): a declined KPI is a
   * 404 `KPI_NOT_APPLICABLE` carrying this reason. No route knows any protocol
   * name, which is the §1 property this whole file exists to protect.
   *
   * A KPI may not appear in both {@link kpis} and here; enforced at boot.
   */
  readonly declined?: Readonly<Partial<Record<KpiId, string>>>;
}

// ---------------------------------------------------------------------------
// RawSnapshot — the fetchRaw / toFacts boundary
// ---------------------------------------------------------------------------

/**
 * Opaque to everything above the connector: the shape of `entities` is the
 * connector's own business, and no route, cache or standardization code may
 * inspect it. That is what keeps protocol knowledge inside one directory.
 *
 * It is also the golden-test unit — a recorded snapshot plus a frozen
 * `PriceTable` is a complete, replayable input to `toFacts`.
 */
export interface RawSnapshot {
  /** Pools / markets, connector-native. */
  readonly entities: readonly unknown[];
  /** RFC3339. What moment the data describes — becomes the fact's `as_of`. */
  readonly fetchedAt: string;
  /** Exact URLs / app ids + rounds actually read (DATA_SCHEMA.md §1.4). */
  readonly sources: readonly SourceRef[];
  /** True if some pages or entities failed after retries. */
  readonly partial: boolean;
  /** Entities dropped during fetch (schema drift), not during §3.6 filtering. */
  readonly excludedCount: number;
}

// ---------------------------------------------------------------------------
// Prices — §4.3 / DATA_SCHEMA.md §3.7
// ---------------------------------------------------------------------------

/** One resolved asset price, with the §3.7 ladder rank that produced it. */
export interface PriceEntry {
  /** USD per whole unit of the asset (already decimal-adjusted). */
  readonly usd: number;
  /** §3.7 confidence contribution, multiplied into the fact's confidence. */
  readonly confidence: number;
  /** Which ladder rank produced it, e.g. "stable-hardcode", "tinyman-assets". */
  readonly source: string;
}

/**
 * A frozen table of prices, resolved BEFORE `toFacts` runs.
 *
 * Deliberately plain data rather than an object with methods: a fixture file
 * (`test/fixtures/<protocol>/prices.json`, §Step 6) must be able to *be* a
 * `PriceTable`, and an object carrying a live lookup function could reach the
 * network from inside a supposedly pure `toFacts`.
 */
export interface PriceTable {
  /** RFC3339 — when these prices were resolved. */
  readonly asOf: string;
  /** Keyed by Algorand asset id. ALGO is `0` (§3.7). */
  readonly prices: Readonly<Record<number, PriceEntry>>;
}

/** Look up an asset, or null if unpriced — §3.6.1 excludes pools touching it. */
export function priceOf(table: PriceTable, assetId: number): PriceEntry | null {
  return table.prices[assetId] ?? null;
}

/**
 * §4.3 — the ONLY sanctioned USD price path. A connector that fetches its own
 * prices breaks purity, breaks the golden tests, and silently introduces a
 * second pricing methodology.
 */
export interface PriceService {
  /** Resolve every asset a snapshot touches, in one call, per the §3.7 ladder. */
  resolve(assetIds: readonly number[]): Promise<PriceTable>;
}

// ---------------------------------------------------------------------------
// The I/O side: ConnectorContext and its clients
// ---------------------------------------------------------------------------

/**
 * §4.1 — timeout, retries with backoff + jitter, per-host concurrency cap, and
 * a `User-Agent` identifying us with a contact URL. A connector that calls bare
 * `fetch` bypasses all of it and will eventually get us rate-limited or banned
 * from a source we depend on.
 *
 * Returns `unknown` on purpose: §Step 4 requires every upstream payload to be
 * zod-validated at the boundary, and a typed return would let a connector skip
 * that by asserting a shape the upstream never promised.
 */
export interface HttpClient {
  getJson(url: string, opts?: { readonly timeoutMs?: number }): Promise<unknown>;
}

/**
 * One entry of an application's key/value state, with algod's base64 decoded.
 *
 * A discriminated union rather than `{ uint?, bytes? }`: a caller that reads
 * `.uint` off a byte-slice key gets `undefined`, and `undefined` in arithmetic
 * is the `NaN` that CONNECTOR_GUIDE §Step 4 calls the worst outcome available.
 */
export type AppStateValue =
  | { readonly type: 'uint'; readonly uint: number }
  | { readonly type: 'bytes'; readonly bytes: Uint8Array };

/**
 * Decoded application state, keyed by the UTF-8 key name. algod returns both
 * key and value base64-encoded; decoding belongs in the shared client so every
 * connector reads state the same way rather than each hand-rolling base64.
 */
export type AppState = Readonly<Record<string, AppStateValue>>;

/**
 * §4.2 — a pre-configured Nodely algod client. Narrow by design: it exposes
 * what DATA_SCHEMA.md actually requires of an on-chain read, and `round` is
 * first-class because an on-chain number without a round is not reproducible.
 */
export interface AlgodClient {
  readonly baseUrl: string;
  /** Current ledger round — record it in the `SourceRef` for every on-chain read. */
  status(): Promise<{ readonly lastRound: number }>;
  /** Global state of an application, at the round returned alongside it. */
  getApplication(appId: number): Promise<{ readonly round: number; readonly application: unknown }>;
  /**
   * An ACCOUNT's local state under an application, at the round it was read.
   *
   * Not a special case for one protocol: per-account state under a single
   * controller application is a standard Algorand pattern, and it is where
   * Tinyman V2 keeps each pool's `total_fee_share` / `protocol_fee_ratio`
   * (DATA_SCHEMA.md §3.3 says "the pool application's global state", which is
   * wrong against the live chain — verified 2026-09-08: every V2 pool is a
   * logic-sig account opted into validator app 1002541853, and the fee
   * parameters are that account's LOCAL state).
   *
   * `state` is `null` when the account is not opted into the application,
   * which is an absence a caller must handle — never an empty object that
   * silently reads as "every parameter is zero".
   */
  /**
   * An APPLICATION's global state, with the ledger round it was read at.
   *
   * `state` is null when the application does not exist or publishes no global
   * state — an absence, never an empty object that would read as "every
   * parameter is zero", the same contract {@link getApplicationLocalState}
   * keeps for a non-opted-in account.
   *
   * Added at step 8. Folks Finance keeps each lending market's entire
   * configuration — deposits, debt, rates, retention — in one application's
   * global state, and its REST API is closed to anonymous callers, so global
   * state is the only path to a Folks number. Application global state is the
   * most standard shape on Algorand, not one protocol's quirk, which is why it
   * belongs on the shared client rather than inside the connector: the
   * alternative is every future connector re-parsing algod's
   * `params['global-state']` envelope and getting the base64 handling subtly
   * different (CONNECTOR_GUIDE §4.2).
   */
  getApplicationGlobalState(
    appId: number,
  ): Promise<{ round: number; state: AppState | null }>;
  getApplicationLocalState(
    address: string,
    appId: number,
  ): Promise<{ readonly round: number; readonly state: AppState | null }>;
  /** Raw box / state read for protocols that store market state in boxes. */
  getApplicationBox(appId: number, name: Uint8Array): Promise<{ readonly round: number; readonly value: Uint8Array }>;
}

/**
 * One account's local state under a controller application, as returned by the
 * §3.3 account walk. The same shape `AlgodClient.getApplicationLocalState`
 * returns, minus the null case: an account the walk yields is by construction
 * opted in, and one that is not is dropped and counted rather than handed back
 * as an empty state that reads as "every parameter is zero".
 */
export interface IndexerAccountState {
  readonly address: string;
  /** The round this account was read at — an on-chain number needs one (§4.2). */
  readonly round: number;
  readonly state: AppState;
}

/** What one exhaustive {@link IndexerClient.listAccountsByApplication} walk found. */
export interface IndexerAccountPage {
  readonly accounts: readonly IndexerAccountState[];
  /** The indexer's own `current-round` for the walk. */
  readonly currentRound: number;
  /** Pages successfully read. */
  readonly pages: number;
  /** Pages that would not come back after retries. Non-zero implies `partial`. */
  readonly failedPages: number;
  /** Accounts dropped: deleted, schema drift, or no local state under the app. */
  readonly skipped: number;
  /** True when the walk did not reach the end. NEVER a silent truncation. */
  readonly partial: boolean;
  /** The exact page URLs read, for `SourceRef`s (§1.4). */
  readonly urls: readonly string[];
}

/**
 * §4.2 — pre-configured Nodely indexer.
 *
 * `searchTransactions` is the DATA_SCHEMA §4.1 path for `active_users_24h`:
 * filter by application id over a round range, page exhaustively, collect
 * distinct senders. Paging is the caller's, so a connector can bound its cost.
 *
 * `listAccountsByApplication` is the DATA_SCHEMA §3.3 path for enumerating
 * every account opted into a controller application. It pages internally and
 * exhaustively, because a partial account enumeration is not a smaller answer —
 * it is a protocol's TVL understated by an amount nothing downstream can see.
 */
export interface IndexerClient {
  readonly baseUrl: string;
  searchTransactions(params: {
    readonly applicationId: number;
    readonly minRound?: number;
    readonly maxRound?: number;
    readonly limit?: number;
    readonly next?: string;
  }): Promise<{ readonly transactions: readonly unknown[]; readonly nextToken?: string }>;
  /** Every account opted into `appId`, with its local state. Pages internally. */
  listAccountsByApplication(appId: number): Promise<IndexerAccountPage>;
}

/**
 * Everything a connector may touch that involves I/O — and nothing else.
 *
 * It is passed to `fetchRaw` and `healthCheck`, and pointedly NOT to `toFacts`.
 */
export interface ConnectorContext {
  readonly prices: PriceService;
  readonly algod: AlgodClient;
  readonly indexer: IndexerClient;
  readonly http: HttpClient;
  readonly log: Logger;
  /** Injected, never `Date.now()`, so tests are deterministic (§1). */
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FetchOpts {
  readonly basis: Basis;
  /**
   * Lets a connector skip expensive fetches it does not need — e.g. the
   * indexer scan that `active_users_24h` requires and no other KPI does.
   */
  readonly kpis: readonly KpiId[];
}

/**
 * Everything `toFacts` gets beyond the snapshot — and every field of it is
 * inert data.
 *
 * `now` is an RFC3339 *string*, not a `Date` and emphatically not a `() => Date`
 * as on {@link ConnectorContext}: a clock function is I/O wearing a small hat,
 * and passing one here would make `toFacts` return a different `timestamp` on
 * every call, which is exactly what the purity golden test asserts against.
 */
export interface ToFactsOpts extends FetchOpts {
  /** Resolved BEFORE `toFacts`, which is what keeps `toFacts` pure (§4.3). */
  readonly prices: PriceTable;
  /** RFC3339 — becomes each fact's `timestamp` ("when WE computed it", §2). */
  readonly now: string;
  readonly methodologyVersion: string;
}

// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

/** §Step 6 / §4.4 — a connector's cheap liveness probe result. */
export interface HealthProbe {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * The `fetchRaw` / `toFacts` split is the load-bearing decision (§1). All I/O
 * on one side, all arithmetic on the other. It buys three things: golden-file
 * tests over recorded fixtures, so an accounting regression is caught in CI
 * before it reaches a paid response; a cache free to store raw snapshots or
 * facts; and a reviewable diff when methodology changes, because the change is
 * confined to a pure function.
 *
 * The split is enforced in the TYPES, not by convention: `toFacts` is
 * synchronous (so it cannot await), and receives no `ConnectorContext` — it is
 * handed nothing it could do I/O with.
 */
export interface Connector {
  capabilities(): ConnectorCapabilities;

  /** Fetch raw upstream data. I/O ONLY — no arithmetic, no USD, no KPI logic. */
  fetchRaw(ctx: ConnectorContext, opts: FetchOpts): Promise<RawSnapshot>;

  /**
   * Which asset ids this snapshot's facts need USD prices for.
   *
   * The one piece the fetchRaw/toFacts split leaves the caller unable to
   * derive on its own. `toFacts` receives a `PriceTable` that must be resolved
   * before it runs (that is what keeps it pure), but only the connector knows
   * which assets its own entities touch — `RawSnapshot.entities` is `unknown[]`
   * by design, and nothing above the connector may look inside it.
   *
   * Until the cache (step 5) there was no generic caller: the Tinyman tests
   * imported `assetIdsFor` directly, which works for a test and does not work
   * for a pipeline that must run any registered connector. So it is on the
   * interface, where connector #4 will find it.
   *
   * Optional, because a connector whose KPIs are all counts and ratios needs
   * no prices at all and should not have to write `return []`. It is PURE for
   * the same reason `toFacts` is: it reads the snapshot and nothing else.
   */
  priceAssets?(snapshot: RawSnapshot): readonly number[];

  /**
   * Convert raw → standardized facts. PURE: no I/O, no `Date.now()`, no
   * randomness. Same snapshot in ⇒ byte-identical facts out. This is what the
   * golden tests assert.
   *
   * Must return a fact for every requested KPI, or omit it entirely — never a
   * zero, never a null without an `error` (DATA_SCHEMA.md §1.5, §2).
   */
  toFacts(snapshot: RawSnapshot, opts: ToFactsOpts): KpiFact[];

  /** Cheap liveness probe for `/health`. Must not be the full `fetchRaw`. */
  healthCheck(ctx: ConnectorContext): Promise<HealthProbe>;
}
