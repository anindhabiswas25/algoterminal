import { computeConfidence, combineConfidence } from '../../standardize/confidence.js';
import type { Derivation, PenaltyKind } from '../../standardize/confidence.js';
import type { KpiFact, KpiId, SourceRef } from '../../standardize/schema.js';
import { MAX_EXCLUSION_RATIO, MIN_TVL_USD } from '../../standardize/types.js';
import { transactionsUrl } from '../indexer.js';
import { priceOf } from '../types.js';
import type {
  Connector,
  ConnectorContext,
  FetchOpts,
  HealthProbe,
  PriceTable,
  RawSnapshot,
  ToFactsOpts,
} from '../types.js';
import {
  TINYMAN_BASE,
  enumerateV2Pools,
  fetchAssetDecimals,
  fetchV11Pools,
  fetchV2Flows,
  poolPageUrl,
} from './enumerate.js';
import {
  isActiveUsersEntity,
  isPoolEntity,
  type TinymanActiveUsersEntity,
  type TinymanEntity,
  type TinymanFeeState,
  type TinymanPoolEntity,
} from './schema.js';

/**
 * DATA_SCHEMA.md §3.3 — the Tinyman connector (`dex`).
 *
 * Who pays whom: a swapper pays a fee on every trade; the LPs who supplied the
 * pool keep most of it and Tinyman's treasury keeps the rest. So the swap fee
 * is `gross_fees_24h`, the LP portion is `supply_side_revenue_24h`, and the
 * treasury portion is `protocol_revenue_24h` — and the split between them is a
 * per-pool number, not a protocol-wide constant. See `README.md`.
 *
 * ## methodology_version 1.1.0
 *
 * V2 pools are now enumerated completely, from the indexer, and a V2 pool's
 * TVL is computed from its on-chain reserves through the §3.7 ladder rather
 * than read out of the analytics API. `enumerate.ts` carries the why; the
 * consequences that live here are three:
 *
 *  1. TVL for a V2 pool requires a USD price conversion, so §5's
 *     `usd_conversion` row governs its confidence — 0.90 x price_confidence —
 *     not the 0.95 `reported` row the analytics figure earned. That is a
 *     LOWER stamped number for a materially better measurement, and it is the
 *     honest direction: we replaced a dollar figure the source asserted with
 *     one we derived, and the derivation's weak link is the price, not the
 *     reserve. See `README.md` §Confidence.
 *  2. The fee split is on-chain for every V2 pool, always, because it arrives
 *     in the same indexer page as the pool. The 1/6 fallback survives only for
 *     a malformed `protocol_fee_ratio`.
 *  3. Flows (`volume_24h`, `gross_fees_24h`) are NOT on-chain and are fetched
 *     per pool, so their coverage is narrower than TVL's. Every flow KPI says
 *     so in its `notes`, and the turnover ratios are computed over the
 *     flow-covered subset so that a ratio's numerator and denominator always
 *     describe the same pools.
 */

// ---------------------------------------------------------------------------
// Constants — all verified against mainnet on 2026-09-08/09 (README §Verification)
// ---------------------------------------------------------------------------

/** Tinyman V1.1 validator application. Pools are lsig accounts opted into it. */
export const V1_VALIDATOR_APP_ID = 552_635_992;
/** Tinyman V2 validator application; holds each pool's state as LOCAL state. */
export const V2_VALIDATOR_APP_ID = 1_002_541_853;

/** §3.3: V1.1 is 30 bps total, 5 bps to the protocol. Documented, not read. */
export const V1_PROTOCOL_SHARE = 5 / 30;
/** §3.3: the fallback when a V2 pool's `protocol_fee_ratio` is unusable. */
export const V2_FALLBACK_PROTOCOL_SHARE = 1 / 6;

/** §3.1 identity tolerance. */
export const IDENTITY_TOLERANCE = 1e-6;

/**
 * §3.3 — below this share of included TVL carrying 24h flows, the flow KPIs
 * take the §5 high-exclusion penalty. Set to the same 0.90 as §5's coverage
 * rule, because it is the same claim: an aggregate describing less than 90% of
 * what it appears to describe is a weaker number and must be graded as one.
 */
export const MIN_FLOW_TVL_COVERAGE = 0.9;

/**
 * DATA_SCHEMA.md §4.1's "trailing-24h round range", as rounds.
 *
 * Measured on 2026-09-08 from two block timestamps 30,000 rounds apart:
 * 82,307 s / 30,000 rounds = 2.7436 s/round, so 86,400 / 2.7436 = 31,491.
 * Rounded to 31,500. Neither algod's status nor the §1.2 `IndexerClient`
 * exposes a block timestamp, so the window is derived from this constant rather
 * than from the chain — which is exactly why the resulting fact is
 * `is_estimated: true` and says so in its `estimation_method`.
 */
