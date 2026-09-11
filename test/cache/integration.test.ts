import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getFact, writeFacts, type CacheDeps } from '../../src/cache/index.js';
import { HotSet } from '../../src/cache/hotset.js';
import { cacheKey, DEFAULT_PARAMS, type FactKey } from '../../src/cache/keys.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics } from '../../src/cache/metrics.js';
import { createRedisL1 } from '../../src/cache/redis.js';
import { createPostgresL2 } from '../../src/cache/snapshots.js';
import { testFact } from '../../src/cache/testing.js';
import { env } from '../../src/config/env.js';
import { closeDb, pingDb, query } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import type { L1Store } from '../../src/cache/types.js';

/**
 * The same read path, against REAL Redis and REAL Postgres.
 *
 * The in-memory doubles prove the logic; this proves the wiring — that the
 * physical grace window really does leave an expired entry readable, that
 * `SET NX PX` really does serialise a stampede across clients, and that an L2
 * row survives a JSON round trip through `jsonb` and still validates.
 *
 * Skipped, loudly, when the servers are not up. A developer without Redis
 * should see "skipped", not a failing suite — but CI runs with both.
 */

const NAMESPACE = `itest-${process.pid}`;
const KEY: FactKey = { protocol: NAMESPACE, kpi: 'tvl', params: DEFAULT_PARAMS };
// The configured version: L2's read predicate pins `env.METHODOLOGY_VERSION`,
// so a literal here would make these tests pass only while the two agreed.
const VERSION = env.METHODOLOGY_VERSION;

let l1: L1Store;
let available = false;

