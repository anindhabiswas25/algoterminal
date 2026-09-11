import { combineConfidence, computeConfidence } from '../../standardize/confidence.js';
import type { Derivation, PenaltyKind } from '../../standardize/confidence.js';
import type { KpiFact, KpiId } from '../../standardize/schema.js';
import { MAX_EXCLUSION_RATIO, MIN_TVL_USD } from '../../standardize/types.js';
import type { Connector, ConnectorContext, FetchOpts, HealthProbe, RawSnapshot, ToFactsOpts } from '../types.js';
import { PACT_BASE, fetchPools, poolPageUrl } from './enumerate.js';
import { isPoolEntity, isPriced, type PactPool, type PactPoolEntity } from './schema.js';

/**
 * DATA_SCHEMA.md §3.4 — the Pact connector (`dex`).
 *
 * Who pays whom: a swapper pays a fee on every trade, set per pool between 2
 * and 100 bps; the LPs who supplied that pool receive it. Pact's own protocol
 * cut is published as `pact_fee_bps`, and on every one of the 3,961 pools in
 * the live catalogue that field is `null` — so the share Pact keeps is a number
 * this connector does not have and does not invent. See `README.md`.
 *
 * ## What this connector is, structurally
 *
 * One open REST endpoint, one paginated walk, and arithmetic. No chain reads,
 * no per-entity lookups, and — unlike Tinyman — no price ladder: Pact computes
 * and publishes `tvl_usd`, `volume_24h` and `fee_usd_24h` in dollars itself, so
 * there is no USD conversion for this connector to perform and no
 * {@link Connector.priceAssets} for it to declare. Every dollar figure below is
 * the §5 `reported` row, exactly as Tinyman's V1.1 half is.
 *
 * That asymmetry is worth stating plainly rather than smoothing over, because
 * it shows up in the stamped numbers: Pact's `tvl` carries a HIGHER confidence
 * than Tinyman's (0.95 base against 0.90 x a weighted price confidence), even
 * though Tinyman's is computed from on-chain reserves and Pact's is a figure we
 * copied. §5 is explicit that `confidence` grades the derivation, not our
 * satisfaction with it, and a reported dollar figure is a stronger derivation
 * than one we built out of reserves and prices. It is also a figure we cannot
 * audit, which is what the DefiLlama cross-check in `scripts/pact-live.ts` is
 * for.
 *
 * ## Three things §3.4 asserts that the live API contradicts
 *
 * All three were found by the §Step 2 hand-verification on 2026-09-09, before
 * any code was written, and all three are the kind that produce a confidently
 * wrong connector rather than a failing one. They are documented at the point
 * of use below and in full in `README.md`:
 *
 *  1. `volume_24h` is **already USD**. §3.4's headline instruction — convert it
 *     through the §3.7 ladder because it is denominated in the primary asset —
 *     would have overstated Pact's daily volume by 650x.
 *  2. `pact_fee_bps` is null on **100%** of pools, not "frequently". §3.4's
 *     lower bound is still the right treatment, but at 100% the bound is
 *     `protocol_revenue >= 0`, which is true of every protocol that has ever
 *     existed. See {@link protocolShareOf} and `README.md` §"The zero problem".
 *  3. `pool_type` is `CONST` / `MANAGED_WEIGHTED` / `STBL`, never
 *     `CONSTANT_PRODUCT`; `fee_amount_24h` is 0 everywhere; `apr_governance` is
 *     0 everywhere.
 */

// ---------------------------------------------------------------------------
// Constants — all verified against the live API on 2026-09-09 (README §Verification)
// ---------------------------------------------------------------------------

const PROTOCOL_ID = 'pact';

/** §3.1 identity tolerance, the same figure Tinyman asserts against. */
export const IDENTITY_TOLERANCE = 1e-6;

/**
 * What Pact publishes: the §4 `dex` KPIs that survive on measured data alone.
 *
 * Four of the remaining `dex` KPIs are declined in {@link DECLINED_KPIS} below
 * because they all rest on a fee split Pact does not disclose, and
 * `active_users_24h` is declined for the separate reason that follows.
 *
 * §4.1 computes active users by filtering indexer transactions on a protocol's
 * application ids. Pact has no single validator application to filter on: every
 * pool IS its own application (`on_chain_id` is the pool's app id, and there
 * are 3,961 distinct ones), so the scan would be 3,961 paged indexer walks per
 * refresh, and any smaller set would silently answer a different question than
 * the one `active_users_24h` names. §Step 3 and §4.1 both say the same thing
 * about that case: decline it. A `KPI_NOT_APPLICABLE` is a good response; a
 * confidently wrong user count is not.
 */
