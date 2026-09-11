import { z } from 'zod';

/**
 * DATA_SCHEMA.md §3.3 — the Tinyman analytics payload, validated at the
 * boundary (CONNECTOR_GUIDE.md §Step 4).
 *
 * Every field is typed as the upstream actually sends it, which for this API
 * means decimal *strings* and a lot of nullability. Two of those nullables were
 * found only by reading all 5,493 pools on 2026-09-08 and are the reason this
 * file exists rather than an inline `z.object` in `index.ts`:
 *
 * - `liquidity_in_usd` is null on 369 pools. §3.3 documents it as "decimal
 *   string".
 * - `total_annual_percentage_rate` is null on 5,469 of 5,493. §3.3 documents it
 *   as "decimal string (fraction)"; it is a cross-check field we do not use,
 *   but a schema that required it would have rejected 99.6% of the catalogue.
 *
 * A record that fails this schema is skipped and counted in `excludedCount`,
 * never coerced. A `NaN` reaching a paid response is the worst outcome
 * available, and every one of them starts as a null that someone `Number()`d.
 */

/** A decimal, as this API sends numbers: a string, never a float. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');

/** Asset ids arrive as strings here and as numbers on Pact. We normalise. */
const assetIdString = z.string().regex(/^\d+$/, 'expected a numeric asset id string');

export const TinymanAssetSchema = z.object({
  id: assetIdString,
  decimals: z.number().int().min(0).max(19),
  unit_name: z.string().nullable().default(null),
  is_verified: z.boolean().default(false),
});

export type TinymanAsset = z.infer<typeof TinymanAssetSchema>;

/**
 * §3.3's "Raw fields pulled per pool", plus the two identity fields.
 *
 * Deliberately a loose object: Tinyman sends ~35 fields and we read 10. Pinning
 * the ones we use and ignoring the rest means an upstream *addition* is not an
 * outage, while an upstream *removal or retype* of something we depend on
 * still fails loudly here.
 */
export const TinymanPoolSchema = z.object({
  address: z.string().min(1),
  version: z.enum(['1.1', '2.0']),
  asset_1: TinymanAssetSchema,
  asset_2: TinymanAssetSchema,
  is_verified: z.boolean().default(false),
  /** §3.3 TVL. Null on 369 of 5,493 pools — see the header. */
  liquidity_in_usd: decimalString.nullable().default(null),
  /** §3.3 volume, already USD (unlike Pact's, which is in asset units). */
  last_day_volume_in_usd: decimalString.nullable().default(null),
  /** §3.3 **gross** swap fees: LP + protocol. Never `protocol_revenue`. */
  last_day_fees_in_usd: decimalString.nullable().default(null),
  /** The V2 enumeration pointer (§3.3). Null on V2 records and on V1.1-only pools. */
  v2_address: z.string().min(1).nullable().default(null),
});

export type TinymanPool = z.infer<typeof TinymanPoolSchema>;

/** The list endpoint's DRF envelope. Validated too, not just the rows inside it. */
export const TinymanPageSchema = z.object({
  count: z.number().int().nonnegative(),
  next: z.string().nullable().default(null),
  results: z.array(z.unknown()),
});

// ---------------------------------------------------------------------------
// The connector-native snapshot entities
// ---------------------------------------------------------------------------

/**
 * Where a pool's protocol fee share came from, carried as data so `toFacts`
 * can do the arithmetic and `fetchRaw` can stay I/O-only.
 *
 * Since methodology_version 1.1.0 the V2 case is essentially always
 * `v2_onchain`: the §3.3 enumeration reads every pool's local state out of the
 * SAME indexer page that discovered the pool, so the fee parameters arrive
 * with the pool rather than costing a second request each. `v2_unreadable`
 * survives as a first-class case for the pool whose state is present but
 * malformed — it is what drives `is_estimated`, the `fallback_constant`
 * confidence base and the note naming the fallback (§3.3).
 */
export type TinymanFeeState =
  /** V1.1: 30 bps total, 5 bps to the protocol. Documented, not read. */
  | { readonly kind: 'v1_documented' }
  /** V2: read from the pool account's local state under the validator app. */
  | {
      readonly kind: 'v2_onchain';
      readonly totalFeeShare: number;
      readonly protocolFeeRatio: number;
      readonly appId: number;
      readonly round: number;
    }
  /** V2 with unreadable state: falls back to the V1.1 1/6 (§3.3). */
  | { readonly kind: 'v2_unreadable'; readonly detail: string };

/** A V1.1 pool, described entirely by the analytics API record. */
export interface TinymanV1PoolEntity {
  readonly kind: 'v1_pool';
  readonly pool: TinymanPool;
  readonly fee: TinymanFeeState;
}

