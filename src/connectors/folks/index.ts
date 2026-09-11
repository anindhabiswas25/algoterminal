import { combineConfidence, computeConfidence } from '../../standardize/confidence.js';
import type { PenaltyKind } from '../../standardize/confidence.js';
import type { KpiFact, KpiId } from '../../standardize/schema.js';
import { MAX_EXCLUSION_RATIO, RETENTION_DIVERGENCE_THRESHOLD } from '../../standardize/types.js';
import { priceOf } from '../types.js';
import type {
  Connector,
  ConnectorContext,
  FetchOpts,
  HealthProbe,
  RawSnapshot,
  ToFactsOpts,
} from '../types.js';
import { DAYS_PER_YEAR, FOLKS_SDK_VERSION, FOLKS_MARKETS } from './constants.js';
import {
  HEALTH_PROBE_APP_ID,
  activeUserAppIds,
  fetchMarkets,
  scanActiveUsers,
  type ActiveUsersScan,
} from './enumerate.js';
import { isMarketEntity, isUnreadableEntity, scaleMarket, type ScaledMarket } from './schema.js';

/**
 * DATA_SCHEMA.md §3.5 — the Folks Finance connector (`lending`).
 *
 * ## Who pays whom
 *
 * A borrower pays interest on their outstanding debt, continuously, at a rate
 * the market sets from its own utilisation. That interest is the entire
 * revenue event: it is `gross_fees_24h`. Most of it is credited to the
 * depositors who supplied the capital being borrowed — that is
 * `supply_side_revenue_24h` — and Folks keeps the remainder, a per-market
 * `retentionRate` of 10% to 30%, which is `protocol_revenue_24h`.
 *
 * **Borrower interest is the DEX swap fee of a lending protocol** (§3.2). Both
 * are the price a user pays for the protocol's core service, and both split
 * between the parties supplying capital and the protocol itself. That single
 * mapping is what makes `take_rate` and `capital_efficiency` comparable
 * between this connector and Tinyman's, and it is the reason this connector
 * exists: it is the one that is not a DEX.
 *
 * **Deposit interest is not a second fee.** It is `supply_side_revenue` — the
 * same dollars seen from the receiving end. Counting deposit interest as
 * revenue alongside borrow interest would double-count the entire flow, and is
 * the single most common error in ad-hoc DeFi comparisons (§3.2).
 *
 * ## Source: on chain, because the API is closed
 *
 * `https://api.folks.finance/*` answers anonymous callers with
 * `{"message":"Forbidden"}`. Re-verified 2026-09-09 across `/v2/pools`,
 * `/v1/pools`, `/pools` and `/health`, with and without a browser User-Agent:
 * all four still `403`. So every number here is read from lending-market
 * application global state through `ctx.algod`, with the market list, the
 * fixed-point scales and the rate formulae taken from
 * `@folks-finance/algorand-sdk@${FOLKS_SDK_VERSION}` (pinned exactly).
 *
 * ## The fixed-point warning, and what it actually caught
 *
 * §3.5 warns that a wrong decimal scale here "produces numbers that are
 * entirely plausible and entirely wrong". No scale in this connector is
 * assumed: `constants.ts` sources each one from the SDK's own JSDoc, and a
 * fixture test asserts our derived `supply_apr` matches the SDK's
 * `retrievePoolInfo` output. Measured over all 25 live markets on 2026-09-09,
 * the largest disagreement was **0** for `supply_apr` and **9.6e-17** for the
 * blended borrow rate.
 *
 * What the §3.5 retention cross-check then caught was not a scale error but a
 * FORMULA error, in §3.5 itself. See {@link marketGrossFees}.
 */

const PROTOCOL_ID = 'folks';

/** §3.1 identity tolerance, the same figure Tinyman and Pact assert against. */
export const IDENTITY_TOLERANCE = 1e-6;

/**
 * Every §4 KPI applicable to class `lending`.
 *
 * `active_users_24h` is included, unlike on Pact, because Folks' application
 * ids genuinely are enumerable: the SDK pins 25 market applications and six
 * loan applications, and the §Step 2 verification confirmed the indexer
 * returns real user addresses for them with no application-account
 * contamination (README §"Active users"). §4.1 says to decline when the ids
 * cannot be enumerated; here they can, so declining would be under-claiming.
 */