export const ROUNDS_PER_24H = 31_500;

/** Indexer page size for the §4.1 scan. */
const INDEXER_PAGE_LIMIT = 1_000;

const PROTOCOL_ID = 'tinyman';

/** Every §4 KPI applicable to class `dex`, all eleven of them. */
const DECLARED_KPIS = [
  'tvl',
  'volume_24h',
  'gross_fees_24h',
  'supply_side_revenue_24h',
  'protocol_revenue_24h',
  'take_rate',
  'capital_efficiency',
  'fee_apr',
  'volume_to_tvl',
  'active_users_24h',
  'pool_count',
] as const satisfies readonly KpiId[];

/**
 * The KPIs that need a 24h flow, and therefore the per-pool analytics lookups.
 *
 * `opts.kpis` is the lever that keeps a TVL-only refresh cheap: the flow fetch
 * is the single most expensive thing this connector does, and a refresher
 * holding TVL warm on a 60s cycle has no reason to pay for it (§4's TTLs make
 * flows a 600s KPI and TVL a 300s one). See `README.md` §Performance.
 */
const FLOW_KPIS = new Set<KpiId>([
  'volume_24h',
  'gross_fees_24h',
  'supply_side_revenue_24h',
  'protocol_revenue_24h',
  'take_rate',
  'capital_efficiency',
  'fee_apr',
  'volume_to_tvl',
]);

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

/**
 * The protocol's share of a pool's swap fee, per §3.3.
 *
 * V2's `protocol_fee_ratio` is a divisor of the total fee share: the treasury
 * takes `1 / protocol_fee_ratio` of what swappers paid. A zero or negative
 * ratio would be a division by zero wearing a plausible face, so it is treated
 * as unreadable state rather than trusted.
 */
export function protocolShareOf(fee: TinymanFeeState): {
  share: number;
  estimated: boolean;
  reason: string | null;
} {
  switch (fee.kind) {
    case 'v1_documented':
      return { share: V1_PROTOCOL_SHARE, estimated: false, reason: null };
    case 'v2_onchain':
      if (fee.protocolFeeRatio > 0) {
        return { share: 1 / fee.protocolFeeRatio, estimated: false, reason: null };
      }
      return {
        share: V2_FALLBACK_PROTOCOL_SHARE,
        estimated: true,
        reason: `protocol_fee_ratio was ${fee.protocolFeeRatio}`,
      };
    case 'v2_unreadable':
      return { share: V2_FALLBACK_PROTOCOL_SHARE, estimated: true, reason: fee.detail };
  }
}

/**
 * One pool reduced to the numbers §3.3 aggregates, or null when it cannot be
 * valued at all.
 *
 * This is the single place the 1.1.0 methodology split lives: a V1.1 pool's
 * dollars are read from the analytics API, a V2 pool's are computed as
 * `(reserves / 10^decimals) x price` on each side through the §3.7 ladder. Both
 * shapes come out of here identical, so every aggregate below is the same sum
 * it was before the methodology changed.
 */
export interface PoolValue {
  readonly tvl: number;
  /**
   * The §3.7 confidence of the prices this pool's TVL rests on, or `null` when
   * no conversion was involved (a V1.1 pool's USD figure is reported, not
   * derived). Null and 1.0 are NOT the same claim, and §5 grades them by
   * different rows.
   */
  readonly priceConfidence: number | null;
  /** Null when this pool contributes to no flow KPI (§3.3, V2 without a lookup). */
  readonly volume: number | null;
  readonly fees: number | null;
  readonly protocolShare: number;
  readonly shareEstimated: boolean;
  readonly version: '1.1' | '2.0';
  /** §3.6.5. Null on a V2 pool whose analytics record was never fetched. */
  readonly verified: boolean | null;
  /** The source's own TVL for this pool, when we saw it — a cross-check only. */
  readonly reportedTvl: number | null;
}

