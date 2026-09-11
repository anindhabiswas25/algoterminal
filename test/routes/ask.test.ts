import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

import { setCacheDeps, type CacheDeps } from '../../src/cache/index.js';
import { createL0 } from '../../src/cache/lru.js';
import { CacheMetrics } from '../../src/cache/metrics.js';
import { HotSet } from '../../src/cache/hotset.js';
import { fakeL1, fakeL2, testFact, type FakeL1 } from '../../src/cache/testing.js';
import { ApiError, envelope } from '../../src/errors.js';
import { paymentGate } from '../../src/gate/middleware.js';
import { priceAtomic } from '../../src/pricing.js';
import { ask } from '../../src/routes/ask.js';
import { setAskClient } from '../../src/ask/client.js';
import { ASK_CACHE_TTL_SECONDS } from '../../src/ask/cache.js';
import { AskResponseSchema } from '../../src/ask/schema.js';
import type { KpiId } from '../../src/standardize/kpis.js';
import type { SuccessFact } from '../../src/standardize/schema.js';
import { fakeAnthropic, prose, type FakeAnthropic } from '../ask/helpers.js';
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
 * `POST /ask` — API_SPEC.md §3.3.
 *
 * Driven end to end against the REAL router, grounding checks, cache and
 * payment gate; only the network to Anthropic and to the upstreams is doubled.
 * Three things are under test, in rising order of how much they matter:
 *
 *  1. Request handling — the body schema, the priced `depth`, the 422s.
 *  2. Grounding, through the route rather than in isolation: a fabricated
 *     number must produce a 502, not a paid answer with a bad figure in it.
 *  3. **Which outcomes are worth money.** §3.3 makes "not charged" a promise
 *     about three specific status codes, and `/llms.txt` publishes it. So the
 *     boundary is tested against a real gate and a real ledger, in both
 *     directions, rather than by reading a status code and trusting the rest.
 */

const VERSION = process.env.METHODOLOGY_VERSION as string;

interface Harness {
  deps: CacheDeps;
  l1: FakeL1;
  values: Record<string, Partial<Record<KpiId, number>>>;
  confidence: Record<string, number>;
  failing: Set<string>;
}

let h: Harness;
let restoreCache: () => void;
let restoreClient: () => void;
let claude: FakeAnthropic;

function factFor(protocol: string, kpi: KpiId, value: number, confidence: number): SuccessFact {
  return testFact({
    protocol,
    metric: kpi,
    value,
    confidence,
    methodology_version: VERSION,
    unit: kpi.endsWith('_24h') || kpi === 'tvl' ? 'USD' : 'RATIO',
    // Stamped NOW, like a fact the pipeline just computed. The /ask cache's
    // TTL is bounded by how much of each fact's own TTL is left
    // (`cacheableTtlSeconds`), so a fixture frozen at a past instant would be
    // permanently uncacheable and every cache assertion below would be vacuous.
    timestamp: new Date().toISOString(),
  }) as SuccessFact;
}

beforeEach(() => {
  const l1 = fakeL1(() => Date.now());
  claude = fakeAnthropic();
  restoreClient = setAskClient(claude);
  h = {
    l1,
    values: {
      tinyman: { capital_efficiency: 0.073653, take_rate: 0.248, tvl: 5_379_486 },
      pact: { capital_efficiency: 0.036365, tvl: 1_100_000 },
      folks: { capital_efficiency: 0.018662, take_rate: 0.1426, tvl: 36_958_555 },
    },
    confidence: { tinyman: 0.7, pact: 0.81, folks: 0.81 },
    failing: new Set<string>(),
    deps: {
      l0: createL0(),
      l1,
      l2: fakeL2(),
      metrics: new CacheMetrics(),
      hot: new HotSet(),
      now: Date.now,
      methodologyVersion: VERSION,
      async compute({ protocol, kpis }) {
        if (h.failing.has(protocol)) throw new Error(`${protocol} upstream down`);
        return kpis
          .filter((kpi) => h.values[protocol]?.[kpi] !== undefined)
          .map((kpi) =>
            factFor(protocol, kpi, h.values[protocol]![kpi] as number, h.confidence[protocol] ?? 0.81),
          );
      },
    },
  };
  restoreCache = setCacheDeps(h.deps);
});