const DECLARED_KPIS = [
  'tvl',
  'total_borrows',
  'utilization',
  'supply_apr',
  'borrow_apr',
  'gross_fees_24h',
  'supply_side_revenue_24h',
  'protocol_revenue_24h',
  'take_rate',
  'capital_efficiency',
  'active_users_24h',
  'pool_count',
] as const satisfies readonly KpiId[];

// ---------------------------------------------------------------------------
// Pure helpers — the §3.5 arithmetic
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

/** One market valued in USD, or null when it cannot be priced (§3.6.1). */
export interface MarketValue {
  readonly market: ScaledMarket;
  readonly priceUsd: number;
  readonly priceConfidence: number;
  readonly depositsUsd: number;
  readonly borrowsUsd: number;
}

/**
 * `gross_fees_24h` for one market: what its borrowers paid in the last 24h.
 *
 * ## The §3.5 correction — the blended rate, not the variable one
 *
 * §3.5 states the formula as
 * `Σ (borrows_usd × variableBorrowInterestRate) / 365`. Folks markets carry
 * BOTH variable and stable debt, and stable borrowers pay the rate fixed when
 * they borrowed, not the current variable rate. Measured live 2026-09-09,
 * stable debt is **1.8% of ALGO's debt, 21.6% of USDC's, and 54.3% of
 * ISOLATED_TINY's** — so the variable-only formula is not a rounding matter.
 *
 * It is also detectably wrong, by §3.5's own instrument. Computing gross fees
 * from the variable side alone while computing supply-side revenue from
 * `depositInterestRate` — which Folks derives from the BLENDED rate — breaks
 * the retention cross-check. Measured live 2026-09-09 over all 25 markets:
 *
 * | | §3.5 as written | this connector |
 * |---|---|---|
 * | `gross_fees_24h` | $1,742.54 | **$1,989.14** |
 * | `protocol_revenue_24h` | $36.93 | **$283.54** |
 * | retention divergence | **12.13%** — fires the 5% threshold | **0.000000%** |
 * | markets with NEGATIVE protocol revenue | 7 of 24 | 0 |
 * | markets failing the 5% check individually | 8 of 24 | 0 |
 * | `total_borrows` vs DefiLlama | understated 7.7% | **+0.36%** |
 *
 * Two things there are worth separating. The 12.13% aggregate divergence is
 * the *detector* doing its job. The per-market negatives are the *incoherence*:
 * supply-side revenue exceeding gross fees means depositors are paid more than
 * borrowers paid, which is not a small error but an impossible one.
 *
 * So this connector multiplies by the debt-weighted rate across both debt
 * types: the SDK's `calcOverallBorrowInterestRate`, reproduced in
 * `scaleMarket` and pinned against the SDK by test. §3.5 has been corrected to
 * match, with a `methodology_version` bump — see `README.md`.
 *
 * This is exactly what §3.5 predicted the retention check would be good for.
 * It said "if it fires, suspect your decimal scale before suspecting Folks";
 * the scale was verified independently against the SDK first, which is what
 * left the formula as the only remaining candidate.
 */
export function marketGrossFees(value: MarketValue): number {
  return (value.borrowsUsd * value.market.overallBorrowRate) / DAYS_PER_YEAR;
}

/** One market's supply-side revenue: interest credited to its depositors. */
export function marketSupplySideRevenue(value: MarketValue): number {
  return (value.depositsUsd * value.market.depositRate) / DAYS_PER_YEAR;
}