export function valuePool(entity: TinymanPoolEntity, prices: PriceTable): PoolValue | null {
  const { share, estimated } = protocolShareOf(entity.fee);

  if (entity.kind === 'v1_pool') {
    const pool = entity.pool;
    if (pool.liquidity_in_usd === null) return null;
    const tvl = Number(pool.liquidity_in_usd);
    if (!Number.isFinite(tvl)) return null;
    const volume =
      pool.last_day_volume_in_usd === null ? null : Number(pool.last_day_volume_in_usd);
    const fees = pool.last_day_fees_in_usd === null ? null : Number(pool.last_day_fees_in_usd);
    if (volume !== null && !Number.isFinite(volume)) return null;
    if (fees !== null && !Number.isFinite(fees)) return null;
    return {
      tvl,
      priceConfidence: null,
      volume,
      fees,
      protocolShare: share,
      shareEstimated: estimated,
      version: '1.1',
      verified: pool.is_verified,
      reportedTvl: tvl,
    };
  }

  // §3.3, 1.1.0: TVL = (r1 / 10^d1) x price_1 + (r2 / 10^d2) x price_2.
  const { asset1Decimals: d1, asset2Decimals: d2 } = entity;
  if (d1 === null || d2 === null) return null;
  const p1 = priceOf(prices, entity.asset1Id);
  const p2 = priceOf(prices, entity.asset2Id);
  if (p1 === null || p2 === null) return null;

  const tvl = (entity.asset1Reserves / 10 ** d1) * p1.usd + (entity.asset2Reserves / 10 ** d2) * p2.usd;
  if (!Number.isFinite(tvl) || tvl < 0) return null;

  return {
    tvl,
    // §5 composites take the MINIMUM: a pool's TVL is only as well-priced as
    // its worse-priced side, and averaging would hide the weak one.
    priceConfidence: Math.min(p1.confidence, p2.confidence),
    volume: entity.flows?.volumeUsd ?? null,
    fees: entity.flows?.grossFeesUsd ?? null,
    protocolShare: share,
    shareEstimated: estimated,
    version: '2.0',
    verified: entity.flows?.isVerified ?? null,
    reportedTvl: entity.flows?.liquidityUsd ?? null,
  };
}

/**
 * The asset ids a snapshot's *candidate* pools touch — what to hand
 * `PriceService.resolve` before calling `toFacts`.
 *
 * Before 1.1.0 this was restricted to pools already above the §3.6.2 $1k
 * floor, which was free because the floor could be checked against a USD
 * figure the source had computed. It no longer can: a V2 pool's TVL is not
 * knowable until its assets are priced, so the pre-filter is now the cheapest
 * price-free one available — a pool with an empty reserve on either side holds
 * nothing and cannot clear any floor. That takes 17,119 V2 pools to 6,883 and
 * the asset set to ~2,354, which is 48 chunked requests rather than 120.
 */
