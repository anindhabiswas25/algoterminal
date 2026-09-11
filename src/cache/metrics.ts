import type { CacheState } from '../standardize/schema.js';

/**
 * Cache and refresher observability, for `/health` (API_SPEC.md §3.5).
 *
 * ## Why hit rate is bucketed rather than a running ratio
 *
 * `hit_rate_1h` degrades the service below 0.5 (API_SPEC.md §3.5), so it has
 * to *recover*. A lifetime counter cannot: an instance that starts cold spends
 * its first minutes at 0.0 and then carries that ballast for hours, and one
 * that has been up for a week cannot go degraded no matter how badly the
 * cache is doing right now. Sixty one-minute buckets in a ring give a true
 * trailing hour that both rises and falls.
 */

/** One bucket per minute of the trailing hour. */
const BUCKET_COUNT = 60;
const BUCKET_MS = 60_000;

interface Bucket {
  minute: number;
  hits: number;
  total: number;
}

export interface CacheStats {
  /** Trailing-hour hit rate, or null before the first lookup. */
  readonly hitRate1h: number | null;
  readonly lookups1h: number;
  readonly hits1h: number;
  readonly l0Size: number;
}

/**
 * A `stale` serve is NOT counted as a hit.
 *
 * It could be argued either way — a stale serve is fast and costs no upstream
 * call, which is what the hit rate is a proxy for. But the number `/health`
 * publishes is the one PRD.md §5.1 sets a 70% target for, and that target is
 * about the paid path being *warm*. A cache serving 90% stale entries is not
 * warm; it is a refresher that has stopped working, and counting those as hits
 * would hide the failure behind a healthy-looking number. Hits are fresh hits.
 */
export class CacheMetrics {
  readonly #buckets: Bucket[] = Array.from({ length: BUCKET_COUNT }, () => ({
    minute: -1,
    hits: 0,
    total: 0,
  }));

  constructor(private readonly now: () => number = Date.now) {}

  record(state: CacheState): void {
    const minute = Math.floor(this.now() / BUCKET_MS);
    const bucket = this.#buckets[minute % BUCKET_COUNT] as Bucket;
    // A bucket whose minute does not match is an hour old (or older); reset it
    // rather than adding to a count from the previous lap of the ring.
    if (bucket.minute !== minute) {
      bucket.minute = minute;
      bucket.hits = 0;
      bucket.total = 0;
    }
    bucket.total += 1;
    if (state === 'hit') bucket.hits += 1;
  }

  stats(l0Size = 0): CacheStats {
    const minute = Math.floor(this.now() / BUCKET_MS);
    let hits = 0;
    let total = 0;
    for (const bucket of this.#buckets) {
      if (minute - bucket.minute >= BUCKET_COUNT) continue;
      hits += bucket.hits;
      total += bucket.total;
    }
    return {
      hitRate1h: total === 0 ? null : round2(hits / total),
      lookups1h: total,
      hits1h: hits,
      l0Size,
    };
  }

  reset(): void {
    for (const bucket of this.#buckets) {
      bucket.minute = -1;
      bucket.hits = 0;
      bucket.total = 0;
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The process-wide counter. */
export const cacheMetrics = new CacheMetrics();

// ---------------------------------------------------------------------------
// Refresher cycle timings
// ---------------------------------------------------------------------------

/**
 * What one refresh cycle did, last time it ran.
 *
 * `last_duration_ms` next to `interval_s` is the whole point: the step-5
 * measurement put a full refresh at ~65s against a 60s interval, which is a
 * cycle that runs permanently late and never says so. Publishing both makes
 * the drift a number an operator can read off `/health` rather than something
 * inferred from a log timestamp — and `overruns` counts the times it happened.
 */
export interface CycleStats {
  readonly interval_s: number;
  readonly last_run_at: string | null;
  readonly last_duration_ms: number | null;
  readonly last_ok: number;
  readonly last_failed: number;
  /** Runs skipped because the previous one was still going (§4.6). */
  readonly skipped: number;
  /** Runs whose duration exceeded `interval_s`. */
  readonly overruns: number;
  readonly running: boolean;
}

export class CycleMetrics {
  #lastRunAt: string | null = null;
  #lastDurationMs: number | null = null;
  #lastOk = 0;
  #lastFailed = 0;
  #skipped = 0;
  #overruns = 0;
  #running = false;

  constructor(readonly intervalSeconds: number) {}

  start(): void {
    this.#running = true;
  }

  finish(args: { durationMs: number; ok: number; failed: number; at: string }): void {
    this.#running = false;
    this.#lastRunAt = args.at;
    this.#lastDurationMs = Math.round(args.durationMs);
    this.#lastOk = args.ok;
    this.#lastFailed = args.failed;
    if (args.durationMs > this.intervalSeconds * 1_000) this.#overruns += 1;
  }

  skip(): void {
    this.#skipped += 1;
  }

  get running(): boolean {
    return this.#running;
  }

  stats(): CycleStats {
    return {
      interval_s: this.intervalSeconds,
      last_run_at: this.#lastRunAt,
      last_duration_ms: this.#lastDurationMs,
      last_ok: this.#lastOk,
      last_failed: this.#lastFailed,
      skipped: this.#skipped,
      overruns: this.#overruns,
      running: this.#running,
    };
  }
}