/**
 * The 24h flows for a V2 pool, from the analytics API.
 *
 * Separate and NULLABLE because since 1.1.0 a V2 pool's TVL and its flows come
 * from different sources: reserves are on-chain and complete for all 17,119
 * pools, while `last_day_volume_in_usd` / `last_day_fees_in_usd` exist only
 * per-pool on the analytics API and are fetched only for the pools that pass
 * §3.6. A null here is a pool that has TVL but contributes to no flow KPI, and
 * §3.3 requires that to be counted and stated, not averaged away.
 */
export interface TinymanV2Flows {
  readonly volumeUsd: number;
  readonly grossFeesUsd: number;
  /** The source's own TVL for this pool — a cross-check on ours, never a value. */
  readonly liquidityUsd: number | null;
  /** §3.6.5's `verified_only` flag. Not an on-chain property. */
  readonly isVerified: boolean;
}

/**
 * A V2 pool, described by the validator application's LOCAL state on the pool
 * account (DATA_SCHEMA.md §3.3, methodology_version 1.1.0).
 *
 * Reserves are raw base units, exactly as the chain stores them: converting to
 * whole units needs `decimals`, which is not on-chain state and is carried
 * alongside as a nullable. A null `decimals` makes the pool unpriceable, so it
 * is excluded and counted rather than silently scaled by 10^0.
 */
export interface TinymanV2PoolEntity {
  readonly kind: 'v2_pool';
  readonly address: string;
  readonly asset1Id: number;
  readonly asset2Id: number;
  readonly asset1Decimals: number | null;
  readonly asset2Decimals: number | null;
  /** Raw base units. Whole units are `reserves / 10 ** decimals`. */
  readonly asset1Reserves: number;
  readonly asset2Reserves: number;
  readonly issuedPoolTokens: number;
  readonly fee: TinymanFeeState;
  /** The round the local state was read at (§4.2 — provenance, not bookkeeping). */
  readonly round: number;
  /** Null when no flow fetch was made or it failed. Never coerced to zero. */
  readonly flows: TinymanV2Flows | null;
}

export type TinymanPoolEntity = TinymanV1PoolEntity | TinymanV2PoolEntity;

/**
 * The §3.3 V2 local-state keys, validated at the boundary.
 *
 * Every one is a uint, and every one is REQUIRED: an account the indexer
 * returned under `application-id=1002541853` that is missing `asset_1_id` is
 * not a pool with an unknown asset, it is evidence that the contract's state
 * layout changed — which must fail loudly here rather than produce a pool
 * priced as asset 0.
 */
export const V2_STATE_KEYS = [
  'asset_1_id',
  'asset_2_id',
  'asset_1_reserves',
  'asset_2_reserves',
  'total_fee_share',
  'protocol_fee_ratio',
  'issued_pool_tokens',
] as const;

/**
 * The result of the DATA_SCHEMA.md §4.1 indexer scan, as one snapshot entity.
 *
 * It carries the round window it actually covered, so the fact it produces can
 * state its own basis rather than implying an exact 24h boundary the indexer
 * never gave us. Present only when `active_users_24h` was requested AND the
 * scan completed — a partial scan produces no entity, because a truncated
 * distinct-address count is an approximation, and §4.1 forbids approximating
 * this KPI rather than declining it.
 */
export interface TinymanActiveUsersEntity {
  readonly kind: 'active_users';
  readonly addresses: number;
  /** The round range we ASKED the indexer for. */
  readonly requestedMinRound: number;
  readonly requestedMaxRound: number;
  /**
   * The round range the returned transactions actually spanned.
   *
   * Recorded separately from the requested range, and reported separately in
   * the fact's notes, because they are not the same claim: the requested range
   * is our approximation of 24h, while the observed range is the window the
   * number genuinely describes. Quiet in production (they nearly coincide),
   * load-bearing everywhere else — it is what stops a fixture recorded over a
   * narrow window from producing a fact that claims a full day.
   */
  readonly observedMinRound: number | null;
  readonly observedMaxRound: number | null;
  readonly appIds: readonly number[];
  readonly transactions: number;
}

export type TinymanEntity = TinymanPoolEntity | TinymanActiveUsersEntity;

export function isPoolEntity(entity: TinymanEntity): entity is TinymanPoolEntity {
  return entity.kind === 'v1_pool' || entity.kind === 'v2_pool';
}

export function isV1PoolEntity(entity: TinymanEntity): entity is TinymanV1PoolEntity {
  return entity.kind === 'v1_pool';
}

export function isV2PoolEntity(entity: TinymanEntity): entity is TinymanV2PoolEntity {
  return entity.kind === 'v2_pool';
}

export function isActiveUsersEntity(entity: TinymanEntity): entity is TinymanActiveUsersEntity {
  return entity.kind === 'active_users';
}

/** Every pool entity's on-chain / analytics address — the §3.3 dedupe key. */
export function addressOf(entity: TinymanPoolEntity): string {
  return entity.kind === 'v1_pool' ? entity.pool.address : entity.address;
}
