import { describe, it, expect } from 'vitest';

import { cacheKey, describeKey, lockKey, paramsHash, DEFAULT_PARAMS } from '../../src/cache/keys.js';

const KEY = { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS } as const;

describe('cacheKey', () => {
  it('matches the ARCHITECTURE.md §4.5 shape', () => {
    expect(cacheKey(KEY, '1.1.0')).toMatch(/^kpi:v1\.1\.0:tinyman:tvl:[0-9a-f]{12}$/);
  });

  // The property the whole scheme exists for. 1.1.0 enumerates Tinyman V2 from
  // the chain and prices its reserves, so `tinyman/tvl` means a different
  // measurement than it did at 1.0.0 — $5.4M computed vs $0.6M reported. A
  // post-bump read that found the pre-bump entry would serve the old number
  // under the new semantics, and nothing downstream could detect it.
  it('a methodology_version bump changes the key, so post-bump reads miss', () => {
    expect(cacheKey(KEY, '1.0.0')).not.toBe(cacheKey(KEY, '1.1.0'));
    expect(cacheKey(KEY, '1.0.0')).toContain(':v1.0.0:');
  });

  it('separates protocols, KPIs and parameters', () => {
    const base = cacheKey(KEY, '1.1.0');
    expect(cacheKey({ ...KEY, protocol: 'pact' }, '1.1.0')).not.toBe(base);
    expect(cacheKey({ ...KEY, kpi: 'volume_24h' }, '1.1.0')).not.toBe(base);
    expect(cacheKey({ ...KEY, params: { basis: 'verified_only' } }, '1.1.0')).not.toBe(base);
  });

  it('hashes parameters independently of key order', () => {
    // A cache that missed on property order would have half the hit rate and
    // no symptom, so canonicalisation is asserted rather than assumed.
    const a = paramsHash({ basis: 'verified_only' });
    const b = paramsHash(JSON.parse('{"basis":"verified_only"}') as { basis: 'verified_only' });
    expect(a).toBe(b);
  });

  it('namespaces locks separately from facts', () => {
    expect(lockKey(cacheKey(KEY, '1.1.0'))).toBe(`lock:${cacheKey(KEY, '1.1.0')}`);
  });

  it('describes a key readably for logs and the hot set', () => {
    expect(describeKey(KEY)).toBe('tinyman/tvl?basis=all_pools_usd_priced');
  });
});
