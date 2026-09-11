import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

import { setCacheDeps, type CacheDeps } from '../../src/cache/index.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics } from '../../src/cache/metrics.js';
import { fakeL1, fakeL2, testFact, type FakeL1, type FakeL2 } from '../../src/cache/testing.js';
import { HotSet } from '../../src/cache/hotset.js';
import { ApiError, envelope } from '../../src/errors.js';
import { paymentGate } from '../../src/gate/middleware.js';
import { priceAtomic } from '../../src/pricing.js';
import { compare } from '../../src/routes/compare.js';
import { CACHE_HEADER, METHODOLOGY_HEADER } from '../../src/routes/metric.js';
import {
  composeComparison,
  rankLegs,
  spreadOf,
  worstCacheState,
  type ComparisonLeg,
} from '../../src/standardize/compare.js';
import { KpiFactSchema, type SuccessFact } from '../../src/standardize/schema.js';
import type { KpiId } from '../../src/standardize/kpis.js';
import {
  buildPayment,
  decodePaymentRequired,
  fakeFacilitator,
  fakeLedger,
  gateDeps,
  type FakeFacilitator,
  type FakeLedger,
} from '../gate/helpers.js';

/**
 * `GET /compare` — API_SPEC.md §3.2.
 *
 * Three things are under test, in rising order of how much they matter:
 *
 *  1. The validation and applicability rules, which decide what is even a
 *     request.
 *  2. The composition — ranking, spread, the §5 minimum — which decides what
 *     the answer says.
 *  3. **Which outcomes are worth money.** This handler's status code is the
 *     only input the gate's settle decision has, so the partial-result
 *     boundary is tested in both directions against a real gate and a real
 *     ledger, not by inspecting a status code and trusting the rest.
 */

const VERSION = process.env.METHODOLOGY_VERSION ?? '1.2.0';

/** What the fake upstream will produce, per protocol, for the requested KPIs. */
type Producer = (protocol: string, kpis: readonly KpiId[]) => SuccessFact[];

interface Harness {
  deps: CacheDeps;
  l1: FakeL1;
  l2: FakeL2;
  produce: Producer;
  failing: Set<string>;
}

let h: Harness;
let restore: () => void;

/**
 * A fact for `protocol`/`kpi` with a value chosen by the test.
 *
 * `coverage.basis` defaults to each protocol's real one — Folks reports
 * `total_deposits` where the DEXes report `all_pools_usd_priced` (§3.5) — so a
 * test that does not care about the basis still exercises the mixed-basis path
 * the live service is in.
 */
function factFor(
  protocol: string,
  kpi: KpiId,
  value: number,
  overrides: Partial<SuccessFact> = {},
): SuccessFact {
  const base = testFact({
    protocol,
    metric: kpi,
    value,
    methodology_version: VERSION,
    unit: kpi.endsWith('_24h') || kpi === 'tvl' ? 'USD' : 'RATIO',
    coverage: {
      entities: 25,
      excluded: 0,
      basis: protocol === 'folks' ? 'total_deposits' : 'all_pools_usd_priced',
    },
  });
  return { ...base, ...overrides } as SuccessFact;
}

/** Values for one KPI across protocols, as the default producer. */
function valued(values: Record<string, number>): Producer {
  return (protocol, kpis) =>
    kpis
      .filter((kpi) => values[protocol] !== undefined)
      .map((kpi) => factFor(protocol, kpi, values[protocol] as number));
}

function app(): Hono {
  const a = new Hono();
  a.route('/', compare);
  a.onError((err, c) =>
    err instanceof ApiError
      ? c.json(envelope(err.code, err.message, err.detail), err.status)
      : c.json(envelope('INTERNAL_ERROR', String(err), {}), 500),
  );
  return a;
}

beforeEach(() => {
  const l1 = fakeL1(() => Date.now());
  const l2 = fakeL2();
  h = {
    l1,
    l2,
    produce: valued({ tinyman: 0.0754, pact: 0.041, folks: 0.0196 }),
    failing: new Set<string>(),
    deps: {
      l0: createL0(),
      l1,
      l2,
      metrics: new CacheMetrics(),
      hot: new HotSet(),
      now: Date.now,
      methodologyVersion: VERSION,
      async compute({ protocol, kpis }) {
        if (h.failing.has(protocol)) throw new Error(`${protocol} upstream down`);
        return h.produce(protocol, kpis);
      },
    },
  };
  restore = setCacheDeps(h.deps);
});