const DECLARED_KPIS = [
  'tvl',
  'volume_24h',
  'gross_fees_24h',
  'capital_efficiency',
  'volume_to_tvl',
  'pool_count',
] as const satisfies readonly KpiId[];

/**
 * The four KPIs of the §3.1 split that Pact does not publish enough to support,
 * with the reason `/metric` returns.
 *
 * ## Why these are declined rather than published as a bound
 *
 * `pact_fee_bps` — the protocol's own cut — is `null` on **3,961 of 3,961**
 * pools (measured 2026-09-09; §3.4 said "frequently null", which understated
 * it). §3.4's treatment of a null split is `protocol_share = 0`, which makes
 * `protocol_revenue_24h` a documented lower bound. That is the right rule when
 * the field is sparse. At 100% it degenerates: the bound becomes
 * `protocol_revenue >= $0`, true of every protocol that has ever existed, and
 * the published value is `$0.00` with `take_rate` `0.000000`.
 *
 * A note saying the bound constrains nothing does not fix that, because the
 * number travels without the note. The concrete harm is `/compare`:
 * `?metric=take_rate` would rank Tinyman's 0.248 above Pact's 0.000 and an
 * agent would read "Pact captures no revenue", when the truth is "Pact does not
 * publish its cut". §1.5 is explicit — we decline loudly rather than return a
 * plausible-looking zero — and §Step 3 is explicit that omitting a KPI beats
 * approximating it.
 *
 * ## Why `supply_side_revenue_24h` and `fee_apr` go too
 *
 * They are the same claim wearing the other sign. With `protocol_share = 0`,
 * `supply_side_revenue_24h = gross_fees_24h - 0 = gross_fees_24h` exactly, and
 * publishing that asserts **"LPs receive 100% of swap fees"** — a statement
 * about Pact's economics that we have no evidence for and that is very likely
 * false. `fee_apr` is `supply_side_revenue_24h * 365 / tvl`, so it inherits the
 * claim intact and additionally comes out numerically identical to
 * `capital_efficiency`, which reads as a coincidence and is really a tell that
 * one of the two is not measuring what its name says.
 *
 * `gross_fees_24h` and `capital_efficiency` survive because both are built on
 * `fee_usd_24h`, which Pact reports directly and which needs no split at all.
 * The one leg of §3.1 we measured is the one leg we publish.
 */
