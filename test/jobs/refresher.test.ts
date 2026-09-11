import { describe, it, expect, beforeEach, vi } from 'vitest';

import { groupByFetch, hotKeys, HotSet } from '../../src/cache/hotset.js';
import { cacheKey, DEFAULT_PARAMS } from '../../src/cache/keys.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics, CycleMetrics } from '../../src/cache/metrics.js';
import { fakeL1, fakeL2, testFact, type FakeL1 } from '../../src/cache/testing.js';
import type { CacheDeps } from '../../src/cache/index.js';
import { getConnector } from '../../src/connectors/registry.js';
import type { Connector } from '../../src/connectors/types.js';
import { producibleKpis } from '../../src/facts/compute.js';
import {
  cycleFor,
  kpisForCycle,
  Refresher,
  FAST_INTERVAL_SECONDS,
  FAST_TTL_THRESHOLD_SECONDS,
  MEASURED_FAST_CYCLE_SECONDS,
  SLOW_CYCLE_START_DELAY_SECONDS,
  SLOW_INTERVAL_SECONDS,
} from '../../src/jobs/refresher.js';
import { KPI_IDS, ttlSecondsFor, type KpiId } from '../../src/standardize/kpis.js';

/**
 * ARCHITECTURE.md §4.6 — the refresher, as two TTL-scoped cycles.
 */

interface Harness {
  deps: CacheDeps;
  l1: FakeL1;
  calls: Array<{ protocol: string; kpis: readonly KpiId[] }>;
  /** Artificial upstream latency, for the overlap and drift assertions. */
  delayMs: number;
  failing: boolean;
}

function harness(): Harness {
  const state = { delayMs: 0, failing: false };
  const calls: Array<{ protocol: string; kpis: readonly KpiId[] }> = [];
  const l1 = fakeL1();

  const deps: CacheDeps = {
    l0: createL0(),
    l1,
    l2: fakeL2(),
    metrics: new CacheMetrics(),
    hot: new HotSet(),
    now: Date.now,
    methodologyVersion: '1.1.0',
    async compute(req) {
      calls.push({ protocol: req.protocol, kpis: req.kpis });
      if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.failing) throw new Error('upstream is down');
      return req.kpis.map((kpi) => testFact({ metric: kpi, unit: unitFor(kpi) }));
    },
  };

  return {
    deps,
    l1,
    calls,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(next: number) {
      state.delayMs = next;
    },
    get failing() {
      return state.failing;
    },
    set failing(next: boolean) {
      state.failing = next;
    },
  };
}

/** COUNT KPIs must carry an integer value to pass §2.1 validation. */
function unitFor(kpi: KpiId): 'USD' | 'RATIO' | 'COUNT' {
  if (kpi === 'active_users_24h' || kpi === 'pool_count') return 'COUNT';
  return 'USD';
}

/**
 * How many `compute` calls exactly one fast cycle makes: one per
 * `(protocol, basis)` fetch group with at least one fast-cycle KPI left after
 * scoping. Computed from the hot set the refresher itself walks rather than
 * written down, so adding a connector moves this number instead of breaking
 * the assertion that uses it.
 */
/**
 * What one cycle should ask a given protocol for: the KPIs that connector can
 * actually produce, narrowed to the cycle. Derived from the registry, because
 * the answer differs per connector — a `lending` protocol produces no
 * `volume_24h` and no `volume_to_tvl` (§4), so a literal list here would be an
 * assertion about which connectors happen to be registered today.
 */
function expectedKpis(protocol: string, cycle: 'fast' | 'slow'): KpiId[] {
  const connector = getConnector(protocol);
  expect(connector).toBeDefined();
  return producibleKpis(connector as Connector)
    .filter((kpi) => cycleFor(kpi) === cycle)
    .sort();
}

/** Every KPI the cycle asked for, across all protocols. */
function unionOfCalls(harnessState: Harness): KpiId[] {
  return [...new Set(harnessState.calls.flatMap((call) => [...call.kpis]))];
}