export function assetIdsFor(snapshot: RawSnapshot): number[] {
  const ids = new Set<number>();
  for (const entity of snapshot.entities as readonly TinymanEntity[]) {
    if (!isPoolEntity(entity)) continue;
    if (entity.kind === 'v1_pool') {
      const tvl = entity.pool.liquidity_in_usd;
      if (tvl === null || Number(tvl) < MIN_TVL_USD) continue;
      ids.add(Number(entity.pool.asset_1.id));
      ids.add(Number(entity.pool.asset_2.id));
      continue;
    }
    if (entity.asset1Reserves <= 0 || entity.asset2Reserves <= 0) continue;
    ids.add(entity.asset1Id);
    ids.add(entity.asset2Id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** Whether a pool survives the §3.6 filters under this basis and price table. */
function includePool(value: PoolValue, basis: ToFactsOpts['basis']): boolean {
  // §3.6.5 — the optional stricter basis. A V2 pool whose analytics record was
  // never fetched has an UNKNOWN verification flag, and unknown is not
  // verified: `verified_only` excludes it rather than assuming either way.
  if (basis === 'verified_only' && value.verified !== true) return false;
  // §3.6.2 — below $1k, rounding and price noise exceed signal.
  return value.tvl >= MIN_TVL_USD;
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

export const tinymanConnector: Connector = {
  capabilities: () => ({
    id: PROTOCOL_ID,
    name: 'Tinyman',
    class: 'dex',
    kpis: DECLARED_KPIS,
    sourceHosts: [
      'mainnet.analytics.tinyman.org',
      'algod:mainnet-api.4160.nodely.dev',
      'indexer:mainnet-idx.4160.nodely.dev',
    ],
    // §4.1 obliges anyone declaring active_users_24h to list the app ids it is
    // computed from. Both were confirmed on-chain rather than copied from docs:
    // a V1.1 pool account is opted into 552635992 and a V2 pool account into
    // 1002541853 (README §Verification).
    appIds: [V1_VALIDATOR_APP_ID, V2_VALIDATOR_APP_ID],
    supportsBasis: ['all_pools_usd_priced', 'verified_only'],
  }),

  async fetchRaw(ctx: ConnectorContext, opts: FetchOpts): Promise<RawSnapshot> {
    const sources: SourceRef[] = [];
    let partial = false;
    let excludedCount = 0;

    // ---- 1. Both enumerations at once ------------------------------------
    // Different hosts, so they do not contend: the indexer account walk and
    // the analytics list overlap completely, and the fetch costs the slower of
    // the two rather than their sum.
    const [v2, v11] = await Promise.all([
      enumerateV2Pools(ctx, V2_VALIDATOR_APP_ID),
      fetchV11Pools(ctx),
    ]);
    sources.push(...v2.sources, ...v11.sources);
    partial ||= v2.partial || v11.partial;
    excludedCount += v2.excludedCount + v11.excludedCount;

    // ---- 2. Decimals for the V2 reserves (§3.3) ---------------------------
    // Asset decimals are not on-chain state. Ids already carried by a V1.1
    // record cost nothing, so only the remainder is fetched.
    const known = new Map<number, number>();
    for (const pool of v11.pools) {
      known.set(Number(pool.asset_1.id), pool.asset_1.decimals);
      known.set(Number(pool.asset_2.id), pool.asset_2.decimals);
    }
    const live = v2.pools.filter((p) => p.asset1Reserves > 0 && p.asset2Reserves > 0);
    const wantedAssets = [...new Set(live.flatMap((p) => [p.asset1Id, p.asset2Id]))];
    /** Whether any requested KPI needs a 24h flow, and so the per-pool fetch. */
    const wantsFlows = opts.kpis.some((k) => FLOW_KPIS.has(k));

    // The decimals read and the §3.7 ladder both depend only on the asset ids,
    // and hit different endpoints, so they overlap. §4.3's sanctioned price
    // path is used here to SCOPE the flow fetch rather than to produce a
    // value: a flow lookup costs one request per pool, and only a pool that
    // clears §3.6 will contribute a flow to anything. The ladder caches for
    // 60s, so the caller's own resolve before `toFacts` does not pay twice.
    const [assets, scoping] = await Promise.all([
      fetchAssetDecimals(ctx, wantedAssets, known),
      wantsFlows
        ? ctx.prices.resolve(wantedAssets).catch((err: unknown) => {
            ctx.log.warn({ err }, 'tinyman: price scoping failed; flow fetch skipped');
            return null;
          })
        : Promise.resolve(null),
    ]);
    sources.push(...assets.sources);

    let v2Pools = v2.pools.map((pool) => ({
      ...pool,
      asset1Decimals: assets.decimals.get(pool.asset1Id) ?? null,
      asset2Decimals: assets.decimals.get(pool.asset2Id) ?? null,
    }));

    // ---- 3. Flows, for the pools that will actually be reported -----------
    if (wantsFlows) {
      if (scoping === null) {
        partial = true;
      } else {
        const candidates = v2Pools
          .map((pool) => ({ pool, value: valuePool(pool, scoping) }))
          .filter((c) => c.value !== null && c.value.tvl >= MIN_TVL_USD)
          .map((c) => c.pool.address);

        const flows = await fetchV2Flows(ctx, candidates);
        sources.push(...flows.sources);
        if (flows.failed > 0) partial = true;
        v2Pools = v2Pools.map((pool) => ({
          ...pool,
          flows: flows.flows.get(pool.address) ?? null,
        }));
      }
    }

    // ---- 4. Entities, deduped by address (§3.3 double-counting guard) -----
    // Both versions are counted: a V1.1 pool and the V2 pool holding the same
    // pair are distinct venues holding distinct liquidity.
    const entities: TinymanEntity[] = [];
    const seen = new Set<string>();
    for (const pool of v11.pools) {
      if (seen.has(pool.address)) continue;
      seen.add(pool.address);
      entities.push({ kind: 'v1_pool', pool, fee: { kind: 'v1_documented' } });
    }
    for (const pool of v2Pools) {
      if (seen.has(pool.address)) continue;
      seen.add(pool.address);
      entities.push(pool);
    }

    // ---- 5. §4.1 indexer scan, only when the KPI was asked for -----------
    if (opts.kpis.includes('active_users_24h')) {
      const users = await scanActiveUsers(ctx, sources);
      if (users === null) partial = true;
      else entities.push(users);
    }

    return {
      entities,
      fetchedAt: ctx.now().toISOString(),
      sources,
      partial,
      excludedCount,
    };
  },

  /** The interface hook onto {@link assetIdsFor}, for the step-5 cache pipeline. */
  priceAssets: (snapshot: RawSnapshot): readonly number[] => assetIdsFor(snapshot),

  toFacts(snapshot: RawSnapshot, opts: ToFactsOpts): KpiFact[] {
    const entities = snapshot.entities as readonly TinymanEntity[];
    const poolEntities = entities.filter(isPoolEntity);
    const activeUsers = entities.find(isActiveUsersEntity) ?? null;

    const values: PoolValue[] = [];
    let filteredOut = 0;
    for (const entity of poolEntities) {
      const value = valuePool(entity, opts.prices);
      // A pool that cannot be valued is EXCLUDED and counted (§3.6.1): an
      // unpriced side, a missing decimals, a null USD figure. Never a zero.
      if (value === null || !includePool(value, opts.basis)) {
        filteredOut++;
        continue;
      }
      values.push(value);
    }

    // ---- §3.3 normalization ----------------------------------------------
    let tvl = 0;
    let v1Tvl = 0;
    let v2Tvl = 0;
    /** Σ (pool TVL x its §3.7 price confidence), for the §5 weighting below. */
    let v2WeightedPriceConfidence = 0;
    let volume = 0;
    let grossFees = 0;
    let protocolRevenue = 0;
    /** TVL of the pools that actually carried a 24h flow. */
    let flowTvl = 0;
    let flowPools = 0;
    /** Fees whose protocol share came from the fallback constant, for §1.2. */
    let fallbackFees = 0;
    let v1Count = 0;
    let v2Count = 0;
    let verifiedCount = 0;
    /** The §3.3 self-check: our on-chain TVL against the source's own figure. */
    let crossChecked = 0;
    let crossCheckDrift = 0;

    for (const value of values) {
      tvl += value.tvl;
      if (value.version === '1.1') {
        v1Tvl += value.tvl;
        v1Count++;
      } else {
        v2Tvl += value.tvl;
        v2Count++;
        v2WeightedPriceConfidence += value.tvl * (value.priceConfidence ?? 1);
      }
      if (value.verified === true) verifiedCount++;

      if (value.volume !== null && value.fees !== null) {
        volume += value.volume;
        grossFees += value.fees;
        protocolRevenue += value.fees * value.protocolShare;
        if (value.shareEstimated) fallbackFees += value.fees;
        flowTvl += value.tvl;
        flowPools++;
      }
      if (value.reportedTvl !== null && value.reportedTvl > 0 && value.version === '2.0') {
        crossChecked++;
        crossCheckDrift += Math.abs(value.tvl - value.reportedTvl) / value.reportedTvl;
      }
    }

    const supplySide = grossFees - protocolRevenue;
    // §Step 5.3 / §3.1 — assert, don't assume.
    assertCashFlowIdentity(grossFees, supplySide, protocolRevenue);

    /**
     * §5 — the price confidence a USD aggregate rests on is the TVL-weighted
     * mean of its pools', not the minimum.
     *
     * The minimum rule in §5 is about composite FACTS, where the weak leg is
     * half the comparison. A sum over hundreds of pools is a different object:
     * taking the minimum would let one $1,000 pool priced at 0.10 grade a
     * $5.2M aggregate that is 97% ALGO, USDC and tALGO. The weighted mean
     * grades the dollars, which is what the number actually is. Added in
     * 1.1.0, when a price first entered TVL's value rather than only its
     * include/exclude decision.
     */
    const v2PriceConfidence = v2Tvl > 0 ? v2WeightedPriceConfidence / v2Tvl : 1;

    // ---- Coverage and penalties (§3.6, §5) --------------------------------
    const excluded = snapshot.excludedCount + filteredOut;
    const coverage = { entities: values.length, excluded, basis: opts.basis } as const;

    const denominator = values.length + excluded;
    const penalties: PenaltyKind[] = [];
    if (denominator > 0 && excluded / denominator > MAX_EXCLUSION_RATIO) {
      penalties.push('high_exclusion');
    }
    if (snapshot.excludedCount > 0) penalties.push('validation_skip');

    const flowCoverage = tvl > 0 ? flowTvl / tvl : 1;
    const flowPenalties: PenaltyKind[] =
      flowCoverage < MIN_FLOW_TVL_COVERAGE ? [...penalties, 'high_exclusion'] : penalties;

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

    // §3.6.4 — unverified pools are included, but the split is reported, so a
    // buyer can see how much of the aggregate Tinyman itself has not vetted.
    const versionNote =
      `${values.length} pools included: ${v1Count} V1.1 ($${v1Tvl.toFixed(0)}), ` +
      `${v2Count} V2 ($${v2Tvl.toFixed(0)}); ` +
      `${verifiedCount} verified, ${values.length - verifiedCount} unverified or unknown (§3.6.4).`;
    const partialNote = snapshot.partial
      ? [
          'Snapshot is partial: at least one upstream page or pool could not be fetched, so this aggregate covers less than the full protocol.',
        ]
      : [];

    const flowCoverageNote =
      `24h flows cover ${flowPools} of ${values.length} included pools, ` +
      `${(flowCoverage * 100).toFixed(1)}% of included TVL. On-chain pool state has no ` +
      `24h window, so V2 volume and fees come from per-pool analytics lookups while V2 TVL ` +
      `comes from on-chain reserves (§3.3): the two have different coverage, and this KPI ` +
      `describes the narrower one.`;

    const fallbackShare = grossFees > 0 ? fallbackFees / grossFees : 0;
    const feeSplitNotes: string[] = [];
    if (fallbackShare > 0) {
      feeSplitNotes.push(
        `${(fallbackShare * 100).toFixed(1)}% of gross fees came from V2 pools whose ` +
          `protocol_fee_ratio was missing or unusable in app ${V2_VALIDATOR_APP_ID} local ` +
          `state; those pools use the documented V1.1 fallback share of 1/6 (§3.3).`,
      );
    }
    feeSplitNotes.push(
      'protocol_share is per-pool, not a protocol-wide constant: V1.1 pools use the documented 5/30, V2 pools use 1 / protocol_fee_ratio read on-chain (§3.3).',
    );

    const facts: KpiFact[] = [];
    // The partial-snapshot caveat is appended here rather than at each call
    // site: it applies to every number in the response, and a note that has to
    // be remembered eleven times is a note that will be missing from the
    // twelfth fact somebody adds.
    const push = (fact: KpiFact): void => {
      facts.push({ ...fact, notes: [...(fact.notes ?? []), ...partialNote] });
    };

    const reportedConfidence = (metric: KpiId, kinds: readonly PenaltyKind[] = penalties): number =>
      computeConfidence({ derivation: { kind: 'reported' }, penalties: kinds, metric });

    // ---- TVL (§3.3, 1.1.0) -------------------------------------------------
    // A sum of two differently-derived parts, so §5's composite rule applies:
    // the V1.1 dollars are reported, the V2 dollars are a price conversion over
    // on-chain reserves, and the fact takes the weaker of the two.
    const tvlParts: Derivation[] = [];
    if (v1Tvl > 0) tvlParts.push({ kind: 'reported' });
    if (v2Tvl > 0) {
      tvlParts.push({ kind: 'usd_conversion', priceConfidence: v2PriceConfidence });
    }
    if (tvlParts.length === 0) tvlParts.push({ kind: 'reported' });

    const tvlNotes = [
      versionNote,
      `V2 TVL is computed on-chain: (asset_1_reserves / 10^dec1) x price_1 + ` +
        `(asset_2_reserves / 10^dec2) x price_2, with prices from the §3.7 ladder and ` +
        `reserves from app ${V2_VALIDATOR_APP_ID} local state. V1.1 TVL is the analytics ` +
        `API's reported liquidity_in_usd (§3.3, methodology_version 1.1.0).`,
      `Reserves are read on-chain (§5: 0.95) but the fact is denominated in USD, so §5's ` +
        `usd_conversion row governs: 0.90 x a TVL-weighted price confidence of ` +
        `${v2PriceConfidence.toFixed(3)} across the V2 pools.`,
    ];
    if (crossChecked > 0) {
      tvlNotes.push(
        `Cross-check: across the ${crossChecked} V2 pools whose analytics record was also ` +
          `read, our on-chain TVL differs from the source's own liquidity_in_usd by a mean ` +
          `${((crossCheckDrift / crossChecked) * 100).toFixed(2)}%. A signal, never a value (§3.3).`,
      );
    }

    const tvlFact: KpiFact = {
      ...base,
      metric: 'tvl',
      value: tvl,
      unit: 'USD',
      confidence: combineConfidence(
        tvlParts.map((derivation) => ({
          confidence: computeConfidence({ derivation, penalties, metric: 'tvl' }),
        })),
      ),
      is_estimated: false,
      estimation_method: null,
      notes: tvlNotes,
    };
    push(tvlFact);

    const volumeFact: KpiFact = {
      ...base,
      metric: 'volume_24h',
      value: volume,
      unit: 'USD',
      confidence: reportedConfidence('volume_24h', flowPenalties),
      is_estimated: false,
      estimation_method: null,
      // Unlike Pact's, Tinyman's volume field is already USD — no conversion,
      // and therefore no price confidence to multiply in (§3.4 contrast).
      notes: [
        'last_day_volume_in_usd is reported in USD by the source; no conversion applied.',
        flowCoverageNote,
      ],
    };
    push(volumeFact);

    const grossFeesFact: KpiFact = {
      ...base,
      metric: 'gross_fees_24h',
      value: grossFees,
      unit: 'USD',
      confidence: reportedConfidence('gross_fees_24h', flowPenalties),
      is_estimated: false,
      estimation_method: null,
      notes: [
        'last_day_fees_in_usd is the TOTAL swap fee paid by users (LP + protocol) and is never reported as protocol_revenue (§3.3).',
        flowCoverageNote,
      ],
    };
    push(grossFeesFact);

    // ---- The split (§3.1) --------------------------------------------------
    // A fee share that came from a constant rather than from chain state is a
    // fallback derivation, and §5 prices that at 0.70 — the honest cost of not
    // having read the number we are dividing by.
    const splitDerivation = fallbackShare > 0 ? ('fallback_constant' as const) : ('arithmetic' as const);
    const splitEstimation =
      fallbackShare > 0
        ? `protocol_share for ${(fallbackShare * 100).toFixed(1)}% of gross fees (by value) fell back to the documented V1.1 constant 1/6 because Tinyman V2 pool local state under app ${V2_VALIDATOR_APP_ID} was unusable`
        : null;

    const protocolRevenueFact: KpiFact = {
      ...base,
      metric: 'protocol_revenue_24h',
      value: protocolRevenue,
      unit: 'USD',
      confidence: computeConfidence({
        derivation: { kind: splitDerivation },
        penalties: flowPenalties,
        metric: 'protocol_revenue_24h',
      }),
      is_estimated: fallbackShare > 0,
      estimation_method: splitEstimation,
      notes: [...feeSplitNotes, flowCoverageNote],
    };
    push(protocolRevenueFact);

    const supplySideFact: KpiFact = {
      ...base,
      metric: 'supply_side_revenue_24h',
      value: supplySide,
      unit: 'USD',
      confidence: computeConfidence({
        derivation: { kind: splitDerivation },
        penalties: flowPenalties,
        metric: 'supply_side_revenue_24h',
      }),
      is_estimated: fallbackShare > 0,
      estimation_method: splitEstimation,
      notes: [
        'Residual of the §3.1 identity: gross_fees_24h - protocol_revenue_24h.',
        ...feeSplitNotes,
        flowCoverageNote,
      ],
    };
    push(supplySideFact);

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
            penalties: flowPenalties,
            metric,
          }),
        },
        ...inputs,
      ]),
      is_estimated: inputs.some((f) => f.is_estimated === true),
      estimation_method: inputs.find((f) => f.is_estimated === true)?.estimation_method ?? null,
      notes,
    });

    // §4's documented null-by-definition rule: below a dollar of fees the ratio
    // is noise over noise. The KPI is OMITTED rather than emitted as a
    // plausible-looking number (§1.5).
    if (grossFees >= 1) {
      push(
        ratio('take_rate', protocolRevenue / grossFees, [protocolRevenueFact, grossFeesFact], [
          'protocol_revenue_24h / gross_fees_24h. A dimensionless fraction: 0.25 means the protocol keeps 25% of what swappers paid.',
          ...feeSplitNotes,
        ]),
      );
    }

    /**
     * The turnover ratios use `flowTvl`, not `tvl`.
     *
     * Their numerator describes only the pools that carried a 24h flow, so a
     * denominator describing every included pool would invent turnover the
     * numerator never measured — a `capital_efficiency` diluted by exactly the
     * pools it could not see. When flow coverage is complete the two are the
     * same number, and when it is not, the note says which was used.
     */
    const ratioBasisNote =
      flowTvl === tvl
        ? 'Denominator is total included TVL; 24h flows cover every included pool.'
        : `Denominator is the $${flowTvl.toFixed(0)} of included TVL held by the ${flowPools} pools that carried a 24h flow, NOT the full $${tvl.toFixed(0)}: a ratio whose numerator and denominator describe different pools is not a ratio (§3.3).`;

    if (flowTvl > 0) {
      push(
        ratio('capital_efficiency', (grossFees * 365) / flowTvl, [grossFeesFact, tvlFact], [
          'Annualized gross fees per dollar of pooled capital. Comparable across protocol classes by construction (§4).',
          ratioBasisNote,
        ]),
      );
      push(
        ratio('fee_apr', (supplySide * 365) / flowTvl, [supplySideFact, tvlFact], [
          'LP yield from swap fees only. Staking and governance incentives are excluded (§3.1).',
          ratioBasisNote,
        ]),
      );
      push(
        ratio('volume_to_tvl', volume / flowTvl, [volumeFact, tvlFact], [
          'Turnover: USD swapped per dollar of pooled capital, trailing 24h.',
          ratioBasisNote,
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
      notes: [versionNote],
    });

    if (activeUsers !== null) {
      push(activeUsersFact(activeUsers, base, penalties));
    }

    return facts;
  },

  async healthCheck(ctx: ConnectorContext): Promise<HealthProbe> {
    // One page of one pool: cheap, and it exercises the exact host and path
    // shape the real fetch depends on (§1, "must not be the full fetchRaw").
    const res = await ctx.http.getJson(poolPageUrl(0, 1)).catch(() => null);
    return res === null
      ? { ok: false, detail: `${TINYMAN_BASE}/pools/ unreachable` }
      : { ok: true };
  },
};

