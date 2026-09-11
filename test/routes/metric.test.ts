import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

import { setCacheDeps, writeFacts, type CacheDeps } from '../../src/cache/index.js';
import { DEFAULT_PARAMS } from '../../src/cache/keys.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics } from '../../src/cache/metrics.js';
import { fakeL1, fakeL2, testFact, type FakeL1, type FakeL2 } from '../../src/cache/testing.js';
import { HotSet } from '../../src/cache/hotset.js';
import { ApiError, envelope } from '../../src/errors.js';
import {
  CACHE_HEADER,
  METHODOLOGY_HEADER,
  MIN_BILLABLE_CONFIDENCE,
  metric,
  resolveTarget,
  unsellable,
} from '../../src/routes/metric.js';
import { KpiFactSchema, makeErrorFact, type SuccessFact } from '../../src/standardize/schema.js';
import { ttlSecondsFor } from '../../src/standardize/kpis.js';

/**
 * `GET /metric/{protocol}/{kpi}` — API_SPEC.md §3.1.
 *
 * The gate is deliberately absent here: what is under test is which outcomes
 * this handler calls a success, because that status code is the only input the
 * gate's settle decision has. `test/gate/middleware.test.ts` covers the other
 * half — that a non-2xx is never settled.
 */

const VERSION = '1.1.0';

interface Harness {
  deps: CacheDeps;
  l1: FakeL1;
  l2: FakeL2;
  produce: SuccessFact[];
  failFetch: boolean;
  offsetMs: number;
}

let h: Harness;
let restore: () => void;

function app(): Hono {
  const a = new Hono();
  a.route('/', metric);
  a.onError((err, c) =>
    err instanceof ApiError
      ? c.json(envelope(err.code, err.message, err.detail), err.status)
      : c.json(envelope('INTERNAL_ERROR', String(err), {}), 500),
  );
  return a;
}

beforeEach(() => {
  const l1 = fakeL1(() => Date.now() + h.offsetMs);
  const l2 = fakeL2();
  h = {
    l1,
    l2,
    produce: [testFact()],
    failFetch: false,
    offsetMs: 0,
    deps: {
      l0: createL0(),
      l1,
      l2,
      metrics: new CacheMetrics(),
      hot: new HotSet(),
      now: () => Date.now() + h.offsetMs,
      methodologyVersion: VERSION,
      async compute() {
        if (h.failFetch) throw new Error('upstream down');
        return h.produce;
      },
    },
  };
  restore = setCacheDeps(h.deps);
});

afterEach(() => restore());

describe('path validation against the connector registry (§3.1)', () => {
  it('404s an unknown protocol with the list of protocols we do cover', async () => {
    const res = await app().request('/metric/uniswap/tvl');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('PROTOCOL_NOT_FOUND');
    expect(body.error.detail.available_protocols).toContain('tinyman');
  });

  it('404s an unknown KPI with the KPIs this protocol publishes', async () => {
    const res = await app().request('/metric/tinyman/nonexistent_kpi');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('KPI_NOT_FOUND');
    expect(body.error.detail.available_kpis).toContain('tvl');
  });

  it('404s KPI_NOT_APPLICABLE with the class and its applicable KPIs', async () => {
    // `utilization` is a real KPI, defined for lending, not for a DEX.
    const res = await app().request('/metric/tinyman/utilization');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('KPI_NOT_APPLICABLE');
    expect(body.error.detail.protocol_class).toBe('dex');
    expect(body.error.detail.available_kpis).toContain('tvl');
    expect(body.error.detail.available_kpis).not.toContain('utilization');
    // §1.5: never a plausible-looking zero.
    expect(JSON.stringify(body)).not.toContain('"value":0');
  });

  it('404s a DELIBERATELY DECLINED KPI with the reason, not a bare not-found', async () => {
    // Pact declines take_rate: `pact_fee_bps` is null on every pool, so the
    // numerator does not exist (DATA_SCHEMA.md §3.4). take_rate IS applicable
    // to a `dex`, so KPI_NOT_FOUND would read as a hole in our coverage rather
    // than a hole in Pact's disclosure — which is the whole point of §1.5's
    // "decline loudly".
    const res = await app().request('/metric/pact/take_rate');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('KPI_NOT_APPLICABLE');
    expect(body.error.detail.declined).toBe(true);
    expect(body.error.message).toMatch(/pact_fee_bps/);
    expect(body.error.detail.available_kpis).toContain('gross_fees_24h');
    expect(body.error.detail.available_kpis).not.toContain('take_rate');
    // §1.5: never a plausible-looking zero.
    expect(JSON.stringify(body)).not.toContain('"value":0');
  });

  it('distinguishes the three 404s at the function level', () => {
    expect(() => resolveTarget('nope', 'tvl', 'all_pools_usd_priced')).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_NOT_FOUND' }),
    );
    expect(() => resolveTarget('tinyman', 'utilization', 'all_pools_usd_priced')).toThrow(
      expect.objectContaining({ code: 'KPI_NOT_APPLICABLE' }),
    );
    expect(() => resolveTarget('tinyman', 'not_a_kpi', 'all_pools_usd_priced')).toThrow(
      expect.objectContaining({ code: 'KPI_NOT_FOUND' }),
    );
  });
});