function fastGroupCount(deps: CacheDeps): number {
  const keys = hotKeys(deps.hot).filter((key) => cycleFor(key.kpi) === 'fast');
  return groupByFetch(keys).length;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

describe('cycle membership is derived from the §6 registry TTLs', () => {
  it('assigns each KPI by its TTL, not by a hardcoded name list', () => {
    for (const kpi of KPI_IDS) {
      const expected = ttlSecondsFor(kpi) <= FAST_TTL_THRESHOLD_SECONDS ? 'fast' : 'slow';
      expect(cycleFor(kpi)).toBe(expected);
    }
    // A KPI whose TTL is later relaxed moves cycle on its own, which is the
    // property that keeps §4.6 and §6 from drifting apart.
    expect([...kpisForCycle('fast'), ...kpisForCycle('slow')].sort()).toEqual([...KPI_IDS].sort());
  });

  it('puts TVL on the fast cycle and the 24h flows on the slow one', () => {
    expect(cycleFor('tvl')).toBe('fast');
    expect(cycleFor('volume_24h')).toBe('slow');
    expect(cycleFor('gross_fees_24h')).toBe('slow');
    expect(cycleFor('active_users_24h')).toBe('slow');
  });

  it('gives each cycle an interval its measured duration fits inside', () => {
    // The measurement that produced the split: a full refresh floors at ~65s;
    // a TVL-scoped one is 13-14s. The slow cycle's period matches the §6 TTL
    // of the KPIs on it, so it refreshes them exactly as often as they go
    // stale and no more.
    expect(FAST_INTERVAL_SECONDS).toBe(90);
    expect(SLOW_INTERVAL_SECONDS).toBe(ttlSecondsFor('volume_24h'));
  });

  it('keeps the fast interval under the tightest §6 TTL on the fast cycle', () => {
    // The §4g item 3 invariant, asserted rather than left to a comment.
    //
    // The fast cycle exists to replace an entry BEFORE it expires. Its
    // interval must therefore leave room for the cycle itself inside the
    // shortest TTL it is responsible for — 120s, the rate models §6 gives two
    // minutes because "risk agents act on these; staleness here has a real
    // cost". At the measured ~13s steady-state duration, 90 + 13 = 103 <= 120.
    //
    // This is what stops the interval and the TTL table drifting apart: a KPI
    // added later with a 90s TTL joins the fast class by definition
    // (`cycleFor`) and fails HERE, rather than becoming quietly stale in
    // production where nothing would report it.
    const tightestFastTtl = Math.min(...kpisForCycle('fast').map(ttlSecondsFor));
    expect(tightestFastTtl).toBe(120);
    expect(FAST_INTERVAL_SECONDS + MEASURED_FAST_CYCLE_SECONDS).toBeLessThanOrEqual(tightestFastTtl);

    // And the slow cycle must not silently inherit the fast one's job: every
    // KPI it holds has a TTL above the threshold that put it there.
    expect(Math.min(...kpisForCycle('slow').map(ttlSecondsFor))).toBeGreaterThan(
      FAST_TTL_THRESHOLD_SECONDS,
    );
  });
});

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

describe('runCycle', () => {
  it('scopes opts.kpis to its own cycle, so the fast cycle never pays for flows', async () => {
    const refresher = new Refresher(() => h.deps);
    await refresher.runCycle('fast');

    expect(h.calls.length).toBeGreaterThan(0);
    for (const call of h.calls) {
      // `opts.kpis` is the whole reason the fast cycle is 13s and not 65s: it
      // is what lets the connector skip the per-pool analytics lookups.
      for (const kpi of call.kpis) expect(cycleFor(kpi)).toBe('fast');
      // Each group is asked for exactly what THAT connector can produce on
      // this cycle — not for a fixed list. Naming `tvl` and `volume_24h`
      // directly would have been an assertion about the DEX connectors that
      // happened to be registered, and a lending connector produces neither
      // `volume_24h` nor `volume_to_tvl` at all.
      expect([...call.kpis].sort()).toEqual(expectedKpis(call.protocol, 'fast'));
    }
    // The point of the split, asserted over the cycle rather than per group.
    expect(unionOfCalls(h)).not.toContain('volume_24h');
  });

  it('the slow cycle asks for the flow KPIs and nothing the fast one covers', async () => {
    const refresher = new Refresher(() => h.deps);
    await refresher.runCycle('slow');

    for (const call of h.calls) {
      for (const kpi of call.kpis) expect(cycleFor(kpi)).toBe('slow');
      expect([...call.kpis].sort()).toEqual(expectedKpis(call.protocol, 'slow'));
    }
    // `volume_24h` is on this cycle SOMEWHERE — but not on every group, since
    // it is a DEX-only KPI (§4). `tvl` is on no group, because it is fast.
    expect(unionOfCalls(h)).toContain('volume_24h');
    expect(unionOfCalls(h)).not.toContain('tvl');
  });

  it('warms the cache: every refreshed fact lands in L1 under its own TTL', async () => {
    const refresher = new Refresher(() => h.deps);
    await refresher.runCycle('fast');

    const key = cacheKey({ protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS }, '1.1.0');
    const entry = await h.l1.get(key);
    expect(entry).not.toBeNull();
    expect(entry?.ttlSeconds).toBe(ttlSecondsFor('tvl'));
  });

  it('one group failing does not stop the rest of the cycle', async () => {
    h.failing = true;
    const refresher = new Refresher(() => h.deps);
    const result = await refresher.runCycle('fast');

    expect(result.failed).toBeGreaterThan(0);
    expect(result.skipped).toBe(false);
    expect(refresher.stats().fast.last_failed).toBe(result.failed);
  });
});

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

describe('a cycle never overlaps itself (§4.6)', () => {
  it('skips an overlapping run instead of queueing it', async () => {
    h.delayMs = 120;
    const refresher = new Refresher(() => h.deps);

    const first = refresher.runCycle('fast');
    // Fired while the first is mid-flight, exactly as setInterval would.
    const second = await refresher.runCycle('fast');
    const third = await refresher.runCycle('fast');

    expect(second.skipped).toBe(true);
    expect(third.skipped).toBe(true);
    await first;

    // Skipped, not queued: a queue that never drains means the work that
    // eventually runs is stale by however long the backlog has grown.
    expect(refresher.stats().fast.skipped).toBe(2);

    // Exactly ONE CYCLE's worth of work happened — which is the claim, and is
    // not the same as "one fetch". A cycle fetches once per (protocol, basis)
    // group, so counting raw calls silently asserted "the registry holds one
    // connector": it passed with Tinyman alone and broke on Pact without the
    // overlap guard changing at all. Derived from the same hot set the
    // refresher walks, so it stays true at any registry size.
    expect(h.calls).toHaveLength(fastGroupCount(h.deps));
    // And no protocol was fetched twice, which is what a queued run would look
    // like from here regardless of how many protocols there are.
    const fetched = h.calls.map((c) => c.protocol);
    expect([...new Set(fetched)]).toHaveLength(fetched.length);

    // And the guard clears, so the next scheduled run is not blocked forever.
    const fourth = await refresher.runCycle('fast');
    expect(fourth.skipped).toBe(false);
  });

  it('the guard is per cycle: a slow run does not block the fast one', async () => {
    h.delayMs = 120;
    const refresher = new Refresher(() => h.deps);

    const slow = refresher.runCycle('slow');
    const fast = await refresher.runCycle('fast');

    expect(fast.skipped).toBe(false);
    await slow;
    expect(refresher.stats().fast.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe('start()', () => {
  it('staggers the slow cycle so the two do not fight at boot', async () => {
    // Both firing at once makes them share one per-host concurrency budget:
    // measured on a live cold start, that took the fast cycle from its usual
    // 13-38s to 72s — past its interval, with a skipped run behind it.
    expect(SLOW_CYCLE_START_DELAY_SECONDS).toBe(FAST_INTERVAL_SECONDS);

    const refresher = new Refresher(() => h.deps);
    refresher.start();
    await vi.waitFor(() => expect(h.calls.length).toBeGreaterThan(0));
    refresher.stop();

    // Only the fast cycle has run; the slow one is still waiting out its delay.
    for (const call of h.calls) {
      for (const kpi of call.kpis) expect(cycleFor(kpi)).toBe('fast');
    }
    expect(refresher.stats().slow.last_run_at).toBeNull();
  });
});

describe('cycle timings are exposed (§4.6)', () => {
  it('publishes duration alongside interval, and counts overruns', async () => {
    const refresher = new Refresher(() => h.deps);
    await refresher.runCycle('fast');

    const stats = refresher.stats().fast;
    expect(stats.interval_s).toBe(FAST_INTERVAL_SECONDS);
    expect(stats.last_duration_ms).toBeGreaterThanOrEqual(0);
    expect(stats.last_run_at).not.toBeNull();
    expect(stats.running).toBe(false);
    // Nothing here took 60 seconds, so nothing drifted.
    expect(stats.overruns).toBe(0);
  });

  it('counts a run that exceeded its interval as an overrun', () => {
    // What §4g item 3 was reading off /health: a fast cycle measured at 73.9s.
    // Against the old 60s interval that was an overrun and a skip; against the
    // widened one it is a slow run that still finishes inside its period, which
    // is the whole point of widening it. `overruns` is what turns "the cycle is
    // quietly running late" into a number on /health either way.
    const metrics = new CycleMetrics(FAST_INTERVAL_SECONDS);

    metrics.start();
    metrics.finish({ durationMs: 13_500, ok: 1, failed: 0, at: new Date().toISOString() });
    expect(metrics.stats().overruns).toBe(0);
    expect(metrics.stats().last_duration_ms).toBe(13_500);

    // The observed worst case, which no longer overruns.
    metrics.start();
    metrics.finish({ durationMs: 73_900, ok: 1, failed: 0, at: new Date().toISOString() });
    expect(metrics.stats().overruns).toBe(0);

    metrics.start();
    metrics.finish({ durationMs: 95_000, ok: 1, failed: 0, at: new Date().toISOString() });
    expect(metrics.stats().overruns).toBe(1);
  });
});