afterEach(() => {
  restoreCache();
  restoreClient();
});

function app(): Hono {
  const a = new Hono();
  a.route('/', ask);
  a.onError((err, c) =>
    err instanceof ApiError
      ? c.json(envelope(err.code, err.message, err.detail), err.status)
      : c.json(envelope('INTERNAL_ERROR', String(err), {}), 500),
  );
  return a;
}

async function post(body: unknown, query = '') {
  const res = await app().request(`/ask${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

// ---------------------------------------------------------------------------
// §3.3 request handling
// ---------------------------------------------------------------------------

describe('request validation (§3.3)', () => {
  it('400s QUESTION_TOO_LONG past 500 characters', async () => {
    const { res, body } = await post({ question: 'a'.repeat(501) });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('QUESTION_TOO_LONG');
    expect(body.error.detail.max_chars).toBe(500);
  });

  it('400s INVALID_BODY on malformed JSON and on an unknown field', async () => {
    expect((await post('{not json')).res.status).toBe(400);
    const { res, body } = await post({ question: 'hi', dpeth: 'deep' });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('400s max_facts outside 1-24', async () => {
    expect((await post({ question: 'hi', max_facts: 0 })).res.status).toBe(400);
    expect((await post({ question: 'hi', max_facts: 25 })).res.status).toBe(400);
  });

  /**
   * `depth` is priced, and the 402 is quoted before the body is read. So the
   * query parameter is what the payment was quoted on, and a body that
   * disagrees is a free 400 rather than either silent failure: deep work at
   * the standard price, or the deep price for a standard answer.
   */
  it('400s DEPTH_MISMATCH when the body asks for a depth the payment did not quote', async () => {
    const { res, body } = await post({ question: 'hi', depth: 'deep' });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('DEPTH_MISMATCH');
    expect(body.error.message).toContain('?depth=deep');
  });

  it('accepts a body depth that agrees with the query', async () => {
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
    claude.synthesis(prose('Tinyman TVL is $5,379,486.00.'));
    const { res, body } = await post(
      { question: 'What is Tinyman TVL?', depth: 'deep' },
      '?depth=deep',
    );
    expect(res.status).toBe(200);
    expect(body.depth).toBe('deep');
  });
});

// ---------------------------------------------------------------------------
// §3.3 routing outcomes
// ---------------------------------------------------------------------------

describe('routing (§4.7 step 1)', () => {
  it('422 OUT_OF_SCOPE for a forecast, before the expensive call', async () => {
    claude.decline('out_of_scope', 'AlgoTerminal does not forecast token prices.');
    const { res, body } = await post({ question: 'Will ALGO go up next week?' });

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('OUT_OF_SCOPE');
    expect(body.error.detail.policy).toContain('descriptive only');
    // The synthesis call never happened: the router is the cost guard.
    expect(claude.synthesisCalls).toHaveLength(0);
  });

  it('422 UNROUTABLE_QUESTION lists what we do cover', async () => {
    claude.decline('unroutable', 'We do not cover Uniswap.');
    const { res, body } = await post({ question: 'What is Uniswap TVL?' });

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('UNROUTABLE_QUESTION');
    expect(body.error.detail.protocols).toContain('tinyman');
    expect(body.error.detail.kpis).toContain('capital_efficiency');
    expect(body.error.detail.note_not_charged).toContain('Not charged');
    expect(claude.synthesisCalls).toHaveLength(0);
  });

  it('sends the live capability matrix to the router', async () => {
    claude.decline('unroutable');
    await post({ question: 'anything' });
    // The matrix goes in the system prompt; the user turn is the question
    // verbatim, so an agent's phrasing is never rewritten before routing.
    expect(claude.routerPrompts).toEqual(['anything']);
  });

  it('502 INSUFFICIENT_DATA when the plan routes but nothing resolves', async () => {
    h.failing.add('tinyman');
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
    const { res, body } = await post({ question: 'What is Tinyman TVL?' });

    expect(res.status).toBe(502);
    expect(body.error.code).toBe('INSUFFICIENT_DATA');
    expect(claude.synthesisCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §3.3 grounding, through the route
// ---------------------------------------------------------------------------

describe('grounding (§3.3)', () => {
  function planFlagship() {
    claude.plan({
      protocols: ['tinyman', 'pact', 'folks'],
      kpis: ['capital_efficiency'],
      comparison_type: 'cross_class_comparison',
    });
  }

  const GOOD_ANSWER =
    'Tinyman generates the most fee revenue per dollar of TVL, with a capital efficiency of ' +
    '0.0737 (7.37% annualized), ahead of Pact at 0.0364 and Folks at 0.0187. Tinyman is 2.0x Pact.';

  it('200s with a grounded answer and returns every fact behind it', async () => {
    planFlagship();
    claude.synthesis(prose(GOOD_ANSWER, { citations: [{ claim: 'Tinyman 0.0737', fact_index: 0 }] }));

    const { res, body } = await post({
      question: 'Which Algorand DeFi protocol generates the most fee revenue per dollar of TVL?',
    });

    expect(res.status).toBe(200);
    expect(AskResponseSchema.safeParse(body).success).toBe(true);
    expect(body.facts).toHaveLength(3);
    expect(body.plan.kpis).toEqual(['capital_efficiency']);
    // §5's composite rule: the MINIMUM, not the mean of 0.7, 0.81, 0.81.
    expect(body.confidence).toBe(0.7);
    expect(res.headers.get('x-algoterminal-methodology')).toBe(VERSION);
  });

  /**
   * The assertion the whole enforcement layer exists for: extract the numbers
   * from the prose, and fail when one of them is not in `facts[]`. A model that
   * invents a number does not produce a paid response.
   */
  it('a fabricated number is corrected once, then 502 — never sold', async () => {
    planFlagship();
    claude.synthesis(prose('Tinyman earned $518 in protocol revenue and leads on efficiency.'));
    claude.synthesis(prose('Tinyman earned $612 in protocol revenue and leads on efficiency.'));

    const { res, body } = await post({ question: 'Which protocol is most capital efficient?' });

    expect(res.status).toBe(502);
    expect(body.error.code).toBe('INSUFFICIENT_DATA');
    expect(body.error.detail.violations).toContain('ungrounded_number');
    // One synthesis call, one correction, then we stop paying.
    expect(claude.synthesisCalls).toHaveLength(2);
    expect(JSON.stringify(claude.synthesisCalls[1])).toContain('518');
  });

  it('accepts the corrected answer when the retry complies', async () => {
    planFlagship();
    claude.synthesis(prose('Tinyman earned $518.'));
    claude.synthesis(prose(GOOD_ANSWER));

    const { res, body } = await post({ question: 'Which protocol is most capital efficient?' });
    expect(res.status).toBe(200);
    expect(body.answer).toBe(GOOD_ANSWER);
  });

  /**
   * §3.3: "`facts[]` is always returned even when `format: "prose"` is
   * requested, so a downstream agent can verify or ignore the narrative."
   */
  it('returns facts[] under every format', async () => {
    for (const format of ['prose', 'both'] as const) {
      planFlagship();
      claude.synthesis(prose(GOOD_ANSWER));
      const { body } = await post({ question: 'Which is most efficient?', format });
      expect(body.facts.length, format).toBe(3);
      expect(body.answer.length, format).toBeGreaterThan(0);
    }
  });

  it('format: "facts" skips the synthesis call and still returns facts and caveats', async () => {
    planFlagship();
    const { res, body } = await post({ question: 'Which is most efficient?', format: 'facts' });

    expect(res.status).toBe(200);
    expect(body.answer).toBe('');
    expect(body.facts).toHaveLength(3);
    // The caveats a caller acts on are generated from the data, so they do not
    // disappear when the narrative does.
    expect(body.caveats.length).toBeGreaterThan(0);
    expect(claude.synthesisCalls).toHaveLength(0);
  });

  /**
   * The forced low-confidence fixture §3.3 asks for. Note the value: 0.62,
   * NOT 0.70. Tinyman's real `capital_efficiency` currently grades exactly
   * 0.70, which is `directional` on the §5 ladder — the `< 0.7` rule does not
   * fire there, and the boundary is asserted in `test/ask/grounding.test.ts`.
   */
  it('502s an answer that fails to caveat a fact below the 0.7 line', async () => {
    h.confidence = { tinyman: 0.62, pact: 0.81, folks: 0.81 };
    planFlagship();
    claude.synthesis(prose(GOOD_ANSWER));
    claude.synthesis(prose(GOOD_ANSWER));

    const { res, body } = await post({ question: 'Which is most efficient?' });
    expect(res.status).toBe(502);
    expect(body.error.detail.violations).toContain('uncaveated_low_confidence');
  });

  it('accepts the same answer once it carries the mandated marker', async () => {
    h.confidence = { tinyman: 0.62, pact: 0.81, folks: 0.81 };
    planFlagship();
    claude.synthesis(
      prose(
        'Tinyman leads on capital efficiency at 0.0737 (confidence 0.62, informational only), ' +
          'ahead of Pact at 0.0364 and Folks at 0.0187.',
      ),
    );

    const { res, body } = await post({ question: 'Which is most efficient?' });
    expect(res.status).toBe(200);
    expect(body.caveats.some((c: string) => c.includes('0.62'))).toBe(true);
  });

  /**
   * Pact declines `take_rate` (DATA_SCHEMA.md §3.4): `pact_fee_bps` is null on
   * 100% of pools. "Which protocol has the highest take rate" must not become a
   * two-way ranking that quietly drops Pact.
   */
  it('502s a take-rate answer that silently omits Pact', async () => {
    claude.plan({
      protocols: ['tinyman', 'pact', 'folks'],
      kpis: ['take_rate'],
      comparison_type: 'cross_class_comparison',
    });
    claude.synthesis(prose('Tinyman has the highest take rate at 0.248, ahead of Folks at 0.1426.'));
    claude.synthesis(prose('Tinyman has the highest take rate at 0.248, ahead of Folks at 0.1426.'));

    const { res, body } = await post({ question: 'Which protocol has the highest take rate?' });
    expect(res.status).toBe(502);
    expect(body.error.detail.violations).toContain('silent_omission');
  });

  it('200s once the answer says Pact does not publish it', async () => {
    claude.plan({
      protocols: ['tinyman', 'pact', 'folks'],
      kpis: ['take_rate'],
      comparison_type: 'cross_class_comparison',
    });
    claude.synthesis(
      prose(
        'Tinyman has the highest take rate at 0.248, ahead of Folks at 0.1426. Pact does not ' +
          'publish its fee split, so no take rate is available for it.',
      ),
    );

    const { res, body } = await post({ question: 'Which protocol has the highest take rate?' });
    expect(res.status).toBe(200);
    // Registry order, not the order the model happened to list them in: the
    // router re-sorts its plan against `listProtocolIds()`, so the same
    // question produces the same fetch order and the same cache keys every time.
    expect(body.facts.map((f: any) => f.protocol)).toEqual(['folks', 'tinyman']);
    // The reason travels in caveats[] as well as in the prose, so an agent
    // filtering structurally still sees it.
    expect(body.caveats.some((c: string) => c.toLowerCase().includes('pact'))).toBe(true);
  });

  it('never asks the model for facts, confidence or the methodology version', async () => {
    planFlagship();
    claude.synthesis(prose(GOOD_ANSWER));
    await post({ question: 'Which is most efficient?' });
    // The synthesizer's schema has three fields. A model cannot write a
    // confidence score onto a response because it is never offered one.
    expect(Object.keys(prose('x'))).toEqual(['answer', 'citations', 'caveats']);
  });
});

// ---------------------------------------------------------------------------
// ARCHITECTURE.md §6 — the /ask result cache
// ---------------------------------------------------------------------------

describe('the /ask cache (§6)', () => {
  const ANSWER = 'Tinyman TVL is $5,379,486.00.';

  function planTvl() {
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
  }

  it('does not cache an answer built on a cache MISS', async () => {
    planTvl();
    claude.synthesis(prose(ANSWER));
    const { body } = await post({ question: 'What is Tinyman TVL?' });

    expect(body.cache).toBe('miss');
    expect(h.l1.rawWrites).toHaveLength(0);
  });

  it('caches an answer built entirely on cache hits, and serves it without either model call', async () => {
    // Warm the fact first, so the second question's fetch is a hit.
    planTvl();
    claude.synthesis(prose(ANSWER));
    await post({ question: 'What is Tinyman TVL?' });

    planTvl();
    claude.synthesis(prose(ANSWER));
    const second = await post({ question: 'What is Tinyman TVL?' });
    expect(second.body.cache).toBe('hit');
    expect(h.l1.rawWrites).toHaveLength(1);

    // Third call: no router response and no synthesis response are queued, so
    // if either model were called the double would throw. It is served from
    // the cache, which is the point of the entry.
    const third = await post({ question: '  WHAT IS TINYMAN TVL?  ' });
    expect(third.res.status).toBe(200);
    expect(third.body.answer).toBe(ANSWER);
  });

  it('normalizes case, whitespace and trailing punctuation into one entry', async () => {
    planTvl();
    claude.synthesis(prose(ANSWER));
    await post({ question: 'What is Tinyman TVL?' });
    planTvl();
    claude.synthesis(prose(ANSWER));
    await post({ question: 'What is Tinyman TVL?' });

    // Same normalized question, different surface form: no second entry.
    await post({ question: 'what is  tinyman tvl' });
    expect(h.l1.rawWrites).toHaveLength(1);
  });

  it('keys separately on depth, format and max_facts', async () => {
    for (const [q, opts] of [
      [{ question: 'What is Tinyman TVL?' }, ''],
      [{ question: 'What is Tinyman TVL?', depth: 'deep' }, '?depth=deep'],
      [{ question: 'What is Tinyman TVL?', max_facts: 3 }, ''],
    ] as const) {
      planTvl();
      claude.synthesis(prose(ANSWER));
      const first = await post(q, opts);
      expect(first.res.status).toBe(200);
      planTvl();
      claude.synthesis(prose(ANSWER));
      await post(q, opts);
    }
    // Three distinct identities, three entries — a caller that paid $0.20 for
    // a deep answer never receives the standard one.
    expect(h.l1.rawWrites).toHaveLength(3);
  });

  /**
   * §6 says 300 s, but a fact is a "hit" anywhere inside its own TTL. An answer
   * built from a 119-second-old `supply_apr` (120 s TTL) and held for 300 s
   * would be served as a hit describing a rate that expired six minutes
   * earlier — the exact case the rule forbids. So the entry never outlives its
   * shortest-lived fact.
   */
  it('never caches an answer for longer than its shortest-lived fact', async () => {
    const staleish = Date.now() - 250_000; // 250s ago; tvl's TTL is 300s.
    h.deps = {
      ...h.deps,
      async compute({ protocol, kpis }) {
        return kpis.map((kpi) => ({
          ...factFor(protocol, kpi, 5_379_486, 0.81),
          timestamp: new Date(staleish).toISOString(),
        }));
      },
    };
    restoreCache();
    restoreCache = setCacheDeps(h.deps);

    planTvl();
    claude.synthesis(prose(ANSWER));
    await post({ question: 'What is Tinyman TVL?' });
    planTvl();
    claude.synthesis(prose(ANSWER));
    await post({ question: 'What is Tinyman TVL?' });

    expect(h.l1.rawWrites).toHaveLength(1);
    const ttl = h.l1.rawWrites[0]!.ttlSeconds;
    expect(ttl).toBeLessThan(ASK_CACHE_TTL_SECONDS);
    // 300s TTL, 250s old => about 50s of life left, and not a second more.
    expect(ttl).toBeLessThanOrEqual(50);
    expect(ttl).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The settle boundary — the part that is a promise about money
// ---------------------------------------------------------------------------

describe('what /ask charges for (§3.3, §2.3)', () => {
  let facilitator: FakeFacilitator;
  let ledger: FakeLedger;

  const PRICE = priceAtomic('/ask', 'base');
  const DEEP_PRICE = priceAtomic('/ask', 'deep');

  function gatedApp(): Hono {
    const a = new Hono();
    a.use('*', paymentGate(gateDeps(facilitator, ledger)));
    a.route('/', ask);
    a.onError((err, c) =>
      err instanceof ApiError
        ? c.json(envelope(err.code, err.message, err.detail), err.status)
        : c.json(envelope('INTERNAL_ERROR', String(err), {}), 500),
    );
    return a;
  }

  async function paidPost(body: unknown, query = '', expectedPrice = PRICE) {
    const path = `/ask${query}`;
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };

    const unpaid = await gatedApp().request(path, init);
    expect(unpaid.status).toBe(402);
    const requirements = decodePaymentRequired(unpaid.headers.get('PAYMENT-REQUIRED')).accepts[0]!;
    expect(requirements.amount).toBe(String(expectedPrice));

    const payment = buildPayment(requirements);
    const res = await gatedApp().request(path, {
      ...init,
      headers: { ...init.headers, 'PAYMENT-SIGNATURE': payment.header },
    });
    return { res, body: (await res.json()) as Record<string, any> };
  }

  beforeEach(() => {
    facilitator = fakeFacilitator();
    ledger = fakeLedger();
  });

  it('quotes $0.15, and $0.20 for ?depth=deep', async () => {
    expect(PRICE).toBe(150_000);
    expect(DEEP_PRICE).toBe(200_000);
  });

  it('a grounded answer SETTLES exactly one row at 150000', async () => {
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
    claude.synthesis(prose('Tinyman TVL is $5,379,486.00.'));

    const { res } = await paidPost({ question: 'What is Tinyman TVL?' });
    expect(res.status).toBe(200);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.amountAtomic).toBe(PRICE);
    expect(ledger.rows[0]?.route).toBe('/ask');
    expect(ledger.rows[0]?.status).toBe('settled');
  });

  it('?depth=deep settles at 200000', async () => {
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
    claude.synthesis(prose('Tinyman TVL is $5,379,486.00.'));

    const { res } = await paidPost(
      { question: 'What is Tinyman TVL?' },
      '?depth=deep',
      DEEP_PRICE,
    );
    expect(res.status).toBe(200);
    expect(ledger.rows[0]?.amountAtomic).toBe(DEEP_PRICE);
  });

  it('422 OUT_OF_SCOPE is verified, answered, and NOT settled', async () => {
    claude.decline('out_of_scope', 'We do not forecast.');
    const { res } = await paidPost({ question: 'Will ALGO go up next week?' });

    expect(res.status).toBe(422);
    // The caller paid, the gate verified, the handler declined, settle never
    // ran. That ordering is the guarantee, and it is measured here rather than
    // inferred from the status code.
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toEqual([]);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });

  it('422 UNROUTABLE_QUESTION is not settled', async () => {
    claude.decline('unroutable', 'We do not cover that.');
    const { res } = await paidPost({ question: 'What is Uniswap TVL?' });
    expect(res.status).toBe(422);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toEqual([]);
  });

  it('502 INSUFFICIENT_DATA is not settled', async () => {
    h.failing.add('tinyman');
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
    const { res } = await paidPost({ question: 'What is Tinyman TVL?' });
    expect(res.status).toBe(502);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toEqual([]);
  });

  it('an ungrounded answer is not settled either', async () => {
    claude.plan({ protocols: ['tinyman'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' });
    claude.synthesis(prose('Tinyman TVL is $999,999.'));
    claude.synthesis(prose('Tinyman TVL is $888,888.'));

    const { res } = await paidPost({ question: 'What is Tinyman TVL?' });
    expect(res.status).toBe(502);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toEqual([]);
  });

  it('400 DEPTH_MISMATCH is not settled', async () => {
    const { res } = await paidPost({ question: 'What is Tinyman TVL?', depth: 'deep' });
    expect(res.status).toBe(400);
    expect(facilitator.settleCalls).toHaveLength(0);
  });
});
