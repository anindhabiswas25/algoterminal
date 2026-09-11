import type { KpiFact, SuccessFact } from '../standardize/schema.js';
import type { FactKey } from './keys.js';

/**
 * The unit of storage in L0 and L1.
 *
 * Facts are cached, not raw snapshots. Both were options (CONNECTOR_GUIDE §1
 * names the choice explicitly), and facts win for one reason: a snapshot is
 * per-protocol while a TTL is per-KPI (ARCHITECTURE.md §6), so a snapshot-level
 * entry would have to carry one TTL for a `tvl` that moves every 5 minutes and
 * a `volume_24h` that moves every 10 — and whichever it picked would be wrong
 * for the other. One entry per fact lets each expire on its own schedule.
 *
 * The stored fact is the PRISTINE one, exactly as `toFacts` produced it:
 * `cache: 'miss'`, `stale: false`, connector confidence, no cache notes. Every
 * serve-time label is stamped on read, in `stampFact`, because the same stored
 * bytes are a fresh hit for one caller and a stale serve for the next.
 */
export interface CachedFact {
  readonly fact: SuccessFact;
  /** ms since epoch — when this entry was written. */
  readonly storedAt: number;
  /** ms since epoch — when it stops being fresh (`storedAt + ttlSeconds`). */
  readonly expiresAt: number;
  /** The §6 registry TTL this entry was written under, in seconds. */
  readonly ttlSeconds: number;
}

/** Whether an entry is past its TTL, given the current instant. */
export function isExpired(entry: CachedFact, nowMs: number): boolean {
  return nowMs >= entry.expiresAt;
}

/**
 * L1's contract, narrowed to what the read path uses.
 *
 * An interface rather than the concrete `ioredis` client so the cache tests
 * can drive an in-memory double — and so "Redis is down" is a state a test can
 * enter deterministically rather than by killing a server mid-suite.
 */
export interface L1Store {
  /** The entry, expired or not. Returns null when absent OR when Redis is down. */
  get(key: string): Promise<CachedFact | null>;
  /** Write with a physical expiry of `ttlSeconds + STALE_GRACE_SECONDS`. */
  set(key: string, entry: CachedFact): Promise<void>;
  /**
   * An opaque string, with an exact TTL and no stale-grace window.
   *
   * Added for the `/ask` result cache (ARCHITECTURE.md §6), which stores a
   * composed narrative rather than a `CachedFact` and has no
   * stale-while-revalidate semantics — a synthesized answer past its window is
   * not served late, it is re-synthesized. Putting it on this interface rather
   * than opening a second Redis client keeps one connection, one degradation
   * policy and one `status()` for the whole L1 tier.
   *
   * Returns null when absent OR when Redis is down, exactly like {@link get}.
   */
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * `SET key token NX PX ttl`. Returns the token on success, null when another
   * caller already holds it (or when Redis is down — a lock we cannot take is
   * a lock we do not hold, and the caller must behave as a loser either way).
   */
  acquireLock(key: string, ttlMs: number): Promise<string | null>;
  /** Release only if the value still matches `token` — never someone else's lock. */
  releaseLock(key: string, token: string): Promise<void>;
  status(): 'ok' | 'degraded' | 'down';
  close(): Promise<void>;
}

/** One row of L2, as the read path needs it. */
export interface SnapshotRow {
  readonly fact: SuccessFact;
  /** RFC3339 — the snapshot's `as_of`, which becomes the served fact's. */
  readonly asOf: string;
}

/** L2's contract (Postgres `kpi_snapshots`). */
export interface L2Store {
  /** The newest snapshot for this identity, or null. Never throws. */
  latest(key: FactKey): Promise<SnapshotRow | null>;
  /** Upsert facts. Returns how many rows were newly written. */
  write(entries: ReadonlyArray<{ key: FactKey; fact: KpiFact }>): Promise<number>;
}
