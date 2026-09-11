import { describe, expect, it } from 'vitest';

import {
  ConnectorRegistryError,
  SLUG_RE,
  assertRegistryValid,
  getConnector,
  hasProtocol,
  listConnectors,
  listProtocolIds,
  registry,
  validateCapabilities,
  validateRegistry,
} from '../../src/connectors/registry.js';
import { FAKE_CAPABILITIES, makeFakeConnector, makeRegistry } from '../../src/connectors/testing.js';
import type { ConnectorCapabilities } from '../../src/connectors/types.js';

/**
 * CONNECTOR_GUIDE.md §Step 3 / §Step 7. The validator's job is to make a
 * connector's declared capabilities incapable of reaching `/catalog` unless
 * they are coherent — an over-claim there is a public promise we break on the
 * first call.
 */

/** `validateCapabilities` on a capabilities object built from the fake's. */
function problemsFor(overrides: Partial<ConnectorCapabilities>, key?: string): string[] {
  const caps = { ...FAKE_CAPABILITIES, ...overrides };
  return validateCapabilities(key ?? caps.id, caps);
}

describe('the live registry', () => {
  it('holds the connectors registered so far, and is coherent', () => {
    // Grows by one line per build step. The assertion is on the CONTENTS, not
    // on a count, so adding Pact at step 7 does not falsify this test.
    expect(listProtocolIds()).toContain('tinyman');
    expect(validateRegistry()).toEqual([]);
    expect(() => assertRegistryValid()).not.toThrow();
  });

  it('answers lookups by the key each connector is registered under', () => {
    expect(getConnector('tinyman')?.capabilities().id).toBe('tinyman');
    expect(hasProtocol('tinyman')).toBe(true);
    expect(getConnector('nope')).toBeUndefined();
    expect(hasProtocol('nope')).toBe(false);
    expect(listConnectors().map((c) => c.capabilities().id)).toEqual(listProtocolIds());
  });
});

describe('registry validation ACCEPTS a coherent connector', () => {
  it('accepts the fake connector', () => {
    expect(validateRegistry(makeRegistry(makeFakeConnector()))).toEqual([]);
  });

  it('accepts active_users_24h when appIds are declared', () => {
    expect(problemsFor({ kpis: ['tvl', 'active_users_24h'], appIds: [552635992] })).toEqual([]);
  });

  it('accepts a lending connector declaring lending-only KPIs', () => {
    expect(
      problemsFor({ id: 'folks', class: 'lending', kpis: ['tvl', 'utilization', 'borrow_apr'] }),
    ).toEqual([]);
  });

  it('accepts hyphenated slugs', () => {
    for (const id of ['tinyman', 'folks', 'pact', 'folks-finance', 'x2', 'a-b-c']) {
      expect(SLUG_RE.test(id), id).toBe(true);
    }
  });
});