// ---------------------------------------------------------------------------
// fetchRaw helpers
// ---------------------------------------------------------------------------

/**
 * DATA_SCHEMA.md §4.1 — distinct senders of transactions to Tinyman's validator
 * applications over the trailing-24h round range.
 *
 * Returns null, and the KPI is then omitted, if any page fails. §4.1 is explicit
 * that a connector which cannot compute this honestly declines it; a distinct
 * count over three quarters of a scan is not a smaller version of the answer,
 * it is a different and unfalsifiable number.
 */
async function scanActiveUsers(
  ctx: ConnectorContext,
  sources: SourceRef[],
): Promise<TinymanActiveUsersEntity | null> {
  const status = await ctx.algod.status().catch(() => null);
  if (status === null) {
    ctx.log.warn('active_users_24h: algod status unavailable; declining the KPI');
    return null;
  }

  const maxRound = status.lastRound;
  const minRound = Math.max(0, maxRound - ROUNDS_PER_24H);
  const senders = new Set<string>();
  let transactions = 0;
  let observedMin: number | null = null;
  let observedMax: number | null = null;

  for (const applicationId of [V1_VALIDATOR_APP_ID, V2_VALIDATOR_APP_ID]) {
    let next: string | undefined;
    for (;;) {
      const page = await ctx.indexer
        .searchTransactions({
          applicationId,
          minRound,
          maxRound,
          limit: INDEXER_PAGE_LIMIT,
          ...(next === undefined ? {} : { next }),
        })
        .catch((err: unknown) => {
          ctx.log.warn({ err, applicationId }, 'active_users_24h: indexer page failed');
          return null;
        });
      if (page === null) return null;

      if (next === undefined) {
        sources.push({
          name: 'nodely-indexer',
          url: transactionsUrl(ctx.indexer.baseUrl, {
            applicationId,
            minRound,
            maxRound,
            limit: INDEXER_PAGE_LIMIT,
          }),
          kind: 'onchain',
          retrieved_at: ctx.now().toISOString(),
          app_id: applicationId,
          round: maxRound,
        });
      }

      for (const txn of page.transactions) {
        transactions++;
        const sender = (txn as { sender?: unknown }).sender;
        if (typeof sender === 'string' && sender.length > 0) senders.add(sender);
        const round = (txn as { 'confirmed-round'?: unknown })['confirmed-round'];
        if (typeof round === 'number') {
          observedMin = observedMin === null ? round : Math.min(observedMin, round);
          observedMax = observedMax === null ? round : Math.max(observedMax, round);
        }
      }

      if (page.nextToken === undefined) break;
      next = page.nextToken;
    }
  }

  return {
    kind: 'active_users',
    addresses: senders.size,
    requestedMinRound: minRound,
    requestedMaxRound: maxRound,
    observedMinRound: observedMin,
    observedMaxRound: observedMax,
    appIds: [V1_VALIDATOR_APP_ID, V2_VALIDATOR_APP_ID],
    transactions,
  };
}