beforeAll(async () => {
  l1 = createRedisL1();
  // Give ioredis a moment to connect before deciding the servers are absent.
  for (let i = 0; i < 40 && l1.status() !== 'ok'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const pg = await pingDb();
  available = l1.status() === 'ok' && pg;
  if (!available) {
    process.stderr.write(
      `\n[cache integration] skipped: redis=${l1.status()} postgres=${pg ? 'ok' : 'down'} ` +
        `(REDIS_URL=${env.REDIS_URL}, DATABASE_URL set)\n`,
    );
    return;
  }
  await migrate();
});

afterAll(async () => {
  if (available) {
    await query('DELETE FROM kpi_snapshots WHERE protocol LIKE $1', [`${NAMESPACE}%`]);
  }
  await l1.close();
  await closeDb();
});

function deps(overrides: Partial<CacheDeps> = {}): CacheDeps {
  return {
    l0: createL0(),
    l1,
    l2: createPostgresL2(),
    metrics: new CacheMetrics(),
    hot: new HotSet(),
    now: Date.now,
    methodologyVersion: VERSION,
    compute: async (req) =>
      req.kpis.map((kpi) => testFact({ metric: kpi, protocol: req.protocol })),
    ...overrides,
  };
}

describe.runIf(process.env.SKIP_INTEGRATION !== '1')('cache against live Redis + Postgres', () => {
  it('round-trips a fact through real Redis', async () => {
    if (!available) return;
    const d = deps();
    const first = await getFact(KEY, {}, d);
    expect(first.cache).toBe('miss');

    // A different process would see this: L0 dropped, L1 shared.
    const second = await getFact(KEY, {}, deps({ l0: createL0() }));
    expect(second.cache).toBe('hit');
    expect(second.value).toBe(first.value);
  });

  it('serialises a stampede across independent callers', async () => {
    if (!available) return;
    const key: FactKey = { ...KEY, kpi: 'pool_count' };
    let fetches = 0;
    const d = deps({
      compute: async (req) => {
        fetches += 1;
        await new Promise((r) => setTimeout(r, 100));
        return req.kpis.map((kpi) =>
          testFact({ metric: kpi, protocol: req.protocol, unit: 'COUNT', value: 6_883 }),
        );
      },
    });

    // Each caller gets its own L0, so every one of them is a genuine L1 miss —
    // exactly 20 cold clients arriving at once.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => getFact(key, {}, { ...d, l0: createL0() })),
    );

    expect(fetches).toBe(1);
    expect(results.every((f) => f.value === 6_883)).toBe(true);
  });

  it('keeps an expired entry physically present, so SWR has something to serve', async () => {
    if (!available) return;
    const key: FactKey = { ...KEY, kpi: 'volume_24h' };
    const past = Date.now() - 10_000;
    // Written as already-expired, with the real client's grace window.
    await l1.set(cacheKey(key, VERSION), {
      fact: testFact({ metric: 'volume_24h', protocol: NAMESPACE }),
      storedAt: past - 600_000,
      expiresAt: past,
      ttlSeconds: 600,
    });

    let fetches = 0;
    const fact = await getFact(
      key,
      {},
      deps({
        compute: async (req) => {
          fetches += 1;
          return req.kpis.map((kpi) => testFact({ metric: kpi, protocol: req.protocol }));
        },
      }),
    );

    expect(fact.cache).toBe('stale');
    expect(fact.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(fetches).toBe(1);
  });

  it('writes and reads an L2 snapshot through jsonb', async () => {
    if (!available) return;
    const l2 = createPostgresL2();
    const key: FactKey = { ...KEY, kpi: 'take_rate' };
    const fact = testFact({
      metric: 'take_rate',
      protocol: NAMESPACE,
      unit: 'RATIO',
      value: 0.1667,
      as_of: '2026-09-09T09:00:00.000Z',
    });

    expect(await l2.write([{ key, fact }])).toBe(1);
    // ON CONFLICT DO NOTHING on the same (protocol, metric, params_hash, as_of).
    expect(await l2.write([{ key, fact }])).toBe(0);

    const row = await l2.latest(key);
    expect(row?.fact.value).toBe(0.1667);
    expect(row?.asOf).toBe('2026-09-09T09:00:00.000Z');
  });

  it('keys L2 by params, so two bases do not collide', async () => {
    if (!available) return;
    const l2 = createPostgresL2();
    const asOf = '2026-09-09T10:00:00.000Z';
    const base: FactKey = { ...KEY, kpi: 'pool_count' };
    const strict: FactKey = { ...base, params: { basis: 'verified_only' } };

    const written = await l2.write([
      {
        key: base,
        fact: testFact({ metric: 'pool_count', protocol: NAMESPACE, unit: 'COUNT', value: 6_883, as_of: asOf }),
      },
      {
        key: strict,
        fact: testFact({ metric: 'pool_count', protocol: NAMESPACE, unit: 'COUNT', value: 412, as_of: asOf }),
      },
    ]);

    // Under DEPLOYMENT.md §3's original UNIQUE (protocol, metric, as_of) the
    // second row would be silently dropped, and an L2 fallback would then
    // answer a verified_only request with the all-pools number.
    expect(written).toBe(2);
    expect((await l2.latest(base))?.fact.value).toBe(6_883);
    expect((await l2.latest(strict))?.fact.value).toBe(412);
  });

  it('falls back to L2 when Redis is up but the upstream is not', async () => {
    if (!available) return;
    // Its own protocol namespace: an earlier test's background revalidation
    // fills the whole slow-cycle group, `fee_apr` included, so sharing a
    // namespace would make this an L1 hit rather than the L2 fallback it is
    // testing.
    const key: FactKey = { ...KEY, protocol: `${NAMESPACE}-l2`, kpi: 'fee_apr' };
    const l2 = createPostgresL2();
    await l2.write([
      {
        key,
        fact: testFact({
          metric: 'fee_apr',
          protocol: `${NAMESPACE}-l2`,
          unit: 'RATIO',
          value: 0.041,
          confidence: 0.9,
          as_of: '2026-09-09T08:00:00.000Z',
        }),
      },
    ]);

    const fact = await getFact(
      key,
      {},
      deps({
        l2,
        compute: async () => {
          throw new Error('upstream is down');
        },
      }),
    );

    expect(fact.value).toBe(0.041);
    expect(fact.cache).toBe('stale');
    expect(fact.as_of).toBe('2026-09-09T08:00:00.000Z');
    expect(fact.confidence).toBe(0.63);
  });

  it('does not serve a pre-bump snapshot to a post-bump caller', async () => {
    if (!available) return;
    const key: FactKey = { ...KEY, kpi: 'capital_efficiency' };
    const l2 = createPostgresL2();
    await l2.write([
      {
        key,
        fact: testFact({
          metric: 'capital_efficiency',
          protocol: NAMESPACE,
          unit: 'RATIO',
          value: 0.9,
          methodology_version: '1.0.0',
          as_of: '2026-09-09T07:00:00.000Z',
        }),
      },
    ]);

    // The L2 read filters on the RUNNING methodology version, for the same
    // reason the L1 key contains it.
    expect(await l2.latest(key)).toBeNull();
  });

  it('warms L1 with per-KPI TTLs that Redis actually honours', async () => {
    if (!available) return;
    await writeFacts(
      NAMESPACE,
      DEFAULT_PARAMS,
      [testFact({ metric: 'tvl', protocol: NAMESPACE }), testFact({ metric: 'volume_24h', protocol: NAMESPACE })],
      deps(),
    );

    const tvl = await l1.get(cacheKey({ protocol: NAMESPACE, kpi: 'tvl', params: DEFAULT_PARAMS }, VERSION));
    const volume = await l1.get(
      cacheKey({ protocol: NAMESPACE, kpi: 'volume_24h', params: DEFAULT_PARAMS }, VERSION),
    );

    expect(tvl?.ttlSeconds).toBe(300);
    expect(volume?.ttlSeconds).toBe(600);
  });
});
