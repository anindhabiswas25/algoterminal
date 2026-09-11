import { describe, it, expect, beforeEach } from 'vitest';

import {
  getFact,
  writeFacts,
  cacheHealth,
  LOCK_WAIT_MS,
  type CacheDeps,
} from '../../src/cache/index.js';
import { cycleFor, fetchGroupId, kpisForCycle } from '../../src/cache/cycles.js';
import { HotSet } from '../../src/cache/hotset.js';
import { cacheKey, DEFAULT_PARAMS, type FactKey } from '../../src/cache/keys.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics } from '../../src/cache/metrics.js';
import { fakeL1, fakeL2, testFact, type FakeL1, type FakeL2 } from '../../src/cache/testing.js';
import { ttlSecondsFor, type KpiId } from '../../src/standardize/kpis.js';
import { KpiFactSchema, type SuccessFact } from '../../src/standardize/schema.js';
import { L2_SNAPSHOT_FLOOR } from '../../src/standardize/confidence.js';

/**
 * ARCHITECTURE.md §4.5 — the read-through cache.
 *
 * Every test here drives real tier implementations (an in-memory L1 with a
 * clock and a failure switch, an in-memory L2) rather than mocks, so what is
 * asserted is behaviour under a scenario, not that a method was called.
 */

const KEY: FactKey = { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS };
const VERSION = '1.1.0';

interface Harness {
  deps: CacheDeps;
  l1: FakeL1;
  l2: FakeL2;
  /** Facts the next upstream fetch will return. */
  produce: SuccessFact[];
  /** Every `compute` call, in order — the stampede assertion reads this. */
  fetches: Array<{ protocol: string; kpis: readonly KpiId[] }>;
  /** Made the next fetch fail. */
  failFetch: boolean;
  /** Artificial upstream latency, so concurrency is actually concurrent. */
  fetchDelayMs: number;
  clockMs: number;
  advance(ms: number): void;
}

