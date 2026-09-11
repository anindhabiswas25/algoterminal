import { z } from 'zod';

/**
 * DATA_SCHEMA.md §3.4 — the Pact pool payload, validated at the boundary
 * (CONNECTOR_GUIDE.md §Step 4).
 *
 * Every field is typed as the upstream actually sends it. Pact's shape is
 * markedly tidier than Tinyman's: asset ids are numbers rather than strings,
 * and across the full 3,961-pool catalogue read on 2026-09-09 **not one field
 * this connector reads was ever null**. The nullability that matters here is
 * therefore not `null` at all — it is `"0.00000000"`, which is a string that
 * parses, multiplies and sums perfectly well while meaning "we do not know".
 * See `README.md` §Verification.
 *
 * A record that fails this schema is skipped and counted in `excludedCount`,
 * never coerced.
 */

/** A decimal, as this API sends numbers: a string, never a float. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal string');

/**
 * One side of a pool.
 *
 * `price` is a decimal string and is the field §3.7 rank 3 reads. It is
 * declared nullable because §3.4 documents it that way, but it was never once
 * null across the live catalogue — the "unknown" case arrives as `"0.00000000"`
 * on 738 primary and 1,600 secondary sides, which is why {@link isPriced}
 * exists and why nothing in this connector tests `=== null`.
 */
export const PactAssetSchema = z.object({
  id: z.number().int().nonnegative(),
  unit_name: z.string().nullable().default(null),
  decimals: z.number().int().min(0).max(19),
  is_verified: z.boolean().default(false),
  price: decimalString.nullable().default(null),
});

export type PactAsset = z.infer<typeof PactAssetSchema>;

/**
 * §3.4's "Raw fields pulled per pool".
 *
 * Deliberately a loose object: Pact sends 30 top-level fields and we read 13.
 * An upstream *addition* is then not an outage, while an upstream removal or
 * retype of something we depend on still fails loudly here.
 */
export const PactPoolSchema = z.object({
  /** Entity key. Equal to `on_chain_id` on all 3,961 pools (verified). */
  id: z.number().int().nonnegative(),
  on_chain_id: z.string().min(1),
  on_chain_address: z.string().min(1),
  /** 201 on 3,951 pools, 100 on 10 — and every v100 pool is `is_deprecated`. */
  version: z.number().int(),

  primary_asset: PactAssetSchema,
  secondary_asset: PactAssetSchema,

  /** §3.4 TVL, in USD, computed and reported by Pact. */
  tvl_usd: decimalString,
  /**
   * §3.4 volume. **Already USD**, despite what §3.4 says — see `README.md`
   * §"What §3.4 got wrong". The name carries no unit and the value is not in
   * primary-asset units; that was established against the live API rather than
   * assumed in either direction.
   */
  volume_24h: decimalString,
  volume_7d: decimalString,

  /** §3.4 **gross** swap fees in USD: swapper-paid, LP + protocol. */
  fee_usd_24h: decimalString,
  fee_usd_7d: decimalString,
  /**
   * §3.4 lists this as an asset-units cross-check. It is `0` on all 3,961
   * pools (verified 2026-09-09), so it cross-checks nothing and is read only
   * so its deadness is recorded rather than rediscovered.
   */
  fee_amount_24h: z.number(),

  /** Total pool fee in basis points. Observed: 100, 30, 2, 5, 36, 10, 15, 4. */
  fee_bps: z.number().int().nonnegative(),
  /**
   * The protocol's own cut, in bps. §3.4 calls this "frequently null".
   * It is null on **3,961 of 3,961** pools — see `README.md`.
   */
  pact_fee_bps: z.number().int().nonnegative().nullable().default(null),

  /** Observed values: `CONST`, `MANAGED_WEIGHTED`, `STBL`. Never `CONSTANT_PRODUCT`. */
  pool_type: z.string().min(1),

  /** §3.4: a fraction, and equal to `fee_usd_7d / 7 * 365 / tvl_usd` (verified). */
  apr_7d: decimalString,
  /** Excluded from `fee_apr` per §3.1. `0.000000` on every live pool. */
  apr_governance: decimalString,

  is_verified: z.boolean().default(false),
  auto_verified_100k: z.boolean().default(false),
  auto_verified_1m: z.boolean().default(false),
  /** §3.6.3 — excluded. True on exactly the 10 `version: 100` pools. */
  is_deprecated: z.boolean().default(false),
});

export type PactPool = z.infer<typeof PactPoolSchema>;

/**
 * The list endpoint's envelope. Validated too, not just the rows inside it —
 * and `limit` is load-bearing rather than decorative: it is the server's own
 * statement of the page size it actually applied, which is how this connector
 * discovers that a requested `limit=1000` was silently served as 500
 * (`README.md` §Quirks).
 */
export const PactPageSchema = z.object({
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  results: z.array(z.unknown()),
});

export type PactPage = z.infer<typeof PactPageSchema>;

// ---------------------------------------------------------------------------
// The connector-native snapshot entity
// ---------------------------------------------------------------------------

/**
 * A pool, as it sits in {@link RawSnapshot.entities}.
 *
 * A thin wrapper rather than the bare record, so `fetchRaw` can attach the
 * page it came from without doing arithmetic on it (CONNECTOR_GUIDE §Step 4:
 * "No arithmetic here. Not even a `parseFloat` that feeds a total.").
 */
export interface PactPoolEntity {
  readonly kind: 'pool';
  readonly pool: PactPool;
}

export function isPoolEntity(entity: unknown): entity is PactPoolEntity {
  return (entity as PactPoolEntity | undefined)?.kind === 'pool';
}

/**
 * Whether a side of a pool carries a usable USD price (§3.6.1).
 *
 * Pact never sends `null` here; it sends `"0.00000000"`. Both mean the same
 * thing — no price — and both must fail this test, because a zero price does
 * not announce itself downstream the way a null does: it sums, it multiplies,
 * and it silently halves the TVL of the pool that carries it.
 */
export function isPriced(asset: PactAsset): boolean {
  if (asset.price === null) return false;
  const usd = Number(asset.price);
  return Number.isFinite(usd) && usd > 0;
}
