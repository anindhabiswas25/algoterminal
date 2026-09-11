/**
 * Live cache verification, against real Redis, real Postgres and real Tinyman.
 *
 *   MAINNET_ALGOD_URL=https://mainnet-api.4160.nodely.dev \
 *   MAINNET_INDEXER_URL=https://mainnet-idx.4160.nodely.dev \
 *   npm run cache:bench
 *
 * Measures the three numbers ARCHITECTURE.md §4.5 exists to produce, against
 * the 250ms p95 target in PRD.md §5.1:
 *
 *   1. a COLD request  — full upstream fetch, the cost the cache exists to avoid
 *   2. a warm L0 hit   — in-process, sub-millisecond
 *   3. a warm L1 hit   — Redis, from a fresh process's point of view
 *
 * Then it proves the stampede lock over a real burst, and finishes by cutting
 * Redis off mid-run to show requests still served from L0 and L2 with correct
 * labelling.
 */
import { Redis } from 'ioredis';

import { getFact, type CacheDeps } from '../src/cache/index.js';
import { HotSet } from '../src/cache/hotset.js';
import { cacheKey, DEFAULT_PARAMS, lockKey, type FactKey } from '../src/cache/keys.js';
import { createL0 } from '../src/cache/lru.js';
import { CacheMetrics } from '../src/cache/metrics.js';
import { createRedisL1 } from '../src/cache/redis.js';
import { createPostgresL2 } from '../src/cache/snapshots.js';
import { closeDb } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { computeFacts } from '../src/facts/compute.js';
import { connectorContextForMainnet } from './mainnet-context.js';
import { Snapshotter } from '../src/jobs/snapshotter.js';

const ctx = connectorContextForMainnet();

const KEY: FactKey = { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS };
const VERSION = process.env.METHODOLOGY_VERSION ?? '1.1.0';

const l1 = createRedisL1();
/**
 * A raw client purely to evict between phases.
 *
 * Cold has to mean cold: the bench measures the difference between a full
 * upstream fetch and an L1 hit, and reusing a namespace trick instead of
 * really deleting the key would measure a miss on a key nothing had ever
 * written, which is not the same thing as a cache that has been cleared.
 */
const raw = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

async function evict(key: FactKey): Promise<void> {
  const k = cacheKey(key, VERSION);
  await raw.del(k, lockKey(k));
}
const l2 = createPostgresL2();
const hot = new HotSet();
const metrics = new CacheMetrics();
let fetches = 0;

function deps(overrides: Partial<CacheDeps> = {}): CacheDeps {
  return {
    l0: createL0(),
    l1,
    l2,
    metrics,
    hot,
    now: Date.now,
    methodologyVersion: VERSION,
    compute: async (req) => {
      fetches += 1;
      return computeFacts({ ...req, kpis: [...req.kpis] }, ctx);
    },
    ...overrides,
  };
}

const out = (line: string): void => void process.stdout.write(`${line}\n`);

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

const ms = (n: number): string => `${n.toFixed(1)} ms`;

async function main(): Promise<void> {
  await migrate();

  const shared = deps();

  out('=== 1. Cold request (full upstream fetch) ===');
  await evict(KEY);
  const [cold, coldMs] = await timed(() => getFact(KEY, {}, shared));
  out(`  cache=${cold.cache} stale=${String(cold.stale)} value=${String(cold.value)}`);
  out(`  confidence=${cold.confidence}  latency=${ms(coldMs)}  upstream fetches=${fetches}`);

  out('');
  out('=== 2. Warm L0 (same process) ===');
  const l0Samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const [fact, took] = await timed(() => getFact(KEY, {}, shared));
    if (fact.cache !== 'hit') throw new Error(`expected an L0 hit, got ${String(fact.cache)}`);
    l0Samples.push(took);
  }
  out(`  cache=hit  p50=${ms(percentile(l0Samples, 50))}  p95=${ms(percentile(l0Samples, 95))}`);

  out('');
  out('=== 3. Warm L1 (a fresh process\u2019s view: L0 empty, Redis warm) ===');
  const l1Samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const [fact, took] = await timed(() => getFact(KEY, {}, deps({ l0: createL0() })));
    if (fact.cache !== 'hit') throw new Error(`expected an L1 hit, got ${String(fact.cache)}`);
    l1Samples.push(took);
  }
  out(`  cache=hit  p50=${ms(percentile(l1Samples, 50))}  p95=${ms(percentile(l1Samples, 95))}`);
  out('  PRD.md \u00a75.1 p95 target: 250 ms');

  out('');
  out('=== 4. Snapshot the hot set into L2 ===');
  const snapshot = await new Snapshotter(() => shared).run();
  out(`  considered=${snapshot.considered} found=${snapshot.found} written=${snapshot.written}`);

  out('');
  out('=== 5. Stampede: 50 concurrent cold callers, one key ===');
  // Every caller gets its own L0, so all 50 are genuine L1 misses arriving at
  // once. With a cold fetch measured at ~27s and a 2s loser wait, the losers
  // are EXPECTED to time out and fall to L2 (\u00a74.5) \u2014 which is why the
  // snapshot above runs first. The number that matters is the fetch count.
  await evict(KEY);
  const before = fetches;
  const [burst, burstMs] = await timed(() =>
    Promise.all(Array.from({ length: 50 }, () => getFact(KEY, {}, deps({ l0: createL0() })))),
  );
  out(`  upstream fetches=${fetches - before} (must be 1)  wall clock=${ms(burstMs)}`);
  out(`  outcomes: ${JSON.stringify(tally(burst.map((f) => String(f.cache))))}`);
  out(`  loser confidence: ${JSON.stringify(tally(burst.map((f) => String(f.confidence))))}`);

  out('');
  // A client-side close, which is enough to show the degradation path here.
  // `scripts/cache-redis-outage.ts` does the real thing — it stops the Redis
  // server underneath a running process.
  out('=== 6. Redis cut off mid-run ===');
  await l1.close();
  out(`  redis status: ${l1.status()}`);

  const stillWarm = await getFact(KEY, {}, shared);
  out(
    `  L0 still answers:   cache=${stillWarm.cache} stale=${String(stillWarm.stale)} ` +
      `confidence=${stillWarm.confidence}`,
  );

  const l2Served = await getFact(KEY, {}, {
    ...deps({ l0: createL0() }),
    compute: async () => {
      throw new Error('upstream unavailable');
    },
  });
  out(
    `  L2 fallback:        cache=${l2Served.cache} stale=${String(l2Served.stale)} ` +
      `confidence=${l2Served.confidence} as_of=${String(l2Served.as_of)}`,
  );
  out(`  L2 note: ${(l2Served.notes ?? []).at(-1) ?? '(none)'}`);
}

function tally(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

try {
  await main();
} finally {
  await l1.close();
  raw.disconnect();
  await closeDb();
}
