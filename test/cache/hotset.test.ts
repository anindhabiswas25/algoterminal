import { describe, it, expect } from 'vitest';

import { fullMatrix, groupByFetch, hotKeys, HotSet, HOT_WINDOW_MS } from '../../src/cache/hotset.js';
import { DEFAULT_PARAMS, describeKey } from '../../src/cache/keys.js';
import { listConnectors } from '../../src/connectors/registry.js';
import { producibleKpis } from '../../src/facts/compute.js';

/** ARCHITECTURE.md §4.6 — the hot set. */

describe('fullMatrix', () => {
  it('covers every KPI every registered connector can produce', () => {
    const matrix = fullMatrix();
    const expected = listConnectors().flatMap((c) =>
      producibleKpis(c).map((kpi) => `${c.capabilities().id}/${kpi}?basis=${DEFAULT_PARAMS.basis}`),
    );
    expect(matrix.map(describeKey).sort()).toEqual(expected.sort());
  });

  it('is generated from the registry, so protocol #4 needs no edit here', () => {
    // The claim ARCHITECTURE.md §1.5 makes about adding a connector. If this
    // file had a list of protocol names in it, that claim would be false.
    const protocols = new Set(fullMatrix().map((k) => k.protocol));
    expect(protocols).toEqual(new Set(listConnectors().map((c) => c.capabilities().id)));
  });

  it('pre-warms only the default basis', () => {
    // Every basis would multiply the refresh cost by the number of bases, for
    // combinations nobody has asked for. Non-default bases arrive through the
    // recency half instead, on their first (cold) call.
    expect(fullMatrix().every((k) => k.params.basis === DEFAULT_PARAMS.basis)).toBe(true);
  });
});

describe('HotSet', () => {
  it('remembers what was requested, and forgets it after 6 hours', () => {
    let clock = Date.parse('2026-09-09T12:00:00.000Z');
    const set = new HotSet(() => clock);

    set.record({ protocol: 'tinyman', kpi: 'tvl', params: { basis: 'verified_only' } });
    expect(set.recent()).toHaveLength(1);

    clock += HOT_WINDOW_MS - 1_000;
    expect(set.recent()).toHaveLength(1);

    clock += 2_000;
    expect(set.recent()).toHaveLength(0);
    expect(set.size).toBe(0);
  });

  it('keeps a repeatedly-requested key alive', () => {
    let clock = 0;
    const set = new HotSet(() => clock);
    const key = { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS } as const;

    for (let i = 0; i < 10; i++) {
      set.record(key);
      clock += HOT_WINDOW_MS / 2;
    }
    expect(set.recent()).toHaveLength(1);
  });

  it('tracks a non-default basis the matrix does not cover', () => {
    // The reason the recency half is not redundant with the matrix: a bot
    // calling ?basis=verified_only all day asks for a different number under a
    // different key, and without this it is cold on every single call.
    const set = new HotSet();
    set.record({ protocol: 'tinyman', kpi: 'tvl', params: { basis: 'verified_only' } });

    const keys = hotKeys(set).map(describeKey);
    expect(keys).toContain('tinyman/tvl?basis=verified_only');
    expect(keys).toContain('tinyman/tvl?basis=all_pools_usd_priced');
  });

  it('does not refresh the same identity twice in one cycle', () => {
    const set = new HotSet();
    // Already in the matrix.
    set.record({ protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS });

    const ids = hotKeys(set).map(describeKey);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('groupByFetch', () => {
  it('collapses a protocol’s KPIs into one fetch per (protocol, basis)', () => {
    const groups = groupByFetch([
      { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS },
      { protocol: 'tinyman', kpi: 'pool_count', params: DEFAULT_PARAMS },
      { protocol: 'tinyman', kpi: 'tvl', params: { basis: 'verified_only' } },
    ]);

    expect(groups).toHaveLength(2);
    const defaultGroup = groups.find((g) => g.params.basis === DEFAULT_PARAMS.basis);
    // One fetchRaw for both KPIs, not one per KPI — the difference between a
    // 13-second cycle and a 13-second-per-KPI one.
    expect(defaultGroup?.kpis.sort()).toEqual(['pool_count', 'tvl']);
  });
});