const DECLINED_KPIS: Readonly<Partial<Record<KpiId, string>>> = {
  protocol_revenue_24h:
    "Pact does not publish the protocol's share of the swap fee. " +
    '`pact_fee_bps` is null on ' +
    'every pool in the catalogue (3,961 of 3,961, measured 2026-09-09), so the only honest ' +
    'bound is "at least $0", which constrains nothing. Publishing $0.00 would read as "Pact ' +
    'captures no revenue" when the fact is that Pact does not disclose its cut (DATA_SCHEMA.md ' +
    '§1.5, §3.4). gross_fees_24h — what swappers actually paid — is published and is exact.',
  supply_side_revenue_24h:
    'Derived from a fee split Pact does not publish (`pact_fee_bps` is null on all 3,961 pools). ' +
    'With the protocol share unknown, this figure would equal gross_fees_24h exactly, which ' +
    'asserts that LPs receive 100% of swap fees — a claim about Pact we cannot support ' +
    '(DATA_SCHEMA.md §3.4). Use gross_fees_24h, which is measured.',
  take_rate:
    'take_rate is protocol_revenue_24h / gross_fees_24h, and Pact does not publish the ' +
    'numerator: `pact_fee_bps` is null on all 3,961 pools. A take_rate of 0.000000 would rank ' +
    'Pact below every protocol that discloses its cut, for a reason that is about disclosure ' +
    'rather than economics (DATA_SCHEMA.md §1.5, §3.4).',
  fee_apr:
    'fee_apr is supply_side_revenue_24h * 365 / tvl, and the supply-side split is unpublished ' +
    '(`pact_fee_bps` is null on all 3,961 pools). Computing it would silently assume LPs keep ' +
    '100% of fees and would return a number identical to capital_efficiency. Use ' +
    'capital_efficiency, which is built on measured gross fees and makes no split assumption.',
  // Declined for a different reason from the four above: not an undisclosed
  // source field, but a measurement we cannot make at Pact's architecture.
  // Listed here rather than merely omitted because every other `dex` we cover
  // publishes it, so a buyer comparing DEXes will look for it and deserves the
  // reason instead of a bare KPI_NOT_FOUND.
  active_users_24h:
    'DATA_SCHEMA.md §4.1 counts distinct addresses transacting against a protocol\'s ' +
    'application ids, and Pact has no single validator application to filter on: every pool is ' +
    'its own application (3,961 distinct app ids), so the count would require 3,961 paged ' +
    'indexer walks per refresh, and any smaller sample would answer a narrower question than ' +
    'the KPI names. Declined rather than approximated (DATA_SCHEMA.md §1.5).',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** §3.1 is an identity, not an aspiration. A violation is a misclassified flow. */
export function assertCashFlowIdentity(
  gross: number,
  supplySide: number,
  protocolRevenue: number,
): void {
  const drift = Math.abs(gross - (supplySide + protocolRevenue));
  if (drift > IDENTITY_TOLERANCE) {
    throw new Error(
      `DATA_SCHEMA.md §3.1 violated: gross_fees_24h ${gross} != supply_side ${supplySide} + protocol_revenue ${protocolRevenue} (drift ${drift})`,
    );
  }
}

/** The §3.1 decomposition of one snapshot's fees, in dollars. */
export interface CashFlowSplit {
  /** What swappers paid. Measured: Σ fee_usd_24h. */
  readonly gross: number;
  /** What LPs received. Residual, and unpublished — see {@link DECLINED_KPIS}. */
  readonly supplySide: number;
  /** What Pact kept. Unpublished, for the same reason. */
  readonly protocolRevenue: number;
  /** Share of `gross` whose protocol cut Pact does not disclose. 1.0 live. */
  readonly unknownShare: number;
}

/**
 * The §3.1 split over a set of included pools.
 *
 * Exported and pure so the §3.1 identity can be TESTED on every fixture even
 * though two of its three legs are no longer published (§Step 6 requires that
 * test, and reading the legs back off the emitted facts would now assert
 * nothing). The identity is a property of this arithmetic; whether we publish
 * the result is a separate decision, taken in {@link DECLINED_KPIS}.
 */
export function splitFees(values: readonly PoolValue[]): CashFlowSplit {
  let gross = 0;
  let protocolRevenue = 0;
  let unknownSplitFees = 0;
  for (const value of values) {
    gross += value.fees;
    protocolRevenue += value.fees * value.protocolShare;
    if (!value.splitKnown) unknownSplitFees += value.fees;
  }
  const supplySide = gross - protocolRevenue;
  assertCashFlowIdentity(gross, supplySide, protocolRevenue);
  return {
    gross,
    supplySide,
    protocolRevenue,
    unknownShare: gross > 0 ? unknownSplitFees / gross : 0,
  };
}

/**
 * The protocol's share of a pool's swap fee, per §3.4.
 *
 * `pact_fee_bps` present  -> `pact_fee_bps / fee_bps`, reported, not estimated.
 * `pact_fee_bps` absent   -> **0.0**, estimated, and the pool still contributes
 *                            its full fee to `gross_fees_24h` and
 *                            `supply_side_revenue_24h`.
 *
 * Assuming zero rather than guessing a default cut is what makes
 * `protocol_revenue_24h` a documented lower bound instead of a fabrication. A
 * plausible-looking constant — Tinyman's 1/6, say — would produce a number that
 * reads as authoritative, cannot be traced to anything Pact published, and
 * would be wrong by an unknown amount in an unknown direction.
 *
 * `fee_bps <= 0` is treated as an absent split rather than a division by zero
 * wearing a plausible face.
 */
export function protocolShareOf(pool: PactPool): { share: number; known: boolean } {
  if (pool.pact_fee_bps !== null && pool.fee_bps > 0) {
    return { share: pool.pact_fee_bps / pool.fee_bps, known: true };
  }
  return { share: 0, known: false };
}

/** One pool reduced to the numbers §3.4 aggregates, or null if it cannot be valued. */
export interface PoolValue {
  readonly tvl: number;
  /** Already USD. Not converted — see the file header, correction 1. */
  readonly volume: number;
  /** Gross: the total fee charged to swappers, LP portion included. */
  readonly fees: number;
  readonly fees7d: number;
  /** Pact's own 7-day fee APR, a cross-check on our 24h figure. */
  readonly apr7d: number;
  readonly protocolShare: number;
  readonly splitKnown: boolean;
  readonly verified: boolean;
  readonly deprecated: boolean;
}

/**
 * Parse one pool's dollars, or return null when the record cannot support them.
 *
 * Returns null rather than a number for a non-finite parse. Nothing here
 * coerces: a `NaN` that reaches a paid response is the worst outcome available
 * (§Step 4), and every one of them starts as a string someone `Number()`d
 * without looking.
 */
export function valuePool(pool: PactPool): PoolValue | null {
  const tvl = Number(pool.tvl_usd);
  const volume = Number(pool.volume_24h);
  const fees = Number(pool.fee_usd_24h);
  const fees7d = Number(pool.fee_usd_7d);
  const apr7d = Number(pool.apr_7d);
  if (![tvl, volume, fees, fees7d, apr7d].every((n) => Number.isFinite(n) && n >= 0)) return null;

  const { share, known } = protocolShareOf(pool);
  return {
    tvl,
    volume,
    fees,
    fees7d,
    apr7d,
    protocolShare: share,
    splitKnown: known,
    // §3.6.5 — Pact's stricter basis is `is_verified || auto_verified_100k`.
    verified: pool.is_verified || pool.auto_verified_100k,
    deprecated: pool.is_deprecated,
  };
}

/**
 * The §3.6 filters, applied identically to Tinyman's — same constants, imported
 * from `standardize/types.ts` rather than redefined here (§3.6: "A connector
 * that redefines MIN_TVL_USD imports its own methodology").
 *
 * §3.6.1 is the one that needs a word. Pact publishes `tvl_usd` itself, so
 * there is no §3.7 conversion to fail — but the source computes that figure
 * from its own `primary_asset.price` and `secondary_asset.price`, and it
 * publishes those as `"0.00000000"` rather than null when it does not know
 * them. A pool with a zero-priced side therefore carries a `tvl_usd` counting
 * only its other half. That is exactly the "no reliable USD price for at least
 * one side" §3.6.1 excludes, arriving as a number instead of an absence, so it
 * is excluded and counted on the same rule. Measured 2026-09-09: 1 of 89
 * otherwise-included pools, holding $1,196.
 */
export function includePool(pool: PactPool, value: PoolValue, basis: ToFactsOpts['basis']): boolean {
  if (value.deprecated) return false;                                   // §3.6.3
  if (!isPriced(pool.primary_asset) || !isPriced(pool.secondary_asset)) return false; // §3.6.1
  if (value.tvl < MIN_TVL_USD) return false;                            // §3.6.2
  if (basis === 'verified_only' && !value.verified) return false;       // §3.6.5
  return true;                                                          // §3.6.4
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

export const pactConnector: Connector = {
  capabilities: () => ({
    id: PROTOCOL_ID,
    name: 'Pact',
    class: 'dex',
    kpis: DECLARED_KPIS,
    declined: DECLINED_KPIS,
    sourceHosts: ['api.pact.fi'],
    // No `appIds`: §4.1's KPI is declined, and declaring app ids for a KPI we
    // do not compute would be an over-claim `/catalog` publishes.
    supportsBasis: ['all_pools_usd_priced', 'verified_only'],
  }),

  /**
   * I/O only. One walk, whatever was asked for: Pact returns TVL, volume and
   * fees on the same record, so there is no equivalent of Tinyman's expensive
   * flow fetch to skip and `opts.kpis` buys a TVL-only refresh nothing. The
   * whole catalogue is 8 pages and ~4 seconds.
   */
  async fetchRaw(ctx: ConnectorContext, _opts: FetchOpts): Promise<RawSnapshot> {
    const walk = await fetchPools(ctx);

    const entities: PactPoolEntity[] = walk.pools.map((pool) => ({ kind: 'pool', pool }));

    return {
      entities,
      fetchedAt: ctx.now().toISOString(),
      sources: walk.sources,
      partial: walk.partial,
      excludedCount: walk.excludedCount + walk.duplicates,
    };
  },

  // `priceAssets` is deliberately absent. §1.1: "omit it if none of your KPIs
  // are USD-denominated" — Pact's are USD-denominated but not USD-CONVERTED,
  // which is the distinction that matters. Declaring assets here would make the
  // pipeline resolve ~2,000 prices per refresh that nothing would ever read.

  toFacts(snapshot: RawSnapshot, opts: ToFactsOpts): KpiFact[] {
    const entities = (snapshot.entities as readonly unknown[]).filter(isPoolEntity);

    const values: PoolValue[] = [];
    let filteredOut = 0;
    let deprecatedOut = 0;
    let unpricedOut = 0;
    let dustOut = 0;
    for (const entity of entities) {
      const value = valuePool(entity.pool);
      if (value === null) {
        filteredOut++;
        continue;
      }
      if (!includePool(entity.pool, value, opts.basis)) {
        filteredOut++;
        if (value.deprecated) deprecatedOut++;
        else if (!isPriced(entity.pool.primary_asset) || !isPriced(entity.pool.secondary_asset)) {
          unpricedOut++;
        } else if (value.tvl < MIN_TVL_USD) dustOut++;
        continue;
      }
      values.push(value);
    }

    // ---- §3.4 normalization ----------------------------------------------
    let tvl = 0;
    let volume = 0;
    let grossFees7d = 0;
    let verifiedCount = 0;
    /** Σ (pool TVL x Pact's own apr_7d), for the TVL-weighted cross-check. */
    let weightedApr7d = 0;

    for (const value of values) {
      tvl += value.tvl;
      // Already USD. §3.4's `x price_usd(primary_asset)` is NOT applied — see
      // the file header, correction 1, and README §"What §3.4 got wrong".
      volume += value.volume;
      grossFees7d += value.fees7d;
      if (value.verified) verifiedCount++;
      weightedApr7d += value.tvl * value.apr7d;
    }

    // §Step 5.3 / §3.1 — computed and asserted here, published only in part.
    // `splitFees` runs `assertCashFlowIdentity` internally: a misclassified
    // flow is a bug whether or not the legs it corrupts reach a response.
    const { gross: grossFees, unknownShare } = splitFees(values);

    // ---- Coverage and penalties (§3.6, §5) --------------------------------
    const excluded = snapshot.excludedCount + filteredOut;
    const coverage = { entities: values.length, excluded, basis: opts.basis } as const;

    const denominator = values.length + excluded;
    const penalties: PenaltyKind[] = [];
    if (denominator > 0 && excluded / denominator > MAX_EXCLUSION_RATIO) {
      penalties.push('high_exclusion');
    }
    if (snapshot.excludedCount > 0) penalties.push('validation_skip');

    const base = {
      protocol: PROTOCOL_ID,
      timestamp: opts.now,
      as_of: snapshot.fetchedAt,
      // A copy: RawSnapshot.sources is readonly, and a fact must not alias it.
      source: [...snapshot.sources],
      methodology_version: opts.methodologyVersion,
      cache: 'miss' as const,
      stale: false,
      coverage,
    };

    // ---- Shared notes -----------------------------------------------------
    const coverageNote =
      `${values.length} of ${entities.length} enumerated pools included: ` +
      `${deprecatedOut} excluded as deprecated (§3.6.3), ${dustOut} below the ` +
      `$${MIN_TVL_USD.toLocaleString('en-US')} floor (§3.6.2), ${unpricedOut} with a side the ` +
      `source itself prices at 0 (§3.6.1). ${verifiedCount} of the included pools are ` +
      `verified, ${values.length - verifiedCount} are not (§3.6.4: unverified pools are ` +
      `included, and the split is reported rather than curated away).`;

    const deprecatedNote =
      deprecatedOut > 0
        ? `§3.6.3 excludes Pact's deprecated (\`version: 100\`) pools. Note that these are ` +
          `not dormant: on the verification run one of them was the single highest-volume ` +
          `pool on the venue. Excluding them is the methodology's call, applied here without ` +
          `exception, and it is the largest single reason our TVL sits below DefiLlama's.`
        : '';

    const partialNote = snapshot.partial
      ? [
          'Snapshot is partial: at least one upstream page could not be fetched or reconciled against the catalogue count, so this aggregate covers less than the full protocol.',
        ]
      : [];

    // ---- The split (§3.1, §3.4): computed, checked, and NOT published -----
    //
    // `protocolRevenue` and `supplySide` above are real numbers and the §3.1
    // identity over them is asserted, because the identity is a property of the
    // arithmetic and a violation would mean a misclassified flow whether or not
    // anyone sees the result. But neither is emitted as a fact, and neither is
    // `take_rate` or `fee_apr`: with `pact_fee_bps` null on every pool they
    // encode a fee split Pact does not disclose, and DECLINED_KPIS above gives
    // the argument in full. `/metric` answers all four with 404
    // KPI_NOT_APPLICABLE naming the reason; `/catalog` never advertises them.
    //
    // The reason travels with the numbers we DO publish, because a buyer
    // holding `gross_fees_24h` will ask where the other two legs went.
    const declinedNote =
      unknownShare > 0
        ? `The §3.1 split of these fees is NOT published for Pact. \`pact_fee_bps\` — the ` +
          `protocol's own cut — is absent on the pools carrying ${(unknownShare * 100).toFixed(1)}% of gross fees, ` +
          `so protocol_revenue_24h, supply_side_revenue_24h, take_rate and fee_apr are declined ` +
          `(404 KPI_NOT_APPLICABLE) rather than published as $0.00 / 0.000000. A zero there would ` +
          `read as "Pact captures no revenue"; the fact is that Pact does not disclose its cut ` +
          `(§1.5, §3.4). gross_fees_24h itself is unaffected — it is what swappers paid, which ` +
          `Pact reports directly and which needs no split.`
        : `\`pact_fee_bps\` is published on every included pool, so the §3.1 split is measurable ` +
          `on this snapshot. It is still not emitted: the connector declines those KPIs ` +
          `unconditionally (see DECLINED_KPIS) rather than appearing and disappearing with the ` +
          `upstream's disclosure, which would make a missing take_rate ambiguous.`;

    const volumeNote =
      'volume_24h is reported in USD by the source; no §3.7 conversion is applied. ' +
      'DATA_SCHEMA.md §3.4 states this field is denominated in the primary asset and must be ' +
      'multiplied by its price; that was tested against the live API on 2026-09-09 and is not ' +
      'true. See src/connectors/pact/README.md §"What §3.4 got wrong".';

    const facts: KpiFact[] = [];
    // Appended here rather than at eleven call sites: the partial-snapshot
    // caveat applies to every number in the response, and a note that has to be
    // remembered ten times is a note that will be missing from the eleventh.
    const push = (fact: KpiFact): void => {
      facts.push({ ...fact, notes: [...(fact.notes ?? []), ...partialNote] });
    };

    const reported = (metric: KpiId): number =>
      computeConfidence({ derivation: { kind: 'reported' }, penalties, metric });

    // ---- TVL (§3.4) --------------------------------------------------------
    const tvlFact: KpiFact = {
      ...base,
      metric: 'tvl',
      value: tvl,
      unit: 'USD',
      confidence: reported('tvl'),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'Σ tvl_usd over the pools passing §3.6. Pact computes and publishes this figure in USD, so it is the §5 `reported` row — no §3.7 price conversion is involved, unlike Tinyman V2 TVL.',
        coverageNote,
        ...(deprecatedNote === '' ? [] : [deprecatedNote]),
      ],
    };
    push(tvlFact);

    const volumeFact: KpiFact = {
      ...base,
      metric: 'volume_24h',
      value: volume,
      unit: 'USD',
      confidence: reported('volume_24h'),
      is_estimated: false,
      estimation_method: null,
      notes: [volumeNote, coverageNote],
    };
    push(volumeFact);

    const grossFeesFact: KpiFact = {
      ...base,
      metric: 'gross_fees_24h',
      value: grossFees,
      unit: 'USD',
      confidence: reported('gross_fees_24h'),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'fee_usd_24h is the TOTAL fee charged to swappers (LP + protocol) and is never reported as protocol_revenue (§3.4).',
        // Whether today is a typical day is a question a buyer will ask of any
        // 24h figure, and the source already answers it for free.
        `Trailing-7d context: Σ fee_usd_7d over the same pools is $${grossFees7d.toFixed(2)}, a daily mean of $${(grossFees7d / 7).toFixed(2)} against this window's $${grossFees.toFixed(2)}. A signal about how representative the day is, never a value.`,
        declinedNote,
        coverageNote,
      ],
    };
    push(grossFeesFact);

    // ---- Ratios. §5: a composite takes the MINIMUM of its inputs ----------
    const ratio = (
      metric: KpiId,
      value: number,
      inputs: readonly KpiFact[],
      notes: string[],
    ): KpiFact => ({
      ...base,
      metric,
      value,
      unit: 'RATIO',
      confidence: combineConfidence([
        {
          confidence: computeConfidence({ derivation: { kind: 'arithmetic' }, penalties, metric }),
        },
        ...inputs,
      ]),
      is_estimated: inputs.some((f) => f.is_estimated === true),
      estimation_method: inputs.find((f) => f.is_estimated === true)?.estimation_method ?? null,
      notes,
    });

    if (tvl > 0) {
      // Pact reports TVL, volume and fees on the same record for every pool, so
      // — unlike Tinyman — numerator and denominator here describe exactly the
      // same set of pools and no flow-covered subset is needed.
      const sameSetNote =
        'Numerator and denominator describe the same pools: Pact publishes TVL and the 24h flows on one record, so there is no flow-coverage gap to correct for (contrast §3.3).';

      push(
        ratio('capital_efficiency', (grossFees * 365) / tvl, [grossFeesFact, tvlFact], [
          'Annualized gross fees per dollar of pooled capital. Comparable across protocol classes by construction (§4).',
          declinedNote,
          // The cross-check that used to sit on `fee_apr`. It is a magnitude
          // check, not an equality: Pact's figure is an LP yield over 7 days,
          // ours is a gross-fee yield over 24 hours, and the gap between them
          // is exactly the undisclosed protocol cut plus the window. Stated
          // that way rather than presented as agreement.
          `Cross-check on magnitude: Pact publishes a 7-day fee APR per pool, whose TVL-weighted mean over the included pools is ${((tvl > 0 ? weightedApr7d / tvl : 0) * 100).toFixed(2)}%, against our trailing-24h gross ${(((grossFees * 365) / tvl) * 100).toFixed(2)}%. The two are not the same quantity — Pact's is net of its own cut and covers 7 days — so they are compared for order of magnitude only, never reconciled.`,
          `§3.1 exclusion, stated as a commitment rather than as a description of this run: Pact's \`apr_governance\` is Algorand governance ALGO, an external subsidy and not protocol revenue, so it is excluded from every fee figure here. It was 0.000000 on every pool in the live catalogue, so the exclusion costs nothing today.`,
          sameSetNote,
        ]),
      );

      push(
        ratio('volume_to_tvl', volume / tvl, [volumeFact, tvlFact], [
          'Turnover: USD swapped per dollar of pooled capital, trailing 24h.',
          volumeNote,
          sameSetNote,
        ]),
      );
    }

    // ---- Counts -----------------------------------------------------------
    push({
      ...base,
      metric: 'pool_count',
      value: values.length,
      unit: 'COUNT',
      confidence: computeConfidence({
        derivation: { kind: 'arithmetic' },
        penalties,
        metric: 'pool_count',
      }),
      is_estimated: false,
      estimation_method: null,
      notes: [coverageNote, ...(deprecatedNote === '' ? [] : [deprecatedNote])],
    });

    return facts;
  },

  async healthCheck(ctx: ConnectorContext): Promise<HealthProbe> {
    // One page of one pool: cheap, and it exercises the exact host and path
    // shape the real walk depends on (§1, "must not be the full fetchRaw").
    const res = await ctx.http.getJson(poolPageUrl(0, 1)).catch(() => null);
    return res === null ? { ok: false, detail: `${PACT_BASE}/pools unreachable` } : { ok: true };
  },
};
