import { cacheDeps, type CacheDeps } from '../cache/index.js';
import { hotKeys } from '../cache/hotset.js';
import { cacheKey, type FactKey } from '../cache/keys.js';
import { logger } from '../logger.js';
import { isSuccessFact, type KpiFact } from '../standardize/schema.js';
import { isExpired } from '../cache/types.js';

/**
 * The snapshotter — writes every computed `KpiFact` to `kpi_snapshots` every
 * 15 minutes (ARCHITECTURE.md §9 step 5).
 *
 * Two jobs, one row:
 *
 *  1. **Today:** it is what makes L2 a real fallback rather than an empty
 *     table. `kpi_snapshots` can only answer "the last value we knew" if
 *     something has been writing values into it all along, and the moment that
 *     matters is the one where Redis and the upstream are both unavailable —
 *     precisely when nothing can be computed to write.
 *  2. **Later:** it is the backing store for `/history`.
 *
 * ## It reads the cache; it never fetches
 *
 * The snapshotter takes what the refresher has already computed and persists
 * it. It deliberately does NOT call `computeFacts`: a second job hitting the
 * same upstreams on its own 15-minute schedule would double the request volume
 * for facts already sitting in Redis, and the two jobs' bursts would land on
 * top of each other at every common multiple of their intervals.
 *
 * Expired entries are persisted too, and on purpose. An entry past its TTL is
 * still the last value we knew, which is exactly what L2 stores; skipping it
 * would mean a protocol whose upstream has been down for an hour — the case
 * L2 exists for — stops being snapshotted at the moment it starts to matter.
 */

const log = logger.child({ component: 'snapshotter' });

/** §9 step 5 — "every 15 minutes". */
export const SNAPSHOT_INTERVAL_SECONDS = 15 * 60;

export interface SnapshotResult {
  readonly considered: number;
  readonly found: number;
  readonly written: number;
  readonly durationMs: number;
  readonly skipped: boolean;
}

export class Snapshotter {
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #lastRunAt: string | null = null;
  #lastWritten = 0;

  constructor(private readonly deps: () => CacheDeps = cacheDeps) {}

  /** Snapshot the whole hot set. Skips rather than overlaps, like the refresher. */
  async run(): Promise<SnapshotResult> {
    if (this.#running) {
      log.warn('previous snapshot still running; skipping this run');
      return { considered: 0, found: 0, written: 0, durationMs: 0, skipped: true };
    }
    this.#running = true;
    const startedAt = performance.now();
    const d = this.deps();

    try {
      const keys = hotKeys(d.hot);
      const entries: Array<{ key: FactKey; fact: KpiFact }> = [];

      for (const key of keys) {
        const redisKey = cacheKey(key, d.methodologyVersion);
        // L0 first, then L1: L0 is the fresher of the two by construction, and
        // a process that has been serving traffic holds the newest values it
        // computed there.
        const local = d.l0.get(redisKey);
        const entry = local ?? (await d.l1.get(redisKey));
        if (entry === undefined || entry === null) continue;
        if (!isSuccessFact(entry.fact)) continue;
        entries.push({ key, fact: entry.fact });
        if (isExpired(entry, d.now())) {
          log.debug({ key: redisKey }, 'snapshotting an expired entry as last-known-good');
        }
      }

      const written = await d.l2.write(entries);
      const durationMs = performance.now() - startedAt;
      this.#lastRunAt = new Date().toISOString();
      this.#lastWritten = written;

      log.info(
        {
          considered: keys.length,
          found: entries.length,
          written,
          duration_ms: Math.round(durationMs),
        },
        'snapshot complete',
      );

      return {
        considered: keys.length,
        found: entries.length,
        written,
        durationMs,
        skipped: false,
      };
    } finally {
      this.#running = false;
    }
  }

  start(): void {
    // No immediate run: at boot the cache is empty and there is nothing to
    // persist. The first snapshot lands 15 minutes in, by which time the
    // refresher has filled the hot set several times over.
    this.#timer = setInterval(() => void this.run(), SNAPSHOT_INTERVAL_SECONDS * 1_000);
    this.#timer.unref();
    log.info({ interval_s: SNAPSHOT_INTERVAL_SECONDS }, 'snapshotter started');
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  stats(): { interval_s: number; last_run_at: string | null; last_written: number } {
    return {
      interval_s: SNAPSHOT_INTERVAL_SECONDS,
      last_run_at: this.#lastRunAt,
      last_written: this.#lastWritten,
    };
  }
}

export const snapshotter = new Snapshotter();
