import { describe, it, expect, beforeEach } from 'vitest';

import { HotSet } from '../../src/cache/hotset.js';
import { DEFAULT_PARAMS, type FactKey } from '../../src/cache/keys.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics } from '../../src/cache/metrics.js';
import { fakeL1, fakeL2, testFact, type FakeL2 } from '../../src/cache/testing.js';
import { writeFacts, type CacheDeps } from '../../src/cache/index.js';
import { Snapshotter, SNAPSHOT_INTERVAL_SECONDS } from '../../src/jobs/snapshotter.js';

/**
 * The snapshotter — it is what makes L2 a real fallback rather than an empty
 * table (ARCHITECTURE.md §9 step 5).
 */

const KEY: FactKey = { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS };

interface Harness {
  deps: CacheDeps;
  l2: FakeL2;
  computeCalls: number;
  advance(ms: number): void;
}

function harness(): Harness {
  const state = { offsetMs: 0, computeCalls: 0 };
  const now = () => Date.now() + state.offsetMs;
  const l2 = fakeL2();

  const deps: CacheDeps = {
    l0: createL0(),
    l1: fakeL1(now),
    l2,
    metrics: new CacheMetrics(now),
    hot: new HotSet(now),
    now,
    methodologyVersion: '1.1.0',
    async compute() {
      state.computeCalls += 1;
      return [];
    },
  };

  return {
    deps,
    l2,
    get computeCalls() {
      return state.computeCalls;
    },
    advance(ms) {
      state.offsetMs += ms;
    },
  };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('snapshotter', () => {
  it('runs every 15 minutes', () => {
    expect(SNAPSHOT_INTERVAL_SECONDS).toBe(15 * 60);
  });

  it('persists cached facts to L2 without fetching anything upstream', async () => {
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact({ metric: 'tvl' })], h.deps);

    const result = await new Snapshotter(() => h.deps).run();

    expect(result.written).toBeGreaterThan(0);
    // It persists what the refresher already computed. A second job hitting
    // the same upstreams on its own schedule would double our request volume
    // for facts already sitting in Redis.
    expect(h.computeCalls).toBe(0);
    expect(await h.l2.latest(KEY)).not.toBeNull();
  });

  it('makes the L2 fallback answerable end to end', async () => {
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact({ value: 5_400_000 })], h.deps);
    await new Snapshotter(() => h.deps).run();

    const row = await h.l2.latest(KEY);
    expect(row?.fact.value).toBe(5_400_000);
    // Stored pristine: the read path re-labels it as an L2 serve, so a row
    // must not carry a previous request's cache outcome.
    expect(row?.fact.cache).toBe('miss');
    expect(row?.fact.stale).toBe(false);
  });

  it('snapshots an EXPIRED entry, because it is still the last value we knew', async () => {
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact()], h.deps);
    // Past the 300s TVL TTL — the exact state a protocol is in when its
    // upstream has been down for a while, which is when L2 starts to matter.
    h.advance(400_000);

    const result = await new Snapshotter(() => h.deps).run();
    expect(result.found).toBeGreaterThan(0);
    expect(await h.l2.latest(KEY)).not.toBeNull();
  });

  it('does not duplicate a row for an as_of it already holds', async () => {
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact()], h.deps);
    const snapshotter = new Snapshotter(() => h.deps);

    const first = await snapshotter.run();
    const second = await snapshotter.run();

    expect(first.written).toBeGreaterThan(0);
    // ON CONFLICT (protocol, metric, params_hash, as_of) DO NOTHING.
    expect(second.written).toBe(0);
  });

  it('skips an overlapping run rather than doubling the write', async () => {
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact()], h.deps);
    // A slow L2 write, so the second call lands mid-run.
    const slowL2 = {
      ...h.l2,
      write: async (entries: Parameters<FakeL2['write']>[0]) => {
        await new Promise((r) => setTimeout(r, 100));
        return h.l2.write(entries);
      },
    };
    const snapshotter = new Snapshotter(() => ({ ...h.deps, l2: slowL2 }));

    const first = snapshotter.run();
    const second = await snapshotter.run();
    await first;

    expect(second.skipped).toBe(true);
  });

  it('records nothing when the cache is empty rather than writing null facts', async () => {
    const result = await new Snapshotter(() => h.deps).run();
    expect(result.found).toBe(0);
    expect(result.written).toBe(0);
  });
});
