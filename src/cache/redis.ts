import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { CachedFact, L1Store } from './types.js';

/**
 * L1 — Redis (ARCHITECTURE.md §4.5). The shared tier, and the real hit source.
 *
 * ## Every method degrades; none of them throw
 *
 * A cache is an availability *improvement*. If a Redis outage turned paid
 * requests into 500s, the cache would be a new single point of failure bolted
 * in front of data we can still serve from L0 and from the L2 snapshot table.
 * So every operation here catches, logs once per transition, and returns the
 * value that means "not cached" — `null` from `get`, silence from `set`, and
 * `null` from `acquireLock`, which makes the caller behave as a stampede
 * *loser* and fall through to L2 rather than as a winner that assumes it holds
 * a lock nobody is enforcing.
 *
 * ## The stale grace window
 *
 * The physical Redis TTL is the registry TTL **plus** {@link STALE_GRACE_SECONDS}.
 * Stale-while-revalidate (§4.5) requires an expired-but-present entry, and
 * Redis has only one expiry, so logical freshness lives in the envelope
 * (`expiresAt`) and the physical key outlives it. Without the grace window,
 * "expired but present" would never be observable and SWR could not exist.
 */

/** How long past its registry TTL an entry stays physically present, for SWR. */
export const STALE_GRACE_SECONDS = 3_600;

const log = logger.child({ component: 'redis' });

export interface CreateRedisOptions {
  readonly url?: string;
  readonly staleGraceSeconds?: number;
}

class RedisL1 implements L1Store {
  readonly #client: Redis;
  readonly #grace: number;
  #status: 'ok' | 'degraded' | 'down' = 'degraded';

  constructor(opts: CreateRedisOptions = {}) {
    this.#grace = opts.staleGraceSeconds ?? STALE_GRACE_SECONDS;
    this.#client = new Redis(opts.url ?? env.REDIS_URL, {
      // A cache read must fail fast, not queue. `enableOfflineQueue: false`
      // makes a command issued while disconnected reject immediately, which
      // this class turns into "not cached" — the alternative is a request
      // sitting on a queued GET until Redis comes back, which is precisely
      // the timeout the cache exists to prevent.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      lazyConnect: true,
      // Reconnect forever with a bounded backoff: a Railway Redis restart is a
      // blip to ride out, not a reason to stay disconnected until a deploy.
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    this.#client.on('ready', () => {
      if (this.#status !== 'ok') log.info('redis connected');
      this.#status = 'ok';
    });
    this.#client.on('end', () => {
      this.#status = 'down';
    });
    // Without a listener, ioredis emits `error` on the client as an unhandled
    // event and the process exits. A Redis outage must degrade L1, not kill
    // the API.
    this.#client.on('error', (err: Error) => {
      if (this.#status === 'ok') log.warn({ err }, 'redis connection lost; degrading to L0 + L2');
      this.#status = 'down';
    });

    this.#client.connect().catch((err: unknown) => {
      log.warn({ err }, 'initial redis connect failed; serving from L0 + L2 until it recovers');
    });
  }

  status(): 'ok' | 'degraded' | 'down' {
    return this.#status;
  }

  async get(key: string): Promise<CachedFact | null> {
    try {
      const raw = await this.#client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as CachedFact;
    } catch (err) {
      // A parse failure is treated exactly like a miss rather than thrown: a
      // single corrupt or previous-format entry must cost one upstream fetch,
      // not a 500 that repeats until someone flushes the key by hand.
      log.warn({ err, key }, 'L1 read failed; treating as a miss');
      return null;
    }
  }

  async set(key: string, entry: CachedFact): Promise<void> {
    try {
      await this.#client.set(key, JSON.stringify(entry), 'EX', entry.ttlSeconds + this.#grace);
    } catch (err) {
      log.warn({ err, key }, 'L1 write failed; the entry lives in L0 only');
    }
  }

  async getRaw(key: string): Promise<string | null> {
    try {
      return await this.#client.get(key);
    } catch (err) {
      log.warn({ err, key }, 'L1 raw read failed; treating as a miss');
      return null;
    }
  }

  async setRaw(key: string, value: string, ttlSeconds: number): Promise<void> {
    // No stale-grace window, unlike `set`: the `/ask` cache has no
    // stale-while-revalidate path, so an entry past its TTL has no reader and
    // keeping it alive would only hold memory.
    try {
      await this.#client.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      log.warn({ err, key }, 'L1 raw write failed; the entry is not cached');
    }
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    try {
      const res = await this.#client.set(key, token, 'PX', ttlMs, 'NX');
      return res === 'OK' ? token : null;
    } catch (err) {
      // Redis down => nobody can hold the lock, so nobody may act as the
      // winner. Returning null makes every caller a loser, and losers fall
      // through to L2 (§4.5) instead of all fetching at once.
      log.warn({ err, key }, 'lock acquisition failed; treating as contended');
      return null;
    }
  }

  async releaseLock(key: string, token: string): Promise<void> {
    // Compare-and-delete: if our lock already expired and another caller took
    // it, a plain DEL would free *their* lock and re-open the stampede this
    // exists to close.
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end`;
    try {
      await this.#client.eval(script, 1, key, token);
    } catch (err) {
      log.warn({ err, key }, 'lock release failed; it will expire on its own');
    }
  }

  async close(): Promise<void> {
    this.#status = 'down';
    try {
      await this.#client.quit();
    } catch {
      this.#client.disconnect();
    }
  }
}

export function createRedisL1(opts: CreateRedisOptions = {}): L1Store {
  return new RedisL1(opts);
}

let shared: L1Store | null = null;

/** The process-wide L1. Lazy, so a test that never touches it opens no socket. */
export function l1(): L1Store {
  return (shared ??= createRedisL1());
}

/** Close and drop the shared client. Shutdown, and between test suites. */
export async function closeL1(): Promise<void> {
  if (shared === null) return;
  const closing = shared;
  shared = null;
  await closing.close();
}