afterEach(() => restore());

async function get(query: string) {
  const res = await app().request(`/compare?${query}`);
  return { res, body: (await res.json()) as Record<string, any> };
}

// ---------------------------------------------------------------------------
// §3.2 validation
// ---------------------------------------------------------------------------

describe('validation (§3.2)', () => {
  it('400s TOO_FEW_PROTOCOLS below two', async () => {
    const { res, body } = await get('protocols=tinyman&metric=tvl');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('TOO_FEW_PROTOCOLS');
    expect(body.error.detail.available_protocols).toContain('folks');
  });

  it('400s TOO_MANY_PROTOCOLS above five', async () => {
    const { res, body } = await get('protocols=a,b,c,d,e,f&metric=tvl');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('TOO_MANY_PROTOCOLS');
    expect(body.error.detail.distinct).toHaveLength(6);
  });

  it('404s KPI_NOT_FOUND for a metric outside the §4 registry', async () => {
    const { res, body } = await get('protocols=tinyman,pact&metric=sharpe_ratio');
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('KPI_NOT_FOUND');
    expect(body.error.detail.available_kpis).toContain('capital_efficiency');
  });

  it('404s PROTOCOL_NOT_FOUND naming the unknown id', async () => {
    const { res, body } = await get('protocols=tinyman,uniswap&metric=tvl');
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('PROTOCOL_NOT_FOUND');
    expect(body.error.detail.unknown_protocols).toEqual(['uniswap']);
    expect(body.error.message).toContain('uniswap');
    expect(body.error.detail.available_protocols).toContain('tinyman');
  });

  it('collapses duplicate ids rather than comparing a protocol against itself', async () => {
    // Two ids, one protocol. Ranking Tinyman against Tinyman would produce a
    // spread ratio of exactly 1.0 and a confident-looking non-answer — and it
    // would be SETTLED. Collapsed, it is a free 400 that says what happened.
    const { res, body } = await get('protocols=tinyman,tinyman&metric=tvl');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('TOO_FEW_PROTOCOLS');
    expect(body.error.detail.distinct).toEqual(['tinyman']);
    expect(body.error.detail.note).toContain('not compared against itself');
  });

  it('keeps a duplicate alongside a genuine second protocol', async () => {
    const { res, body } = await get('protocols=tinyman,pact,tinyman&metric=capital_efficiency');
    expect(res.status).toBe(200);
    expect(body.facts.map((f: any) => f.protocol)).toEqual(['tinyman', 'pact']);
    expect(body.ranking).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §3.2 applicability — the capability matrix is genuinely uneven
// ---------------------------------------------------------------------------

describe('KPI applicability across an uneven capability matrix', () => {
  it('take_rate over tinyman+pact+folks: pact declines, two remain, 200 partial', async () => {
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { res, body } = await get('protocols=tinyman,pact,folks&metric=take_rate');

    expect(res.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.excluded_protocols).toEqual(['pact']);
    expect(body.ranking.map((r: any) => r.protocol)).toEqual(['tinyman', 'folks']);

    // Pact is present as a §2 error fact, not silently dropped, and the reason
    // is Pact's disclosure rather than our coverage (§1.5, §3.4).
    const pact = body.facts.find((f: any) => f.protocol === 'pact');
    expect(pact.error.code).toBe('KPI_NOT_APPLICABLE');
    expect(pact.error.message).toMatch(/pact_fee_bps/);
    expect(pact.value).toBeNull();
    expect(pact.confidence).toBe(0);
  });

  it('utilization over tinyman+pact: applies to neither, 422, nothing computed', async () => {
    const { res, body } = await get('protocols=tinyman,pact&metric=utilization');
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('KPI_NOT_APPLICABLE_TO_ANY');
    expect(Object.keys(body.error.detail.reasons)).toEqual(['tinyman', 'pact']);
    // §1.5: never a plausible-looking zero.
    expect(JSON.stringify(body)).not.toContain('"value":0');
  });

  it('capital_efficiency over all three: the flagship case, no exclusions', async () => {
    const { res, body } = await get('protocols=tinyman,pact,folks&metric=capital_efficiency');
    expect(res.status).toBe(200);
    expect(body.partial).toBe(false);
    expect(body.excluded_protocols).toEqual([]);
    expect(body.ranking).toHaveLength(3);
    expect(body.unit).toBe('RATIO');
  });

  it('volume_24h over the two DEXes plus folks: dex-only, folks excluded', async () => {
    const { res, body } = await get('protocols=tinyman,pact,folks&metric=volume_24h');
    expect(res.status).toBe(200);
    expect(body.excluded_protocols).toEqual(['folks']);
    const folks = body.facts.find((f: any) => f.protocol === 'folks');
    expect(folks.error.code).toBe('KPI_NOT_APPLICABLE');
  });

  it('does not 422 when the metric applies to SOME leg, even if too few resolve', async () => {
    // Guards the 422/502 split against reading "applies to fewer than all" as
    // "applies to none". `utilization` is lending-only: Folks answers it and
    // Tinyman cannot. That is one resolved leg, which is not a comparison — so
    // it is INSUFFICIENT_DATA, and specifically NOT
    // KPI_NOT_APPLICABLE_TO_ANY, because it did apply to one of them. Both are
    // unsettled, but a caller fixes them differently: one by asking for a
    // different metric, the other by retrying or adding a lending protocol.
    h.produce = valued({ folks: 0.3371 });
    const { res, body } = await get('protocols=folks,tinyman&metric=utilization');
    expect(res.status).toBe(502);
    expect(body.error.code).toBe('INSUFFICIENT_DATA');
    expect(body.error.code).not.toBe('KPI_NOT_APPLICABLE_TO_ANY');
    expect(body.error.detail.resolved).toBe(1);
  });

  it('422 is reserved for the case where NOTHING could have been computed', async () => {
    // Same metric, but now no requested protocol can ever answer it. Nothing
    // was fetched, so there is nothing to retry.
    const { res, body } = await get('protocols=tinyman,pact&metric=supply_apr');
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('KPI_NOT_APPLICABLE_TO_ANY');
  });
});

// ---------------------------------------------------------------------------
// §5 composite confidence
// ---------------------------------------------------------------------------

describe('composite confidence is the MINIMUM (§5)', () => {
  it('takes the minimum, and would fail under a mean implementation', async () => {
    // 0.95 and 0.45. The mean is 0.70 — which lands exactly on §5's
    // "directionally sound" rung and hides the weak leg. The minimum is 0.45,
    // which is "informational" and is the truth. These two numbers are chosen
    // so a mean implementation cannot pass this test.
    h.produce = (protocol, kpis) =>
      kpis.map((kpi) =>
        factFor(protocol, kpi, protocol === 'tinyman' ? 0.0754 : 0.0196, {
          confidence: protocol === 'tinyman' ? 0.95 : 0.45,
        }),
      );

    const { res, body } = await get('protocols=tinyman,folks&metric=capital_efficiency');
    expect(res.status).toBe(200);
    expect(body.comparability.confidence).toBe(0.45);
    expect(body.comparability.confidence).not.toBe(0.7);
    expect(body.comparability.note).toContain('MINIMUM');
  });

  it('ignores the zero confidence of an excluded leg', async () => {
    // An error fact carries confidence 0 by construction (§2). Folding it into
    // the minimum would make every partial comparison read as worthless rather
    // than as narrower.
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { body } = await get('protocols=tinyman,pact,folks&metric=take_rate');
    expect(body.partial).toBe(true);
    expect(body.comparability.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Caveats — generated, not decorative
// ---------------------------------------------------------------------------

describe('comparability.caveats are generated (§3.2)', () => {
  it('names both classes AND the §3.1 basis when legs span protocol classes', async () => {
    const { body } = await get('protocols=tinyman,folks&metric=capital_efficiency');
    const caveat = body.comparability.caveats.find((c: string) => c.includes('class'));

    expect(caveat).toBeDefined();
    // Both classes, named.
    expect(caveat).toContain("tinyman is class 'dex'");
    expect(caveat).toContain("folks is class 'lending'");
    // And WHY that is nonetheless comparable — the part that is the product.
    expect(caveat).toContain('capital_efficiency is comparable because');
    expect(caveat).toContain('gross_fees');
    expect(caveat).toContain('swap fees paid by traders');
    expect(caveat).toContain('interest paid by borrowers');
  });

  it('groups protocols of the same class rather than repeating the class', async () => {
    const { body } = await get('protocols=tinyman,pact,folks&metric=capital_efficiency');
    const caveat = body.comparability.caveats.find((c: string) => c.includes('class'));
    expect(caveat).toContain("tinyman and pact are class 'dex'");
    expect(caveat).toContain("folks is class 'lending'");
  });

  it('emits no cross-class caveat when every leg is the same class', async () => {
    const { body } = await get('protocols=tinyman,pact&metric=capital_efficiency');
    expect(body.comparability.caveats.some((c: string) => c.includes("class 'dex'"))).toBe(false);
  });

  const basisCaveat = (body: any): string | undefined =>
    body.comparability.caveats.find((c: string) => c.includes('coverage basis'));

  it('caveats a differing coverage.basis, naming both bases', async () => {
    // Folks reports `total_deposits`; the DEXes report `all_pools_usd_priced`.
    // This is the difference that made our Folks TVL read 52% above DefiLlama
    // until it was restated as deposits minus borrows (§3.5).
    const { body } = await get('protocols=tinyman,folks&metric=tvl');
    const caveat = basisCaveat(body);

    expect(caveat).toBeDefined();
    expect(caveat).toContain("tinyman is measured on 'all_pools_usd_priced'");
    expect(caveat).toContain("folks is measured on 'total_deposits'");
    // For tvl the basis IS the value, so the caveat says exactly that.
    expect(caveat).toContain('the value itself');
    expect(caveat).toContain('currently lent out');
  });

  it('tells a caller the basis lands in the DENOMINATOR for a tvl-divided KPI', async () => {
    const { body } = await get('protocols=tinyman,folks&metric=capital_efficiency');
    const caveat = basisCaveat(body);
    expect(caveat).toContain('divides by that quantity');
    expect(caveat).toContain('denominator');
    // The numerator is fine, and saying so is what keeps the caveat useful
    // rather than merely alarming.
    expect(caveat).toContain('numerator is defined identically');
  });

  it('does NOT claim a definitional gap for a dimensionless ratio of flows', async () => {
    // The regression this guards. `take_rate` is protocol_revenue / gross_fees,
    // both over the same entity set within each protocol, so a basis
    // difference changes the POPULATION, not the meaning. Claiming a
    // definitional gap here would flatly contradict the cross-class caveat
    // sitting directly above it, which says take_rate is comparable precisely
    // because it is dimensionless and needs no conversion. A paid response
    // that argues with itself teaches a caller to trust neither sentence.
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { body } = await get('protocols=tinyman,folks&metric=take_rate');

    const caveat = basisCaveat(body);
    expect(caveat).toBeDefined();
    expect(caveat).toContain('does not change what take_rate means');
    expect(caveat).toContain('population');
    expect(caveat).not.toContain('definitional');
    expect(caveat).not.toContain('denominator');

    // And the two caveats must agree with each other.
    const crossClass = body.comparability.caveats.find((c: string) => c.includes('class'));
    expect(crossClass).toContain('dimensionless');
  });

  it('emits no basis caveat when the legs share one basis', async () => {
    const { body } = await get('protocols=tinyman,pact&metric=tvl');
    expect(body.comparability.caveats.some((c: string) => c.includes('coverage basis'))).toBe(false);
  });

  it('names an estimated leg and its estimation_method (§1.2)', async () => {
    h.produce = (protocol, kpis) =>
      kpis.map((kpi) =>
        factFor(protocol, kpi, protocol === 'tinyman' ? 0.0754 : 0.0196, {
          is_estimated: protocol === 'folks',
          estimation_method: protocol === 'folks' ? 'annualized_rate_to_daily_simple' : null,
        }),
      );

    const { body } = await get('protocols=tinyman,folks&metric=capital_efficiency');
    const caveat = body.comparability.caveats.find((c: string) => c.includes('estimated'));
    expect(caveat).toContain('folks is estimated');
    expect(caveat).toContain('annualized_rate_to_daily_simple');
    // Says what the estimate COSTS, and points somewhere a caller can read.
    expect(caveat).toContain('§5 confidence table');
    expect(caveat).toContain('/methodology');
  });

  it('names a leg below the §5 0.7 informational line', async () => {
    h.produce = (protocol, kpis) =>
      kpis.map((kpi) =>
        factFor(protocol, kpi, 0.05, { confidence: protocol === 'folks' ? 0.55 : 0.95 }),
      );

    const { body } = await get('protocols=tinyman,folks&metric=capital_efficiency');
    const caveat = body.comparability.caveats.find((c: string) => c.includes('confidence 0.55'));
    expect(caveat).toContain('folks');
    expect(caveat).toContain('informational');
  });

  it('gives an uncaveatable comparison no caveats at all', async () => {
    // Two DEXes, same basis, both reported, both high-confidence. Filler
    // caveats here would teach a caller to skip the list, and the next one
    // matters.
    h.produce = (protocol, kpis) =>
      kpis.map((kpi) => factFor(protocol, kpi, protocol === 'tinyman' ? 900 : 400));
    const { body } = await get('protocols=tinyman,pact&metric=volume_24h');
    expect(body.comparability.caveats).toEqual([]);
  });

  it('caveats the partiality itself, naming the excluded protocol and code', async () => {
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { body } = await get('protocols=tinyman,pact,folks&metric=take_rate');
    const caveat = body.comparability.caveats.find((c: string) => c.includes('partial'));
    expect(caveat).toContain('pact (KPI_NOT_APPLICABLE)');
  });
});

// ---------------------------------------------------------------------------
// Ranking and spread
// ---------------------------------------------------------------------------

describe('ranking (§3.2)', () => {
  it('ranks strictly descending and publishes that basis on the response', async () => {
    const { body } = await get('protocols=tinyman,pact,folks&metric=capital_efficiency');
    expect(body.ranking).toEqual([
      { rank: 1, protocol: 'tinyman', value: 0.0754 },
      { rank: 2, protocol: 'pact', value: 0.041 },
      { rank: 3, protocol: 'folks', value: 0.0196 },
    ]);
    // The direction is stated in the paid response, not left to inference.
    expect(body.ranking_basis).toContain('rank 1 is the highest value');
    expect(body.ranking_basis).toContain('implies nothing about which direction is better');
  });

  it('ranks a better-low KPI descending too, since we take no position', async () => {
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { body } = await get('protocols=tinyman,folks&metric=take_rate');
    expect(body.ranking[0]).toEqual({ rank: 1, protocol: 'tinyman', value: 0.248 });
  });

  it('gives tied values the same rank and skips the one after', () => {
    const legs = [
      { protocol: 'a', protocolClass: 'dex', fact: factFor('a', 'tvl', 5) },
      { protocol: 'b', protocolClass: 'dex', fact: factFor('b', 'tvl', 3) },
      { protocol: 'c', protocolClass: 'dex', fact: factFor('c', 'tvl', 3) },
      { protocol: 'd', protocolClass: 'dex', fact: factFor('d', 'tvl', 1) },
    ] as ComparisonLeg[];
    expect(rankLegs(legs as any).map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });
});

describe('spread.ratio never emits Infinity, NaN or a negative', () => {
  const leg = (protocol: string, value: number) =>
    ({ protocol, protocolClass: 'dex', fact: factFor(protocol, 'take_rate', value) }) as ComparisonLeg;

  it('is max/min for ordinary positive values', () => {
    expect(spreadOf([leg('a', 0.0754), leg('b', 0.0196)] as any)).toEqual({
      max: 0.0754,
      min: 0.0196,
      ratio: 3.8469,
    });
  });

  it('is null when min is 0 — the case Pact take_rate actually hit', () => {
    // Pact's take_rate was exactly 0.000000 before it declined the KPI (§3.4).
    const spread = spreadOf([leg('tinyman', 0.248), leg('pact', 0)] as any);
    expect(spread?.min).toBe(0);
    expect(spread?.max).toBe(0.248);
    expect(spread?.ratio).toBeNull();
    expect(Number.isFinite(spread?.ratio as number)).toBe(false);
  });

  it('is null when min is negative rather than emitting a negative ratio', () => {
    const spread = spreadOf([leg('a', 100), leg('b', -20)] as any);
    expect(spread?.ratio).toBeNull();
  });

  it('is exactly 1 for a single distinct value across all legs', () => {
    expect(spreadOf([leg('a', 7), leg('b', 7)] as any)?.ratio).toBe(1);
  });

  it('never serializes Infinity or NaN into a paid response', async () => {
    h.produce = valued({ tinyman: 0.248, folks: 0 });
    const res = await app().request('/compare?protocols=tinyman,folks&metric=take_rate');
    const raw = await res.text();
    expect(raw).not.toContain('Infinity');
    expect(raw).not.toContain('NaN');
    const body = JSON.parse(raw);
    expect(body.spread.ratio).toBeNull();
    expect(body.comparability.caveats.some((c: string) => c.includes('spread.ratio is null'))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Composition invariants
// ---------------------------------------------------------------------------

describe('the composite reports the worst cache state across its legs (§6)', () => {
  it('orders hit < miss < stale', () => {
    const at = (cache: 'hit' | 'miss' | 'stale') =>
      ({ protocol: 'x', protocolClass: 'dex', fact: factFor('x', 'tvl', 1, { cache }) }) as ComparisonLeg;

    expect(worstCacheState([at('hit'), at('hit')] as any)).toBe('hit');
    expect(worstCacheState([at('hit'), at('miss')] as any)).toBe('miss');
    expect(worstCacheState([at('miss'), at('stale')] as any)).toBe('stale');
    expect(worstCacheState([at('stale'), at('hit')] as any)).toBe('stale');
  });

  it('carries that state in the body and the §2.3 header', async () => {
    const { res, body } = await get('protocols=tinyman,pact&metric=capital_efficiency');
    expect(body.cache).toBe('miss');
    expect(res.headers.get(CACHE_HEADER)).toBe('miss');
    expect(res.headers.get(METHODOLOGY_HEADER)).toBe(VERSION);
  });
});

describe('every fact in facts[] is a valid §2 envelope', () => {
  it('validates both the success and the error variants', async () => {
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { body } = await get('protocols=tinyman,pact,folks&metric=take_rate');
    expect(body.facts).toHaveLength(3);
    for (const fact of body.facts) {
      expect(() => KpiFactSchema.parse(fact)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// THE PARTIAL-SETTLE BOUNDARY — against a real gate and a real ledger
// ---------------------------------------------------------------------------

/**
 * API_SPEC.md §3.2's partial-result policy is a payment decision, so it is
 * tested as one: the real `paymentGate` in front of the real handler, with a
 * ledger that records what was written.
 *
 * The two directions are the whole point. Two legs is a usable comparison and
 * is charged for; one leg is a non-answer and is free. Asserting only the
 * status code would leave the actual guarantee — that no USDC moves on the
 * 502 — untested.
 */
describe('the partial-settle boundary, both directions', () => {
  let facilitator: FakeFacilitator;
  let ledger: FakeLedger;

  const PRICE = priceAtomic('/compare', 'base');

  function gatedApp(): Hono {
    const a = new Hono();
    a.use('*', paymentGate(gateDeps(facilitator, ledger)));
    a.route('/', compare);
    a.onError((err, c) =>
      err instanceof ApiError
        ? c.json(envelope(err.code, err.message, err.detail), err.status)
        : c.json(envelope('INTERNAL_ERROR', String(err), {}), 500),
    );
    return a;
  }

  /** Quote, pay, retry — the §2.2 round trip against a given query. */
  async function paidRequest(query: string) {
    const path = `/compare?${query}`;

    const unpaid = await gatedApp().request(path);
    expect(unpaid.status).toBe(402);
    const requirements = decodePaymentRequired(unpaid.headers.get('PAYMENT-REQUIRED')).accepts[0]!;
    expect(requirements.amount).toBe(String(PRICE));

    const payment = buildPayment(requirements);
    const res = await gatedApp().request(path, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });
    return { res, body: (await res.json()) as Record<string, any> };
  }

  beforeEach(() => {
    facilitator = fakeFacilitator();
    ledger = fakeLedger();
  });

  it('2 of 3 legs succeed -> 200 partial, SETTLED, exactly one payments row', async () => {
    h.produce = valued({ tinyman: 0.248, folks: 0.1426 });
    const { res, body } = await paidRequest('protocols=tinyman,pact,folks&metric=take_rate');

    expect(res.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.excluded_protocols).toEqual(['pact']);

    // The caller got a usable comparison, so it paid for one. Once.
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.status).toBe('settled');
    expect(ledger.rows[0]?.amountAtomic).toBe(PRICE);
    expect(ledger.rows[0]?.route).toBe('/compare');
  });

  it('1 of 3 legs succeeds -> 502, NOT settled, no payments row, no USDC moved', async () => {
    // Pact declines take_rate and Folks' upstream is down: one leg left.
    h.failing.add('folks');
    h.produce = valued({ tinyman: 0.248 });

    const { res, body } = await paidRequest('protocols=tinyman,pact,folks&metric=take_rate');

    expect(res.status).toBe(502);
    expect(body.error.code).toBe('INSUFFICIENT_DATA');
    expect(body.error.detail.resolved).toBe(1);
    expect(body.error.detail.required).toBe(2);
    expect(body.error.message).toContain('Not charged');

    // The guarantee, stated three ways: settle was never called, no row was
    // written, and the payment the caller signed was never submitted.
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toEqual([]);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();

    // Verify DID run — we do not do unpaid work — which is what makes the
    // absence of settle a policy decision rather than an early exit.
    expect(facilitator.verifyCalls).toHaveLength(1);
  });

  it('422 KPI_NOT_APPLICABLE_TO_ANY is not settled either', async () => {
    const { res, body } = await paidRequest('protocols=tinyman,pact&metric=utilization');
    expect(res.status).toBe(422);
    expect(body.error.code).toBe('KPI_NOT_APPLICABLE_TO_ANY');
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toEqual([]);
  });

  it('a free 400 never reaches the facilitator at all', async () => {
    const res = await gatedApp().request('/compare?protocols=tinyman&metric=tvl');
    // Unpaid: the gate 402s before validation is even reached.
    expect(res.status).toBe(402);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it('prices ?fresh=true at the §3.2 rate, not the flat one', async () => {
    const unpaid = await gatedApp().request('/compare?protocols=tinyman,pact&metric=tvl&fresh=true');
    const requirements = decodePaymentRequired(unpaid.headers.get('PAYMENT-REQUIRED')).accepts[0]!;
    expect(requirements.amount).toBe(String(priceAtomic('/compare', 'fresh')));
    expect(Number(requirements.amount)).toBeGreaterThan(PRICE);
  });
});

// ---------------------------------------------------------------------------
// Composition unit tests that do not need a route
// ---------------------------------------------------------------------------

describe('composeComparison', () => {
  it('keeps facts[] in the order the caller requested, failures included', () => {
    const legs: ComparisonLeg[] = [
      { protocol: 'tinyman', protocolClass: 'dex', fact: factFor('tinyman', 'tvl', 5) },
      {
        protocol: 'pact',
        protocolClass: 'dex',
        fact: {
          metric: 'tvl',
          protocol: 'pact',
          value: null,
          unit: null,
          timestamp: '2026-09-09T12:00:00.000Z',
          error: { code: 'UPSTREAM_UNAVAILABLE', message: 'api.pact.fi timed out' },
          confidence: 0,
          methodology_version: VERSION,
        },
      },
      { protocol: 'folks', protocolClass: 'lending', fact: factFor('folks', 'tvl', 3) },
    ];

    const out = composeComparison(legs, {
      metric: 'tvl',
      methodologyVersion: VERSION,
      timestamp: '2026-09-09T12:00:00.000Z',
    });

    expect(out.facts.map((f) => f.protocol)).toEqual(['tinyman', 'pact', 'folks']);
    expect(out.excluded_protocols).toEqual(['pact']);
    expect(out.partial).toBe(true);
    expect(out.ranking.map((r) => r.protocol)).toEqual(['tinyman', 'folks']);
    expect(out.unit).toBe('USD');
  });
});
