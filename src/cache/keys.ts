import { createHash } from 'node:crypto';

import { env } from '../config/env.js';
import type { KpiId } from '../standardize/kpis.js';
import { DEFAULT_BASIS, type Basis } from '../standardize/types.js';

/**
 * ARCHITECTURE.md §4.5 — `kpi:v{methodology_version}:{protocol}:{kpi}:{paramsHash}`.
 *
 * ## Why the methodology version is in the key
 *
 * It is not a cache-busting convenience; it is a correctness requirement. A
 * `methodology_version` bump means the same KPI id now denotes a different
 * number: 1.1.0 enumerates Tinyman V2 from the chain and prices its reserves,
 * so `tinyman:tvl` went from $0.6M reported to $5.4M computed, and its
 * confidence from 0.86 to 0.70. Serving a 1.0.0 entry to a 1.1.0 caller would
 * hand back a pre-bump number stamped with post-bump semantics — a fact that
 * is wrong in exactly the way DATA_SCHEMA.md §1 exists to prevent, and one
 * nothing downstream could detect, because the envelope would look correct.
 *
 * Putting the version in the key rather than validating it on read means the
 * old entries are not *rejected*, they are unreachable: they age out under
 * their own TTLs while the new namespace fills, and a rollback to 1.0.0 finds
 * its own entries still there.
 */

/** Everything that can change a fact's value for a fixed (protocol, kpi). */
export interface FactParams {
  /** DATA_SCHEMA.md §3.6 inclusion basis. */
  readonly basis: Basis;
}

export const DEFAULT_PARAMS: FactParams = Object.freeze({ basis: DEFAULT_BASIS });

/** A cache identity: the tuple a key is built from. */
export interface FactKey {
  readonly protocol: string;
  readonly kpi: KpiId;
  readonly params: FactParams;
}

/** The `kpi:` namespace prefix, so a flush can target facts and nothing else. */
export const KEY_PREFIX = 'kpi';
/** Length of the truncated params digest. */
const HASH_LENGTH = 12;

/**
 * A stable digest of the parameters.
 *
 * Canonicalised by sorting keys before hashing, so `{basis}` and a future
 * `{basis, window}` written in either order produce one key rather than two —
 * a cache that misses on field order is a cache with half the hit rate and no
 * symptom. Truncated to 12 hex characters (48 bits): these keys are read in
 * logs and `redis-cli`, and the collision risk across a namespace of a few
 * hundred parameter shapes is nil.
 */
export function paramsHash(params: FactParams): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Build the §4.5 key.
 *
 * `methodologyVersion` is an argument with a default rather than a direct read
 * of `env`, so a test can prove that changing it changes the key — the whole
 * property this function exists for is untestable if the version is baked in.
 */
export function cacheKey(
  key: FactKey,
  methodologyVersion: string = env.METHODOLOGY_VERSION,
): string {
  return `${KEY_PREFIX}:v${methodologyVersion}:${key.protocol}:${key.kpi}:${paramsHash(key.params)}`;
}

/** The stampede lock key for a fact key (ARCHITECTURE.md §4.5). */
export function lockKey(key: string): string {
  return `lock:${key}`;
}

/** A human-readable identity for logs and hot-set entries. */
export function describeKey(key: FactKey): string {
  return `${key.protocol}/${key.kpi}?basis=${key.params.basis}`;
}