function harness(): Harness {
  const state = {
    produce: [testFact()],
    fetches: [] as Array<{ protocol: string; kpis: readonly KpiId[] }>,
    failFetch: false,
    fetchDelayMs: 0,
    // Real time plus a manual offset, not a frozen instant. The lock-wait loop
    // is bounded by the injected clock, so a clock that never moves would spin
    // forever; and a clock the test can jump forward by 400s is what makes TTL
    // expiry testable without waiting five minutes.
    offsetMs: 0,
  };

  const now = () => Date.now() + state.offsetMs;
  const l1 = fakeL1(now);
  const l2 = fakeL2();

  const deps: CacheDeps = {
    l0: createL0(),
    l1,
    l2,
    metrics: new CacheMetrics(now),
    hot: new HotSet(now),
    now,
    methodologyVersion: VERSION,
    async compute(req) {
      state.fetches.push({ protocol: req.protocol, kpis: req.kpis });
      if (state.fetchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.fetchDelayMs));
      }
      if (state.failFetch) throw new Error('upstream is down');
      return state.produce.filter((fact) => req.kpis.includes(fact.metric));
    },
  };

  return {
    deps,
    l1,
    l2,
    get produce() {
      return state.produce;
    },
    set produce(next: SuccessFact[]) {
      state.produce = next;
    },
    get fetches() {
      return state.fetches;
    },
    get failFetch() {
      return state.failFetch;
    },
    set failFetch(next: boolean) {
      state.failFetch = next;
    },
    get fetchDelayMs() {
      return state.fetchDelayMs;
    },
    set fetchDelayMs(next: number) {
      state.fetchDelayMs = next;
    },
    get clockMs() {
      return now();
    },
    advance(ms: number) {
      state.offsetMs += ms;
    },
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

// ---------------------------------------------------------------------------
// The four tiers, and the label each one produces
// ---------------------------------------------------------------------------

describe('tier labelling (§4.5)', () => {
  it('a full miss fetches once and reports cache: "miss", stale: false', async () => {
    const fact = await getFact(KEY, {}, h.deps);
    expect(h.fetches).toHaveLength(1);
    expect(fact.cache).toBe('miss');
    expect(fact.stale).toBe(false);
    // Unpenalised: the number was computed for this request.
    expect(fact.confidence).toBe(0.7);
    expect(() => KpiFactSchema.parse(fact)).not.toThrow();
  });

  it('an L0 hit reports cache: "hit" and does not touch L1', async () => {
    await getFact(KEY, {}, h.deps);
    h.l1.down = true; // proves the second read never reached Redis
    const fact = await getFact(KEY, {}, h.deps);

    expect(h.fetches).toHaveLength(1);
    expect(fact.cache).toBe('hit');
    expect(fact.stale).toBe(false);
    expect(fact.confidence).toBe(0.7);
  });

  it('an L1 hit reports cache: "hit" and repopulates L0', async () => {
    await getFact(KEY, {}, h.deps);
    // A fresh process: L1 survives, L0 does not.
    const cold: CacheDeps = { ...h.deps, l0: createL0() };

    const fact = await getFact(KEY, {}, cold);
    expect(h.fetches).toHaveLength(1);
    expect(fact.cache).toBe('hit');
    expect(fact.confidence).toBe(0.7);
    expect(cold.l0.get(cacheKey(KEY, VERSION))).toBeDefined();
  });

  it('an expired L1 entry is served as cache: "stale" with the §5 stale_l1 penalty', async () => {
    await getFact(KEY, {}, h.deps);
    // Past the 300s TVL TTL, but inside the physical grace window.
    h.advance(400_000);

    const fact = await getFact(KEY, {}, h.deps);
    expect(fact.cache).toBe('stale');
    expect(fact.stale).toBe(true);
    // 0.70 x 0.90 = 0.63, and the fact says so rather than presenting as fresh.
    expect(fact.confidence).toBe(0.63);
    expect(fact.notes?.some((n) => n.includes('stale_l1'))).toBe(true);
  });

  it('an L2 fallback is labelled stale, dates itself to the snapshot, and floors at 0.4', async () => {
    const snapshot = testFact({ confidence: 0.5, as_of: '2026-09-09T09:00:00.000Z' });
    h.l2.seed(KEY, snapshot);
    h.failFetch = true;

    const fact = await getFact(KEY, {}, h.deps);
    expect(fact.cache).toBe('stale');
    expect(fact.stale).toBe(true);
    // §4.5: "as_of set to the snapshot time". Three hours ago, not now.
    expect(fact.as_of).toBe('2026-09-09T09:00:00.000Z');
    // 0.50 x 0.70 = 0.35, floored to 0.40 by §5.
    expect(fact.confidence).toBe(L2_SNAPSHOT_FLOOR);
    expect(fact.notes?.some((n) => n.includes('l2_snapshot'))).toBe(true);
  });

  it('never lets an L2 fallback present as fresh, whatever its stored labels', async () => {
    // A row that was stored while it was a fresh hit: if the read path trusted
    // the stored envelope instead of re-labelling, this is the fact that would
    // reach a paying caller marked `hit` / `stale: false`.
    h.l2.seed(KEY, testFact({ cache: 'hit', stale: false, confidence: 0.95 }));
    h.failFetch = true;

    const fact = await getFact(KEY, {}, h.deps);
    expect(fact.cache).toBe('stale');
    expect(fact.stale).toBe(true);
    expect(fact.confidence).toBeLessThan(0.95);
    expect(fact.confidence).toBe(0.67); // 0.95 x 0.70
  });

  it('returns a §2 error fact when every tier is empty', async () => {
    h.failFetch = true;
    const fact = await getFact(KEY, {}, h.deps);

    expect(fact.value).toBeNull();
    expect(fact.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fact.confidence).toBe(0);
    expect(() => KpiFactSchema.parse(fact)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-KPI TTLs (§6)
// ---------------------------------------------------------------------------

describe('per-KPI TTLs come from the registry (§6)', () => {
  // Written so a hardcoded global TTL cannot pass: three KPIs whose registry
  // TTLs are all different, asserted against the registry itself rather than
  // against literals, and asserted to be mutually distinct so that a global
  // constant fails on the last expectation even if it happened to match one.
  it('writes each fact under its own registry TTL, not one global number', async () => {
    const facts: SuccessFact[] = [
      testFact({ metric: 'tvl' }),
      testFact({ metric: 'volume_24h' }),
      testFact({ metric: 'active_users_24h', unit: 'COUNT', value: 4_182, confidence: 0.8 }),
    ];
    await writeFacts('tinyman', DEFAULT_PARAMS, facts, h.deps);

    const written = new Map(h.l1.writes.map((w) => [w.key, w.ttlSeconds]));
    const ttlOf = (kpi: KpiId): number | undefined =>
      written.get(cacheKey({ protocol: 'tinyman', kpi, params: DEFAULT_PARAMS }, VERSION));

    expect(ttlOf('tvl')).toBe(ttlSecondsFor('tvl'));
    expect(ttlOf('volume_24h')).toBe(ttlSecondsFor('volume_24h'));
    expect(ttlOf('active_users_24h')).toBe(ttlSecondsFor('active_users_24h'));

    // The assertion a global TTL cannot survive.
    expect(new Set([ttlOf('tvl'), ttlOf('volume_24h'), ttlOf('active_users_24h')]).size).toBe(3);
  });

  it('expires each KPI on its own schedule', async () => {
    await writeFacts(
      'tinyman',
      DEFAULT_PARAMS,
      [testFact({ metric: 'tvl' }), testFact({ metric: 'volume_24h' })],
      h.deps,
    );

    // 400s: past tvl's 300s TTL, inside volume_24h's 600s one.
    h.advance(400_000);
    const tvl = await getFact(KEY, {}, h.deps);
    const volume = await getFact({ ...KEY, kpi: 'volume_24h' }, {}, h.deps);

    expect(tvl.cache).toBe('stale');
    expect(volume.cache).toBe('hit');
  });

  it('a methodology_version bump misses rather than serving pre-bump values', async () => {
    await getFact(KEY, {}, h.deps);
    expect(h.fetches).toHaveLength(1);

    // The same process, same Redis, one version later.
    const bumped: CacheDeps = { ...h.deps, l0: createL0(), methodologyVersion: '1.2.0' };
    const fact = await getFact(KEY, {}, bumped);

    expect(h.fetches).toHaveLength(2);
    expect(fact.cache).toBe('miss');
    // And the 1.1.0 entry is untouched, so a rollback still finds it.
    expect(await h.l1.get(cacheKey(KEY, VERSION))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stampede protection (§4.5)
// ---------------------------------------------------------------------------

describe('stampede protection (§4.5)', () => {
  it('N concurrent misses on one key produce exactly ONE upstream fetch', async () => {
    h.fetchDelayMs = 50;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => getFact(KEY, {}, h.deps)),
    );

    // The whole point: 50 bots on a cold key must not be 50 fetches and a 429
    // with Retry-After: 18 from a source the paid path depends on.
    expect(h.fetches).toHaveLength(1);
    expect(results).toHaveLength(50);
    for (const fact of results) expect(fact.value).toBe(5_400_000);
    // One winner reports `miss`; the 49 losers read the winner's write.
    expect(results.filter((f) => f.cache === 'miss')).toHaveLength(1);
    expect(results.filter((f) => f.cache === 'hit')).toHaveLength(49);
  });

  it('a loser falls back to L2 when the winner never writes', async () => {
    h.l2.seed(KEY, testFact({ confidence: 0.9 }));
    // Someone else holds the fetch-group lock and will never write — a
    // crashed instance mid-enumeration.
    await h.l1.acquireLock(
      fetchGroupId(KEY.protocol, KEY.params, cycleFor(KEY.kpi), VERSION),
      60_000,
    );

    const startedAt = Date.now();
    const fact = await getFact(KEY, {}, h.deps);
    const waitedMs = Date.now() - startedAt;

    expect(h.fetches).toHaveLength(0);
    expect(fact.cache).toBe('stale');
    expect(fact.confidence).toBe(0.63); // 0.90 x 0.70
    // §4.5's "wait up to 2s". The lower bound is the assertion that matters —
    // it proves the loser waited for a winner rather than giving up at once.
    // The upper bound is generous on purpose: it exists only to catch an
    // unbounded wait, and a tight ceiling here fails on a loaded machine
    // rather than on a bug.
    expect(waitedMs).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 50);
    expect(waitedMs).toBeLessThan(LOCK_WAIT_MS * 3);
  });

  it('collapses a whole TTL class into ONE fetch, not one per KPI', async () => {
    // The defect a per-key lock has: `fetchRaw` is per-protocol, so eleven
    // cold Tinyman KPIs under eleven uncontended locks are eleven concurrent
    // full enumerations. Measured against live mainnet, that kept the fast
    // cycle at 257s against its own 60s interval and the hit rate at 0.13.
    h.fetchDelayMs = 50;
    h.produce = kpisForCycle('fast').map((kpi) => testFact({ metric: kpi }));

    const results = await Promise.all(
      kpisForCycle('fast').map((kpi) => getFact({ ...KEY, kpi }, {}, h.deps)),
    );

    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0]?.kpis).toEqual(kpisForCycle('fast'));
    expect(results.every((f) => f.value !== null)).toBe(true);
  });

  it('does not let a fast-cycle miss drag in the expensive flow fetch', async () => {
    // The other half of the same decision: filling the class must not mean
    // filling everything, or a cold TVL request pays the 65s flow lookups.
    await getFact(KEY, {}, h.deps);
    const asked = h.fetches[0]?.kpis ?? [];
    for (const kpi of asked) expect(cycleFor(kpi)).toBe('fast');
    expect(asked).not.toContain('volume_24h');
  });

  it('gives the two TTL classes independent locks', async () => {
    h.fetchDelayMs = 50;
    h.produce = [testFact({ metric: 'tvl' }), testFact({ metric: 'volume_24h' })];

    await Promise.all([
      getFact(KEY, {}, h.deps),
      getFact({ ...KEY, kpi: 'volume_24h' }, {}, h.deps),
    ]);

    // A 65-second flow refresh must never block a 13-second TVL one.
    expect(h.fetches).toHaveLength(2);
  });

  it('releases the lock after a failed fetch, so the next caller may retry', async () => {
    h.failFetch = true;
    await getFact(KEY, {}, h.deps);
    expect(h.l1.locks.size).toBe(0);

    h.failFetch = false;
    const fact = await getFact(KEY, {}, h.deps);
    expect(fact.cache).toBe('miss');
    expect(h.fetches).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Stale-while-revalidate (§4.5)
// ---------------------------------------------------------------------------

describe('stale-while-revalidate (§4.5)', () => {
  it('returns the stale value immediately AND triggers a refresh', async () => {
    await getFact(KEY, {}, h.deps);
    h.advance(400_000);
    h.produce = [testFact({ value: 6_000_000 })];

    // The caller gets the OLD value now — not a 65-second wait for the new one.
    const stale = await getFact(KEY, {}, h.deps);
    expect(stale.value).toBe(5_400_000);
    expect(stale.cache).toBe('stale');

    await settle();
    // ...and the refresh it triggered has landed.
    expect(h.fetches).toHaveLength(2);
    const refreshed = await getFact(KEY, {}, h.deps);
    expect(refreshed.value).toBe(6_000_000);
    expect(refreshed.cache).toBe('hit');
  });

  it('revalidates once even when many callers hit the same expired key', async () => {
    await getFact(KEY, {}, h.deps);
    h.advance(400_000);
    h.fetchDelayMs = 30;

    const results = await Promise.all(Array.from({ length: 20 }, () => getFact(KEY, {}, h.deps)));
    await settle();

    for (const fact of results) expect(fact.cache).toBe('stale');
    // 1 initial fill + 1 revalidation. Twenty revalidations would be the
    // stampede with an extra step.
    expect(h.fetches).toHaveLength(2);
  });

  it('leaves the stale entry standing when the background refresh fails', async () => {
    await getFact(KEY, {}, h.deps);
    h.advance(400_000);
    h.failFetch = true;

    const fact = await getFact(KEY, {}, h.deps);
    await settle();

    expect(fact.value).toBe(5_400_000);
    // Still served, still labelled — a failed refresh must not empty the cache.
    const again = await getFact(KEY, {}, h.deps);
    expect(again.cache).toBe('stale');
    expect(again.value).toBe(5_400_000);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('Redis being down (§4.5)', () => {
  it('degrades to L0 + L2 rather than erroring the request', async () => {
    // Warm L0 while Redis is up.
    await getFact(KEY, {}, h.deps);
    h.l1.down = true;

    // L0 still answers, sub-millisecond, with no error.
    const local = await getFact(KEY, {}, h.deps);
    expect(local.cache).toBe('hit');
    expect(local.error).toBeUndefined();

    // With L0 also cold, L2 answers — labelled.
    const cold: CacheDeps = { ...h.deps, l0: createL0() };
    h.l2.seed(KEY, testFact({ confidence: 0.9 }));
    h.failFetch = true;

    const fallback = await getFact(KEY, {}, cold);
    expect(fallback.error).toBeUndefined();
    expect(fallback.cache).toBe('stale');
    expect(fallback.confidence).toBe(0.63);
  });

  it('never acts as a stampede winner on a lock nobody is enforcing', async () => {
    h.l1.down = true;
    h.l2.seed(KEY, testFact());

    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => getFact(KEY, {}, h.deps)),
    );
    const elapsed = Date.now() - started;

    // Nobody can hold a lock nobody is enforcing, so nobody fetches.
    expect(h.fetches).toHaveLength(0);
    for (const fact of results) expect(fact.cache).toBe('stale');
    // And it goes straight to L2 rather than serving the 2s lock wait: there
    // is no winner to wait for, and paying the wait on every request would be
    // a self-inflicted latency floor for the whole outage.
    expect(elapsed).toBeLessThan(LOCK_WAIT_MS);
  });

  it('reports redis: "down" on /health rather than throwing', async () => {
    h.l1.down = true;
    expect(cacheHealth(h.deps).redis).toBe('down');
  });
});

// ---------------------------------------------------------------------------
// Health metrics
// ---------------------------------------------------------------------------

describe('cache metrics', () => {
  it('counts fresh hits only, so a stale-serving cache cannot look warm', async () => {
    await getFact(KEY, {}, h.deps); // miss
    await getFact(KEY, {}, h.deps); // hit
    await getFact(KEY, {}, h.deps); // hit
    h.advance(400_000);
    await getFact(KEY, {}, h.deps); // stale
    await settle();

    const health = cacheHealth(h.deps);
    expect(health.lookups_1h).toBe(4);
    expect(health.hit_rate_1h).toBe(0.5);
  });

  it('reports null before the first lookup rather than a fabricated 1.0', () => {
    expect(cacheHealth(h.deps).hit_rate_1h).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Let queued microtasks and the background revalidation settle. */
async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
