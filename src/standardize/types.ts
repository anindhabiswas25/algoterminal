/**
 * Shared constants and small unions for the standardization layer.
 *
 * These live here rather than inside each connector because DATA_SCHEMA.md §3.6
 * applies the *same* filters to every DEX connector. A connector that redefines
 * MIN_TVL_USD imports its own methodology, which is the exact failure this
 * product exists to eliminate.
 */

/**
 * The `?basis=` request parameter (DATA_SCHEMA.md §3.6).
 *
 * `all_pools_usd_priced` is the default: every pool that passes filters 1-3,
 * verified or not. `verified_only` additionally requires the protocol's own
 * verification flag, which imports that protocol's curation policy — offered as
 * an option, never as the default.
 */
export const BASES = ['all_pools_usd_priced', 'verified_only'] as const;
export type Basis = (typeof BASES)[number];
export const DEFAULT_BASIS: Basis = 'all_pools_usd_priced';

/**
 * What `coverage.basis` may say on a fact (DATA_SCHEMA.md §2).
 *
 * A superset of {@link Basis}: §3.5 requires lending facts to record
 * `total_deposits` there, stating that lending TVL means total value supplied
 * (not deposits-minus-borrows, not deposits-plus-borrows). That is a *stated
 * definition*, not a requestable filter, which is why it is a valid coverage
 * value but not a valid `?basis=` value.
 */
export const COVERAGE_BASES = [...BASES, 'total_deposits'] as const;
export type CoverageBasis = (typeof COVERAGE_BASES)[number];

/**
 * DATA_SCHEMA.md §3.6.2 — pools below this are excluded from every aggregate.
 * Below $1k, rounding and price noise exceed signal.
 */
export const MIN_TVL_USD = 1_000;

/**
 * DATA_SCHEMA.md §3.7 ranks 2 and 3 — an asset only gets a price from a
 * Tinyman/Pact pool with at least this much liquidity behind it.
 */
export const MIN_PRICE_LIQUIDITY_USD = 50_000;

/**
 * DATA_SCHEMA.md §3.7 rank 5 — the minimum confidence a resolved price must
 * carry to be usable at all. Below it the asset is UNPRICED, and every pool
 * touching it is excluded and counted (§3.6.1).
 *
 * Set to the §5 global confidence floor, and for the same reason: a number the
 * ladder itself would grade below "informational" is not a measurement. It is
 * load-bearing since methodology_version 1.1.0, when TVL began multiplying
 * on-chain reserves by these prices instead of reading a USD figure the source
 * had already computed. Verified live 2026-09-09: Vestige quotes a dead asset
 * pair (Barya / Golden Nuggets, both with under $20 of liquidity) at a
 * confidence of 6e-10, and without this gate those two prices alone reported
 * $69.2 BILLION of Tinyman V2 TVL — a fifth of Algorand's market cap, produced
 * silently by two rows nobody would ever look at.
 */
export const MIN_PRICE_CONFIDENCE = 0.1;

/**
 * DATA_SCHEMA.md §5 — `coverage.excluded / (entities + excluded)` above this
 * triggers the high-exclusion confidence penalty.
 */
export const MAX_EXCLUSION_RATIO = 0.1;

/**
 * DATA_SCHEMA.md §5 / §3.5 — cross-check divergence thresholds. Exceeding one
 * adds a note and a confidence penalty; neither ever changes a value.
 */
export const DEFILLAMA_DIVERGENCE_THRESHOLD = 0.1;
export const RETENTION_DIVERGENCE_THRESHOLD = 0.05;

/**
 * DATA_SCHEMA.md §2.1 — the only units the API emits.
 *
 * There are **no percentages anywhere in the API**. Upstream sources disagree
 * about this (Tinyman's `annual_percentage_rate: "0.036882"` is a fraction,
 * Pact's `tvl_24h_change_pct: "0.00"` is a percent); normalizing at the boundary
 * is precisely the standardization work being sold.
 *
 * - `USD`          float, full precision
 * - `RATIO`        float, dimensionless. `0.0369` means 3.69%. Never a string.
 * - `COUNT`        non-negative integer
 * - `ASSET_UNITS`  float, already divided by 10^decimals; requires an
 *                  `asset_id` note (see {@link ASSET_ID_NOTE_RE})
 */
export const UNITS = ['USD', 'RATIO', 'COUNT', 'ASSET_UNITS'] as const;
export type Unit = (typeof UNITS)[number];

/**
 * DATA_SCHEMA.md §2.2 — every protocol declares exactly one class, and the
 * class determines which KPIs are applicable (§4).
 */
export const PROTOCOL_CLASSES = ['dex', 'lending', 'l1'] as const;
export type ProtocolClass = (typeof PROTOCOL_CLASSES)[number];

/**
 * §2.1 requires an `asset_id` alongside every ASSET_UNITS value. §2 gives no
 * encoding, so the layer fixes one: a `notes[]` entry of exactly this shape.
 * Connectors build it with {@link assetIdNote} rather than hand-rolling the
 * string, and the KpiFact schema enforces its presence.
 */
export const ASSET_ID_NOTE_RE = /^asset_id:\s*(\d+)$/;

/** Build the §2.1 `asset_id` note for an ASSET_UNITS fact. */
export function assetIdNote(assetId: number): string {
  return `asset_id: ${assetId}`;
}

/** Read the asset id back out of a fact's notes, or null if absent. */
export function readAssetIdNote(notes: readonly string[]): number | null {
  for (const note of notes) {
    const m = ASSET_ID_NOTE_RE.exec(note);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return null;
}
