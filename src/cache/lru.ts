import { LRUCache } from 'lru-cache';

import type { CachedFact } from './types.js';

/**
 * L0 — the in-process tier (ARCHITECTURE.md §4.5).
 *
 * ~2k entries, 60s. Three jobs, in order of how much they matter:
 *
 *  1. **Absorb bursts.** A yield-routing bot (PRD.md §3.2) fires a dozen
 *     `/metric` calls in the same second; only the first should touch Redis.
 *  2. **Sub-millisecond reads.** An L1 round trip is ~1ms on Railway's private
 *     network but is a network call, and the p95 target is 250ms end to end.
 *  3. **Survive a Redis blip.** When L1 is unreachable the process still
 *     answers from here for up to 60 seconds — long enough for a failover.
 *
 * The 60s ceiling is NOT a second TTL policy competing with §6. Each entry
 * expires at the earlier of 60s and its own registry TTL, so L0 can only ever
 * be *fresher* than L1, never staler. That direction matters: L0 is per-process
 * and cannot be invalidated from outside, so an entry that outlived its
 * registry TTL here would be a stale number no operator could clear.
 */

/** §4.5 — "~2k entries". */
export const L0_MAX_ENTRIES = 2_000;
/** §4.5 — the L0 ceiling, in seconds. Never longer than the registry TTL. */
export const L0_MAX_TTL_SECONDS = 60;

export interface L0Cache {
  get(key: string): CachedFact | undefined;
  set(key: string, entry: CachedFact): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

/**
 * `lru-cache` with per-entry TTL.
 *
 * `ttlAutopurge` is deliberately left off: entries are purged lazily on read
 * (and by LRU eviction), which is what a fixed-size cache in front of a shared
 * one wants. Autopurge would schedule a timer per entry, and 2,000 live timers
 * is a measurable cost for the sole benefit of freeing memory in a cache whose
 * size is already bounded.
 */
export function createL0(maxEntries: number = L0_MAX_ENTRIES): L0Cache {
  const lru = new LRUCache<string, CachedFact>({ max: maxEntries });

  return {
    get: (key) => lru.get(key),
    set(key, entry) {
      const ttlMs = Math.max(1, Math.min(L0_MAX_TTL_SECONDS * 1_000, entry.expiresAt - Date.now()));
      lru.set(key, entry, { ttl: ttlMs });
    },
    delete: (key) => void lru.delete(key),
    clear: () => lru.clear(),
    get size() {
      return lru.size;
    },
  };
}

/** The process-wide L0. One per process, by definition of "in-process". */
export const l0: L0Cache = createL0();