describe('deliberate declines (§Step 3)', () => {
  it('accepts a coherent decline', () => {
    expect(
      problemsFor({
        kpis: ['tvl'],
        declined: { take_rate: 'the source does not publish the numerator' },
      }),
    ).toEqual([]);
  });

  it('rejects a KPI that is both declared and declined', () => {
    const problems = problemsFor({
      kpis: ['tvl', 'take_rate'],
      declined: { take_rate: 'a reason long enough to be a real one' },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('and also declines it');
  });

  it('rejects an empty reason — the reason is what makes it loud', () => {
    const problems = problemsFor({ kpis: ['tvl'], declined: { take_rate: '   ' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('empty reason');
  });

  it('rejects declining a KPI the class already excludes', () => {
    // `utilization` on a dex is answered by the class check with a better
    // message; an explicit decline there only obscures it.
    const problems = problemsFor({ kpis: ['tvl'], declined: { utilization: 'not for a dex' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not applicable to class');
  });
});

describe('registry validation REJECTS', () => {
  it('a KPI that is not in the DATA_SCHEMA.md §4 registry', () => {
    // Cast: `kpis` is typed `KpiId[]`, so TypeScript already rejects this. The
    // runtime check is the guard for the untyped boundary.
    const problems = problemsFor({ kpis: ['tvl', 'p_f_ratio' as never] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('p_f_ratio');
    expect(problems[0]).toContain('§4 registry');
  });

  it('a KPI that is not applicable to the declared class', () => {
    // `utilization` is lending-only; on a dex it is the bug that must never
    // reach /catalog, because /metric would answer KPI_NOT_APPLICABLE.
    const problems = problemsFor({ class: 'dex', kpis: ['tvl', 'utilization'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('utilization');
    expect(problems[0]).toContain('not applicable to class "dex"');
  });

  it('a dex-only KPI declared on a lending protocol, symmetrically', () => {
    const problems = problemsFor({ class: 'lending', kpis: ['tvl', 'volume_to_tvl'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('volume_to_tvl');
  });

  it('active_users_24h declared with no appIds', () => {
    const problems = problemsFor({ kpis: ['tvl', 'active_users_24h'] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('active_users_24h');
    expect(problems[0]).toContain('appIds');
  });

  it('active_users_24h declared with an empty appIds array', () => {
    expect(problemsFor({ kpis: ['tvl', 'active_users_24h'], appIds: [] })).toHaveLength(1);
  });

  it('non-integer or negative appIds', () => {
    expect(problemsFor({ kpis: ['tvl', 'active_users_24h'], appIds: [-1] })).toHaveLength(1);
    expect(problemsFor({ kpis: ['tvl', 'active_users_24h'], appIds: [1.5] })).toHaveLength(1);
  });

  it('an id that is not a lowercase slug', () => {
    for (const id of ['Tinyman', 'tiny man', 'tiny_man', '2fast', 'tinyman-', '-tinyman', '']) {
      const problems = problemsFor({ id }, id);
      expect(problems.some((p) => p.includes('lowercase slug')), id).toBe(true);
    }
  });

  it('a Map key that disagrees with capabilities().id', () => {
    const problems = problemsFor({ id: 'tinyman' }, 'tinymam');
    expect(problems.some((p) => p.includes('they must match'))).toBe(true);
  });

  it('a connector declaring no KPIs', () => {
    expect(problemsFor({ kpis: [] }).some((p) => p.includes('declares no KPIs'))).toBe(true);
  });

  it('a duplicated KPI', () => {
    expect(problemsFor({ kpis: ['tvl', 'tvl'] }).some((p) => p.includes('more than once'))).toBe(true);
  });

  it('a connector declaring no sourceHosts', () => {
    expect(problemsFor({ sourceHosts: [] }).some((p) => p.includes('no sourceHosts'))).toBe(true);
  });

  it('a connector that does not support the default basis', () => {
    // A request that omits ?basis= would have no valid handler.
    const problems = problemsFor({ supportsBasis: ['verified_only'] });
    expect(problems.some((p) => p.includes('default basis'))).toBe(true);
  });

  it('an unknown basis', () => {
    expect(
      problemsFor({ supportsBasis: ['all_pools_usd_priced', 'vibes' as never] }).some((p) =>
        p.includes('unknown basis'),
      ),
    ).toBe(true);
  });

  it('an unknown protocol class', () => {
    expect(problemsFor({ class: 'perps' as never }).some((p) => p.includes('§2.2'))).toBe(true);
  });

  it('an empty display name', () => {
    expect(problemsFor({ name: '  ' }).some((p) => p.includes('name is empty'))).toBe(true);
  });
});

describe('failing loud', () => {
  it('reports every problem at once, so a boot failure needs one restart', () => {
    const problems = problemsFor({ class: 'dex', kpis: ['utilization', 'borrow_apr'], sourceHosts: [] });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it('prefixes every problem with the connector id', () => {
    for (const problem of problemsFor({ kpis: ['utilization'], sourceHosts: [] })) {
      expect(problem.startsWith('fake: ')).toBe(true);
    }
  });

  it('assertRegistryValid throws ConnectorRegistryError carrying the problems', () => {
    const bad = makeRegistry(makeFakeConnector({ capabilities: { kpis: ['utilization'] } }));
    expect(() => assertRegistryValid(bad)).toThrow(ConnectorRegistryError);
    try {
      assertRegistryValid(bad);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorRegistryError);
      expect((err as ConnectorRegistryError).problems).toHaveLength(1);
      expect((err as ConnectorRegistryError).message).toContain('refusing to start');
    }
  });
});

describe('listing', () => {
  it('is sorted by id, so /catalog and error payloads are stable', () => {
    const source = makeRegistry(
      makeFakeConnector({ capabilities: { id: 'zebra' } }),
      makeFakeConnector({ capabilities: { id: 'alpha' } }),
      makeFakeConnector({ capabilities: { id: 'mango' } }),
    );
    expect(listProtocolIds(source)).toEqual(['alpha', 'mango', 'zebra']);
    expect(listConnectors(source).map((c) => c.capabilities().id)).toEqual([
      'alpha',
      'mango',
      'zebra',
    ]);
  });
});