/** The §3.5 aggregate, computed once and shared by every fact. */
export interface FolksAggregate {
  readonly values: readonly MarketValue[];
  readonly tvlUsd: number;
  readonly borrowsUsd: number;
  readonly utilization: number;
  readonly grossFees: number;
  readonly supplySide: number;
  readonly protocolRevenue: number;
  readonly supplyApr: number;
  readonly borrowApr: number;
  /** Gross-fee-weighted mean `retentionRate`, for the §3.5 cross-check. */
  readonly retentionWeighted: number;
  /** `gross × retentionWeighted` — what the residual should be. */
  readonly expectedProtocolRevenue: number;
  /** `|residual − expected| / gross`. Zero when gross is zero. */
  readonly retentionDivergence: number;
  /** TVL-weighted mean price confidence (§5). */
  readonly tvlPriceConfidence: number;
  /** Borrow-weighted mean price confidence. */
  readonly borrowPriceConfidence: number;
}

/**
 * Aggregate the §3.5 formulas over the priced markets.
 *
 * Exported and pure so the §3.1 identity and the retention cross-check can be
 * tested directly on any fixture, rather than only through the emitted facts.
 */
export function aggregate(values: readonly MarketValue[]): FolksAggregate {
  let tvlUsd = 0;
  let borrowsUsd = 0;
  let grossFees = 0;
  let supplySide = 0;
  let weightedRetention = 0;
  let weightedSupplyRate = 0;
  let weightedBorrowRate = 0;
  let tvlWeightedPrice = 0;
  let borrowWeightedPrice = 0;

  for (const value of values) {
    const gross = marketGrossFees(value);
    tvlUsd += value.depositsUsd;
    borrowsUsd += value.borrowsUsd;
    grossFees += gross;
    supplySide += marketSupplySideRevenue(value);
    // Gross-fee weighted: the cross-check compares against total gross fees,
    // so the retention rate that predicts it must be weighted the same way.
    weightedRetention += gross * value.market.retentionRate;
    // §4: supply_apr is "deposit-weighted", borrow_apr "borrow-weighted".
    weightedSupplyRate += value.depositsUsd * value.market.depositRate;
    weightedBorrowRate += value.borrowsUsd * value.market.overallBorrowRate;
    tvlWeightedPrice += value.depositsUsd * value.priceConfidence;
    borrowWeightedPrice += value.borrowsUsd * value.priceConfidence;
  }

  // §3.5: protocol revenue is the RESIDUAL. §3.1 is an identity, so the
  // residual is authoritative; the retention rate is a cross-check on it.
  const protocolRevenue = grossFees - supplySide;
  assertCashFlowIdentity(grossFees, supplySide, protocolRevenue);

  const retentionWeighted = grossFees > 0 ? weightedRetention / grossFees : 0;
  const expectedProtocolRevenue = grossFees * retentionWeighted;
  const retentionDivergence =
    grossFees > 0 ? Math.abs(protocolRevenue - expectedProtocolRevenue) / grossFees : 0;

  return {
    values,
    tvlUsd,
    borrowsUsd,
    // §3.5: a ratio of SUMS, protocol-wide, so it is deposit-weighted by
    // construction. A mean of per-market ratios would let a dust market at 99%
    // utilisation dominate a protocol that is mostly idle.
    utilization: tvlUsd > 0 ? borrowsUsd / tvlUsd : 0,
    grossFees,
    supplySide,
    protocolRevenue,
    supplyApr: tvlUsd > 0 ? weightedSupplyRate / tvlUsd : 0,
    borrowApr: borrowsUsd > 0 ? weightedBorrowRate / borrowsUsd : 0,
    retentionWeighted,
    expectedProtocolRevenue,
    retentionDivergence,
    // §5: "a sum built from many prices takes the TVL-weighted mean of their
    // price confidences" — the weighted mean grades the dollars, which is what
    // the number is.
    tvlPriceConfidence: tvlUsd > 0 ? tvlWeightedPrice / tvlUsd : 0,
    borrowPriceConfidence: borrowsUsd > 0 ? borrowWeightedPrice / borrowsUsd : 0,
  };
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

export const folksConnector: Connector = {
  capabilities: () => ({
    id: PROTOCOL_ID,
    name: 'Folks Finance',
    class: 'lending',
    kpis: DECLARED_KPIS,
    // §4.1 obliges anyone declaring active_users_24h to list the app ids it is
    // computed from. These are the ids, not a subset: 25 markets, six loans,
    // and the deposits application.
    appIds: activeUserAppIds(),
    sourceHosts: [`algod:${'mainnet-api.4160.nodely.dev'}`, 'mainnet-idx.4160.nodely.dev'],
    // Only the §3.6 default. `verified_only` is a DEX curation flag; Folks
    // publishes a curated market list and has no verification bit, so
    // declaring the basis would advertise a filter that does nothing.
    supportsBasis: ['all_pools_usd_priced'],
  }),

  async fetchRaw(ctx: ConnectorContext, opts: FetchOpts): Promise<RawSnapshot> {
    const walk = await fetchMarkets(ctx);
    const sources = [...walk.sources];
    const entities: unknown[] = [...walk.entities];

    // The indexer scan costs ~65 requests and ~20s, so it runs only when the
    // caller actually wants the KPI. This is what keeps the fast (TTL <= 300s)
    // refresh cycle — tvl, total_borrows, utilization, the two rate models —
    // down to the 25 global-state reads it genuinely needs.
    if (opts.kpis.includes('active_users_24h')) {
      const scan = await scanActiveUsers(ctx, sources);
      if (scan !== null) entities.push({ kind: 'active_users', scan });
    }

    return {
      entities,
      fetchedAt: ctx.now().toISOString(),
      sources,
      partial: walk.partial,
      excludedCount: walk.unreadable,
    };
  },

  /**
   * Every market's asset needs a USD price: the chain reports deposits and debt
   * in asset units, and every dollar KPI here is a conversion (§4.3).
   */
  priceAssets(snapshot: RawSnapshot): readonly number[] {
    const ids = new Set<number>();
    for (const entity of snapshot.entities) {
      if (isMarketEntity(entity)) ids.add(entity.state.assetId);
    }
    return [...ids];
  },

  toFacts(snapshot: RawSnapshot, opts: ToFactsOpts): KpiFact[] {
    const entities = snapshot.entities as readonly unknown[];
    const markets = entities.filter(isMarketEntity).map((e) => scaleMarket(e.state));
    const unreadable = entities.filter(isUnreadableEntity);
    const scan = entities.find(
      (e): e is { kind: 'active_users'; scan: ActiveUsersScan } =>
        typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'active_users',
    );

    // ---- §3.6.1: a market we cannot price is EXCLUDED and counted ----------
    // Never contributed as a zero. A market holding $4M of an asset our ladder
    // cannot price is not a market holding nothing, and the difference is the
    // whole of §1.5.
    const values: MarketValue[] = [];
    const unpriced: ScaledMarket[] = [];
    for (const market of markets) {
      const price = priceOf(opts.prices, market.assetId);
      if (price === null || !(price.usd > 0)) {
        unpriced.push(market);
        continue;
      }
      values.push({
        market,
        priceUsd: price.usd,
        priceConfidence: price.confidence,
        depositsUsd: market.deposits * price.usd,
        borrowsUsd: market.borrows * price.usd,
      });
    }

    const agg = aggregate(values);

    // ---- Coverage and penalties (§5) --------------------------------------
    const excluded = unreadable.length + unpriced.length;
    const coverage = {
      entities: values.length,
      excluded,
      // §3.5: lending TVL means total value SUPPLIED — not deposits minus
      // borrows ("available liquidity"), not deposits plus borrows. Recorded
      // here so the definition travels with every fact rather than living only
      // in the methodology document.
      basis: 'total_deposits' as const,
    };

    const denominator = values.length + excluded;
    const penalties: PenaltyKind[] = [];
    if (denominator > 0 && excluded / denominator > MAX_EXCLUSION_RATIO) {
      penalties.push('high_exclusion');
    }
    if (unreadable.length > 0) penalties.push('validation_skip');

    /** §3.5's additive penalty, applied only to the facts it grades. */
    const retentionFired = agg.retentionDivergence > RETENTION_DIVERGENCE_THRESHOLD;
    const splitPenalties: PenaltyKind[] = retentionFired
      ? [...penalties, 'folks_retention_divergence']
      : penalties;

    const base = {
      protocol: PROTOCOL_ID,
      timestamp: opts.now,
      as_of: snapshot.fetchedAt,
      source: [...snapshot.sources],
      methodology_version: opts.methodologyVersion,
      cache: 'miss' as const,
      stale: false,
      coverage,
    };

    // ---- Shared notes -----------------------------------------------------
    const deprecatedCount = values.filter((v) => v.market.deprecated).length;
    const coverageNote =
      `${values.length} of ${markets.length + unreadable.length} Folks lending markets included. ` +
      `${unpriced.length} excluded because the §3.7 ladder could not price the market's asset ` +
      `(excluded and counted, never contributed as a zero — §3.6.1); ` +
      `${unreadable.length} excluded because their application state could not be read or decoded. ` +
      `${deprecatedCount} of the included markets are flagged deprecated on chain and are counted ` +
      `anyway: they hold real deposits, and dropping them would understate a protocol that has ` +
      `not finished winding them down. The market list is pinned to ` +
      `@folks-finance/algorand-sdk@${FOLKS_SDK_VERSION}.`;

    const sourceNote =
      'Read from lending-market application global state via algod. The Folks REST API ' +
      '(api.folks.finance) returns {"message":"Forbidden"} to anonymous callers — re-verified ' +
      '2026-09-09 on /v2/pools, /v1/pools, /pools and /health, with and without a browser ' +
      'User-Agent — so it is not a source for any number here. Every fixed-point scale comes ' +
      `from @folks-finance/algorand-sdk@${FOLKS_SDK_VERSION}; none is assumed (§3.5).`;

    const partialNote = snapshot.partial
      ? [
          `Snapshot is partial: ${unreadable.length} market(s) could not be read, so this aggregate covers less than the whole protocol.`,
        ]
      : [];

    const facts: KpiFact[] = [];
    const push = (fact: KpiFact): void => {
      facts.push({ ...fact, notes: [...(fact.notes ?? []), ...partialNote] });
    };

    // ---- TVL (§3.5) --------------------------------------------------------
    const tvlFact: KpiFact = {
      ...base,
      metric: 'tvl',
      value: agg.tvlUsd,
      unit: 'USD',
      // §5: reserves are not dollars. Reading them on chain is the 0.95 row,
      // but the fact is denominated in USD, and converting is exactly what the
      // usd_conversion row grades — the same reasoning that lowered Tinyman's
      // TVL confidence in 1.1.0.
      confidence: computeConfidence({
        derivation: { kind: 'usd_conversion', priceConfidence: agg.tvlPriceConfidence },
        penalties,
        metric: 'tvl',
      }),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'Σ total deposits × the §3.7 USD price, over every market we can price. Lending TVL is defined as TOTAL DEPOSITS — the capital the protocol has attracted — not deposits minus borrows ("available liquidity"), and not deposits plus borrows (§3.5). A consumer wanting available liquidity can compute tvl × (1 − utilization) from two KPIs published here.',
        sourceNote,
        coverageNote,
      ],
    };
    push(tvlFact);

    const borrowsFact: KpiFact = {
      ...base,
      metric: 'total_borrows',
      value: agg.borrowsUsd,
      unit: 'USD',
      confidence: computeConfidence({
        derivation: { kind: 'usd_conversion', priceConfidence: agg.borrowPriceConfidence },
        penalties,
        metric: 'total_borrows',
      }),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'Σ outstanding debt × the §3.7 USD price. Variable AND stable debt: Folks markets carry both, and stable debt is a material share of several of them (54.3% of ISOLATED_TINY on 2026-09-09), so counting only the variable side would understate what borrowers owe.',
        sourceNote,
        coverageNote,
      ],
    };
    push(borrowsFact);

    // ---- Rate models (§4) --------------------------------------------------
    // Read directly from chain state, so the §5 `onchain` row. The USD weights
    // decide how the per-market rates are averaged, but the value itself is a
    // rate bounded by the markets' own rates, not a converted dollar figure —
    // grading it as a USD conversion would misstate what could go wrong with
    // it.
    const rateNote =
      'Read from market application global state and descaled by the SDK constant documented for ' +
      `that field (16 dp for every rate). Verified against @folks-finance/algorand-sdk@${FOLKS_SDK_VERSION}'s own ` +
      'retrievePoolInfo across all live markets: largest disagreement 0 for supply_apr and 9.6e-17 for the blended borrow rate (§3.5).';

    push({
      ...base,
      metric: 'supply_apr',
      value: agg.supplyApr,
      unit: 'RATIO',
      confidence: computeConfidence({
        derivation: { kind: 'onchain' },
        penalties,
        metric: 'supply_apr',
      }),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'Deposit-weighted mean depositInterestRate, weighted by each market\'s deposits in USD. A dimensionless fraction: 0.0369 means 3.69% (§2.1).',
        rateNote,
        coverageNote,
      ],
    });

    push({
      ...base,
      metric: 'borrow_apr',
      value: agg.borrowApr,
      unit: 'RATIO',
      confidence: computeConfidence({
        derivation: { kind: 'onchain' },
        penalties,
        metric: 'borrow_apr',
      }),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'Borrow-weighted mean of each market\'s BLENDED borrow rate — the debt-weighted rate across variable and stable debt (the SDK\'s calcOverallBorrowInterestRate), not the variable rate alone. See gross_fees_24h.',
        rateNote,
        coverageNote,
      ],
    });

    push({
      ...base,
      metric: 'utilization',
      value: agg.utilization,
      unit: 'RATIO',
      confidence: combineConfidence([
        {
          confidence: computeConfidence({
            derivation: { kind: 'arithmetic' },
            penalties,
            metric: 'utilization',
          }),
        },
        tvlFact,
        borrowsFact,
      ]),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'Σ borrows_usd / Σ deposits_usd, protocol-wide. A ratio of SUMS, so it is deposit-weighted by construction; an unweighted mean across markets would let a dust market at 99% utilisation dominate (§3.5).',
        coverageNote,
      ],
    });

    // ---- The §3.1 flows ----------------------------------------------------
    // §3.5: the /365 is a simple-interest daily slice of an annualized
    // instantaneous rate, so every flow KPI is estimated and capped at the §5
    // documented_estimation row (0.85).
    const estimationMethod = 'annualized_rate_to_daily_simple';
    const flowNote =
      'The /365 is a simple-interest daily slice of an ANNUALIZED, INSTANTANEOUS rate. It answers ' +
      '"what did borrowers pay in the last 24h at the current rate" — the same trailing-24h question ' +
      'the DEX connectors answer — but it is not compounded and it is a rate snapshot rather than an ' +
      'integral over the day. If rates moved materially during the day, this reflects the current ' +
      'rate, not the average one (§3.5). The exact method — diffing the deposit and borrow interest ' +
      'INDICES between two snapshots 24h apart — is post-MVP: the snapshotter is already storing the ' +
      'indices this connector reads, and it becomes available once there is 24h of history.';

    /**
     * §5's minimum rule: these are estimated (0.85) AND USD-converted
     * (0.90 × price confidence). A flow can be no better than either leg, so
     * the confidence is the smaller — taking only the estimation row would
     * hide a bad price, and taking only the price row would hide the /365.
     */
    const flowConfidence = (metric: KpiId, extra: readonly PenaltyKind[]): number =>
      combineConfidence([
        {
          confidence: computeConfidence({
            derivation: { kind: 'documented_estimation' },
            penalties: extra,
            metric,
          }),
        },
        {
          confidence: computeConfidence({
            derivation: { kind: 'usd_conversion', priceConfidence: agg.borrowPriceConfidence },
            penalties: extra,
            metric,
          }),
        },
      ]);

    const grossFeesFact: KpiFact = {
      ...base,
      metric: 'gross_fees_24h',
      value: agg.grossFees,
      unit: 'USD',
      confidence: flowConfidence('gross_fees_24h', penalties),
      is_estimated: true,
      estimation_method: estimationMethod,
      notes: [
        'Σ (borrows_usd × the market\'s blended borrow rate) / 365 — what BORROWERS paid for the protocol\'s core service in the last 24h. This is the lending analogue of a DEX swap fee (§3.2): both are the price a user pays to use the protocol, which is what makes take_rate and capital_efficiency comparable across the two classes.',
        'Driven by BORROWS, not deposits. Borrowers pay; depositors receive. Using deposits here would inflate fees by 1/utilization and is the classic error (§3.5). Deposit interest is not a second fee source — it is the same dollars viewed from the receiving end, and is reported as supply_side_revenue_24h.',
        'The rate is the DEBT-WEIGHTED blend of variable and stable borrow rates, not the variable rate alone. DATA_SCHEMA.md §3.5 specified the variable rate; that was corrected after the §3.5 retention cross-check fired on every market with stable debt and produced negative protocol revenue on three of four. See src/connectors/folks/README.md.',
        flowNote,
        sourceNote,
        coverageNote,
      ],
    };
    push(grossFeesFact);

    const supplySideFact: KpiFact = {
      ...base,
      metric: 'supply_side_revenue_24h',
      value: agg.supplySide,
      unit: 'USD',
      confidence: flowConfidence('supply_side_revenue_24h', penalties),
      is_estimated: true,
      estimation_method: estimationMethod,
      notes: [
        'Σ (deposits_usd × depositInterestRate) / 365 — interest credited to DEPOSITORS. Computed from deposits and the deposit rate, independently of gross_fees_24h, which is what makes the §3.1 identity a real check here rather than a restatement.',
        flowNote,
        sourceNote,
        coverageNote,
      ],
    };
    push(supplySideFact);

    // §3.5: protocol revenue is the RESIDUAL, validated against retentionRate.
    const retentionNote = retentionFired
      ? `RETENTION CROSS-CHECK FIRED. The §3.1 residual is $${agg.protocolRevenue.toFixed(2)}, while the ` +
        `gross-fee-weighted retentionRate of ${(agg.retentionWeighted * 100).toFixed(2)}% predicts ` +
        `$${agg.expectedProtocolRevenue.toFixed(2)} — a divergence of ` +
        `${(agg.retentionDivergence * 100).toFixed(2)}% of gross fees, above the 5% threshold. The RESIDUAL is ` +
        `kept, because §3.1 is an identity and the retention rate is only a cross-check on it, and ` +
        `confidence is reduced by 0.10 (§5). §3.5 notes that a divergence here is most likely a ` +
        `fixed-point scaling error in this connector rather than a fact about Folks.`
      : `Retention cross-check PASSED: the §3.1 residual is $${agg.protocolRevenue.toFixed(2)} against ` +
        `$${agg.expectedProtocolRevenue.toFixed(2)} predicted by the gross-fee-weighted retentionRate of ` +
        `${(agg.retentionWeighted * 100).toFixed(2)}%, a divergence of ${(agg.retentionDivergence * 100).toFixed(4)}% of ` +
        `gross fees (threshold 5%). This is an independent confirmation of the fixed-point scaling: ` +
        `gross fees are built from borrows and the borrow rate, supply-side revenue from deposits and ` +
        `the deposit rate, and the retention rate is a third field. A wrong decimal scale on any of ` +
        `them would break this agreement.`;

    const protocolRevenueFact: KpiFact = {
      ...base,
      metric: 'protocol_revenue_24h',
      value: agg.protocolRevenue,
      unit: 'USD',
      confidence: combineConfidence([
        { confidence: flowConfidence('protocol_revenue_24h', splitPenalties) },
        grossFeesFact,
        supplySideFact,
      ]),
      is_estimated: true,
      estimation_method: estimationMethod,
      notes: [
        'gross_fees_24h − supply_side_revenue_24h: the portion of borrower interest Folks retains (its per-market retentionRate, 10%–30% on the live markets). This is the number comparable to a company\'s revenue (§3.1).',
        retentionNote,
        flowNote,
        coverageNote,
      ],
    };
    push(protocolRevenueFact);

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
          confidence: computeConfidence({
            derivation: { kind: 'arithmetic' },
            penalties: splitPenalties,
            metric,
          }),
        },
        ...inputs,
      ]),
      is_estimated: inputs.some((f) => f.is_estimated === true),
      estimation_method: inputs.find((f) => f.is_estimated === true)?.estimation_method ?? null,
      notes,
    });

    // §4's null-by-definition rule: below a dollar of fees the ratio is noise
    // over noise, so the KPI is OMITTED rather than emitted as a
    // plausible-looking number (§1.5).
    if (agg.grossFees >= 1) {
      push(
        ratio('take_rate', agg.protocolRevenue / agg.grossFees, [protocolRevenueFact, grossFeesFact], [
          'protocol_revenue_24h / gross_fees_24h — the protocol\'s cut of what borrowers paid. Dimensionless, and directly comparable to a DEX\'s cut of what swappers paid (§3.1).',
          retentionNote,
        ]),
      );
    }

    if (agg.tvlUsd > 0) {
      push(
        ratio('capital_efficiency', (agg.grossFees * DAYS_PER_YEAR) / agg.tvlUsd, [grossFeesFact, tvlFact], [
          'Annualized gross fees per dollar of capital supplied. The flagship cross-type ratio (§4): it answers "where is capital working hardest" and is only computable because §3.2 made gross_fees mean one thing for a DEX and for a lending market.',
          'The denominator is TVL as defined in §3.5 — total deposits — so this measures fees against all capital supplied, not against the borrowed portion. A lending market at 0.03 against a DEX at 0.08 is a directly meaningful comparison.',
          coverageNote,
        ]),
      );
    }

    // ---- Counts -----------------------------------------------------------
    if (scan !== undefined) {
      const observed =
        scan.scan.observedMinRound !== null && scan.scan.observedMaxRound !== null
          ? `${scan.scan.observedMinRound}-${scan.scan.observedMaxRound} (${scan.scan.observedMaxRound - scan.scan.observedMinRound} rounds)`
          : 'none (no transactions returned)';
      push({
        ...base,
        metric: 'active_users_24h',
        value: scan.scan.addresses,
        unit: 'COUNT',
        confidence: computeConfidence({
          derivation: { kind: 'indexer_address_aggregation' },
          penalties,
          metric: 'active_users_24h',
        }),
        is_estimated: true,
        estimation_method: `distinct transaction senders to Folks' ${scan.scan.appIds.length} core application ids (25 lending markets, six loan applications, and the deposits application) over rounds ${scan.scan.requestedMinRound}-${scan.scan.requestedMaxRound}; that window is a round count at a nominal block time rather than an exact 24h boundary, because neither algod status nor the §1.2 indexer client exposes a block timestamp`,
        notes: [
          'Counts ADDRESSES, not humans. One person with three wallets is three; a router batching for many users is one. No de-duplication is attempted, because any heuristic would be unfalsifiable (§4.1).',
          'Interactions routed through an aggregator are attributed to the aggregator, not to the end user (§4.1).',
          'The deposit-staking application is deliberately NOT scanned: staking an f-token for rewards is not a deposit, withdraw, borrow or repay, and §4.1 defines this count by the interaction rather than by the brand. Including it would widen the definition for one protocol and break the cross-protocol comparison the count exists for.',
          `Scanned ${scan.scan.transactions} application transactions; requested rounds ${scan.scan.requestedMinRound}-${scan.scan.requestedMaxRound}, and the returned transactions actually spanned ${observed}.`,
          'Confidence is capped at 0.80 for this KPI on every protocol: it is the least reliable metric published (§4.1).',
        ],
      });
    }

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
      notes: [
        'Lending markets (one per asset) included in the aggregates above, not liquidity pools. coverage.entities + coverage.excluded reconciles to the full pinned market list.',
        coverageNote,
      ],
    });

    return facts;
  },

  async healthCheck(ctx: ConnectorContext): Promise<HealthProbe> {
    // One global-state read of the pool-manager application: cheap, and it
    // exercises the exact algod path and decoding shape the real fetch depends
    // on (§1, "must not be the full fetchRaw").
    const res = await ctx.algod.getApplicationGlobalState(HEALTH_PROBE_APP_ID).catch(() => null);
    if (res === null || res.state === null) {
      return { ok: false, detail: `algod global state for app ${HEALTH_PROBE_APP_ID} unreachable` };
    }
    return { ok: true };
  },
};

/** Re-exported so tests and the live script can enumerate without the SDK. */
export { FOLKS_MARKETS };