// ---------------------------------------------------------------------------
// toFacts helpers
// ---------------------------------------------------------------------------

function activeUsersFact(
  entity: TinymanActiveUsersEntity,
  base: Omit<KpiFact, 'metric' | 'value' | 'unit' | 'confidence' | 'is_estimated' | 'estimation_method' | 'notes'>,
  penalties: readonly PenaltyKind[],
): KpiFact {
  const observed =
    entity.observedMinRound !== null && entity.observedMaxRound !== null
      ? `${entity.observedMinRound}-${entity.observedMaxRound} (${entity.observedMaxRound - entity.observedMinRound} rounds)`
      : 'none (no transactions returned)';
  return {
    ...base,
    metric: 'active_users_24h',
    value: entity.addresses,
    unit: 'COUNT',
    // §5's indexer row is 0.80 and §4.1's cap is 0.80, "always, on every
    // protocol". computeConfidence applies the cap; declaring the derivation
    // honestly is what makes the two agree rather than coincide.
    confidence: computeConfidence({
      derivation: { kind: 'indexer_address_aggregation' },
      penalties: [...penalties],
      metric: 'active_users_24h',
    }),
    is_estimated: true,
    estimation_method: `distinct transaction senders to Tinyman validator apps ${entity.appIds.join(' and ')} over rounds ${entity.requestedMinRound}-${entity.requestedMaxRound}; that window is ${ROUNDS_PER_24H} rounds at a measured 2.7436 s/round rather than an exact 24h boundary, because neither algod status nor the §1.2 indexer client exposes a block timestamp`,
    notes: [
      // §4.1's limitations, surfaced on every such fact.
      'Counts ADDRESSES, not humans. One person with three wallets is three; a router batching for many users is one. No de-duplication is attempted, because any heuristic would be unfalsifiable (§4.1).',
      'Interactions routed through an aggregator are attributed to the aggregator, not to the end user (§4.1).',
      `Scanned ${entity.transactions} application transactions; requested rounds ${entity.requestedMinRound}-${entity.requestedMaxRound}, and the returned transactions actually spanned ${observed}.`,
      'Confidence is capped at 0.80 for this KPI on every protocol: it is the least reliable metric published (§4.1).',
    ],
  };
}