describe('query params (§3.1)', () => {
  it('rejects an unknown basis', async () => {
    const res = await app().request('/metric/tinyman/tvl?basis=whatever');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_PARAM');
    expect(body.error.detail.allowed).toContain('all_pools_usd_priced');
  });

  it('rejects a non-boolean fresh', async () => {
    const res = await app().request('/metric/tinyman/tvl?fresh=maybe');
    expect(res.status).toBe(400);
    expect((await res.json()).error.detail.param).toBe('fresh');
  });

  it('accepts a supported basis', async () => {
    const res = await app().request('/metric/tinyman/tvl?basis=all_pools_usd_priced');
    expect(res.status).toBe(200);
  });
});

describe('200 — the KpiFact envelope', () => {
  it('returns a schema-valid bare KpiFact with the §2.3 headers', async () => {
    const res = await app().request('/metric/tinyman/tvl');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(() => KpiFactSchema.parse(body)).not.toThrow();
    expect(body.metric).toBe('tvl');
    expect(body.protocol).toBe('tinyman');

    expect(res.headers.get(CACHE_HEADER)).toBe(body.cache);
    expect(res.headers.get(METHODOLOGY_HEADER)).toBe(process.env.METHODOLOGY_VERSION);
  });

  it('labels a cache hit as a hit', async () => {
    const a = app();
    expect((await a.request('/metric/tinyman/tvl')).headers.get(CACHE_HEADER)).toBe('miss');
    expect((await a.request('/metric/tinyman/tvl')).headers.get(CACHE_HEADER)).toBe('hit');
  });
});

describe('502 — outcomes we do not charge for', () => {
  it('502s when every tier is exhausted', async () => {
    h.failFetch = true;
    const res = await app().request('/metric/tinyman/tvl');
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('502s rather than sell a fact at the confidence floor', () => {
    const floored = testFact({ confidence: MIN_BILLABLE_CONFIDENCE });
    const problem = unsellable(floored);
    expect(problem?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(problem?.message).toContain('do not charge');
  });

  it('sells a labelled stale fact above the floor', () => {
    expect(unsellable(testFact({ confidence: 0.49, cache: 'stale', stale: true }))).toBeNull();
  });

  it('treats an error fact as unsellable', () => {
    const fact = makeErrorFact({
      metric: 'tvl',
      protocol: 'tinyman',
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'nope',
      methodologyVersion: VERSION,
      timestamp: new Date().toISOString(),
    });
    expect(unsellable(fact)?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('the ?fresh=true contract (the stampede answer)', () => {
  it('charges for a labelled stale answer at the base price', async () => {
    // Seed L1 and let it go stale, so the next read is a stale-while-revalidate.
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact()], h.deps);
    h.offsetMs = (ttlSecondsFor('tvl') + 1) * 1_000;
    h.failFetch = true;

    const res = await app().request('/metric/tinyman/tvl');

    // 200 — so the gate settles it. The degradation is on the response.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(true);
    expect(body.cache).toBe('stale');
    expect(res.headers.get(CACHE_HEADER)).toBe('stale');
    expect(body.confidence).toBeLessThan(testFact().confidence);
    expect(body.notes.join(' ')).toContain('stale_l1');
  });

  it('502s a ?fresh=true request that could only be answered with a stale number', async () => {
    await writeFacts('tinyman', DEFAULT_PARAMS, [testFact()], h.deps);
    h.offsetMs = (ttlSecondsFor('tvl') + 1) * 1_000;
    h.failFetch = true;
    // A last-known-good snapshot exists, so the fresh request CAN be answered —
    // just not with a fresh number. That is the case the contract is about: not
    // "we have nothing", but "we have something stale and you said no".
    h.l2.seed(
      { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS },
      testFact(),
      new Date(Date.now() - 60_000).toISOString(),
    );

    const res = await app().request('/metric/tinyman/tvl?fresh=true');

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.error.message.toLowerCase()).toContain('not charged');
  });
});
