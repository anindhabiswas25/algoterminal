import { describe, expect, it } from 'vitest';

import {
  FROZEN_NOW,
  makeContext,
  makeFakeConnector,
  makePriceTable,
  makeSnapshot,
  stubHttp,
} from '../../src/connectors/testing.js';
import { priceOf, type ToFactsOpts } from '../../src/connectors/types.js';
import { KpiFactSchema } from '../../src/standardize/schema.js';
import { DEFAULT_BASIS } from '../../src/standardize/types.js';

/**
 * CONNECTOR_GUIDE.md §1 — the fetchRaw / toFacts split is the load-bearing
 * decision, and these are the tests that make it load-bearing rather than
 * aspirational.
 */

function opts(overrides: Partial<ToFactsOpts> = {}): ToFactsOpts {
  return {
    basis: DEFAULT_BASIS,
    kpis: ['tvl', 'volume_24h', 'pool_count'],
    prices: makePriceTable({ 0: 0.18, 31566704: 1 }),
    now: FROZEN_NOW,
    methodologyVersion: '1.1.0',
    ...overrides,
  };
}

describe('toFacts output validates against the step-2 KpiFactSchema', () => {
  it('every fact parses', () => {
    const facts = makeFakeConnector().toFacts(makeSnapshot(), opts());
    expect(facts).toHaveLength(3);
    for (const fact of facts) {
      expect(() => KpiFactSchema.parse(fact), fact.metric).not.toThrow();
    }
  });

  it('produces a fact for every declared KPI that was requested (capability honesty)', () => {
    const connector = makeFakeConnector();
    const facts = connector.toFacts(makeSnapshot(), opts());
    expect(facts.map((f) => f.metric)).toEqual([...connector.capabilities().kpis]);
  });

  it('omits a KPI entirely rather than returning a zero for it (§1.5)', () => {
    const facts = makeFakeConnector().toFacts(makeSnapshot(), opts({ kpis: ['tvl'] }));
    expect(facts.map((f) => f.metric)).toEqual(['tvl']);
    expect(facts.some((f) => f.value === 0)).toBe(false);
  });

  it('stamps the injected timestamp and methodology version, not a real clock', () => {
    const facts = makeFakeConnector().toFacts(
      makeSnapshot(),
      opts({ now: '2020-01-01T00:00:00.000Z', methodologyVersion: '2.1.0' }),
    );
    for (const fact of facts) {
      expect(fact.timestamp).toBe('2020-01-01T00:00:00.000Z');
      expect(fact.methodology_version).toBe('2.1.0');
      expect(fact.as_of).toBe(FROZEN_NOW);
    }
  });

  it('carries the snapshot provenance onto every fact (§1.4)', () => {
    for (const fact of makeFakeConnector().toFacts(makeSnapshot(), opts())) {
      expect(fact.source?.[0]?.url).toBe('https://api.fake.test/pools?limit=200&offset=0');
    }
  });
});

describe('toFacts is pure', () => {
  it('two calls on the same snapshot are byte-identical', () => {
    const connector = makeFakeConnector();
    const snapshot = makeSnapshot();
    const a = JSON.stringify(connector.toFacts(snapshot, opts()));
    const b = JSON.stringify(connector.toFacts(snapshot, opts()));
    expect(a).toBe(b);
  });

  it('stays identical across a delay, so no real clock leaked in', async () => {
    const connector = makeFakeConnector();
    const snapshot = makeSnapshot();
    const a = JSON.stringify(connector.toFacts(snapshot, opts()));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(JSON.stringify(connector.toFacts(snapshot, opts()))).toBe(a);
  });

  it('does not mutate the snapshot it was handed', () => {
    const snapshot = makeSnapshot();
    const before = JSON.stringify(snapshot);
    makeFakeConnector().toFacts(snapshot, opts());
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('is synchronous, so it cannot await I/O', () => {
    const result = makeFakeConnector().toFacts(makeSnapshot(), opts());
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('is handed nothing it could do I/O with', () => {
    // The type-level guarantee, asserted at runtime: ToFactsOpts carries only
    // inert data — no http, algod, indexer, price service, or clock function.
    const keys = Object.keys(opts()).sort();
    expect(keys).toEqual(['basis', 'kpis', 'methodologyVersion', 'now', 'prices']);
    expect(typeof opts().now).toBe('string');
    for (const value of Object.values(opts())) expect(typeof value).not.toBe('function');
  });
});

describe('fetchRaw is the only side that touches I/O', () => {
  it('is async and receives the context', async () => {
    const ctx = makeContext();
    const snapshot = await makeFakeConnector().fetchRaw(ctx, {
      basis: DEFAULT_BASIS,
      kpis: ['tvl'],
    });
    expect(snapshot.fetchedAt).toBe(FROZEN_NOW);
    expect(snapshot.sources).toHaveLength(1);
  });

  it('produces a snapshot that is a complete, replayable toFacts input', async () => {
    const snapshot = await makeFakeConnector().fetchRaw(makeContext(), {
      basis: DEFAULT_BASIS,
      kpis: ['tvl'],
    });
    // The golden-test unit: recorded snapshot + frozen prices in, facts out.
    expect(JSON.stringify(makeFakeConnector().toFacts(snapshot, opts()))).toBe(
      JSON.stringify(makeFakeConnector().toFacts(JSON.parse(JSON.stringify(snapshot)), opts())),
    );
  });
});

describe('makeContext — the test double every later step leans on', () => {
  it('freezes the clock: ctx.now() is the same instant every call', () => {
    const ctx = makeContext();
    expect(ctx.now().toISOString()).toBe(FROZEN_NOW);
    expect(ctx.now().toISOString()).toBe(ctx.now().toISOString());
  });

  it('hands out a fresh Date, so a connector mutating it cannot corrupt the clock', () => {
    const ctx = makeContext();
    const first = ctx.now();
    first.setFullYear(1999);
    expect(ctx.now().toISOString()).toBe(FROZEN_NOW);
  });

  it('accepts an explicit instant, and rejects an unparseable one', () => {
    expect(makeContext({ now: '2030-06-01T00:00:00.000Z' }).now().toISOString()).toBe(
      '2030-06-01T00:00:00.000Z',
    );
    expect(() => makeContext({ now: 'yesterday' })).toThrow(RangeError);
  });

  it('serves stubbed http from a table and records every call', async () => {
    const http = stubHttp({ 'https://api.fake.test/pools': { results: [], count: 0 } });
    const ctx = makeContext({ http });
    await ctx.http.getJson('https://api.fake.test/pools');
    expect(http.calls).toEqual(['https://api.fake.test/pools']);
  });

  it('throws on an unregistered URL rather than answering with nothing', async () => {
    // A silent null here would produce a snapshot missing half its entities and
    // a green test over a wrong number.
    await expect(makeContext().http.getJson('https://unexpected.test/x')).rejects.toThrow(
      /no response registered/,
    );
  });

  it('stubs algod and indexer with a round, since §4.2 requires one', async () => {
    const ctx = makeContext();
    expect((await ctx.algod.status()).lastRound).toBeGreaterThan(0);
    expect((await ctx.algod.getApplication(1)).round).toBeGreaterThan(0);
    expect((await ctx.indexer.searchTransactions({ applicationId: 1 })).transactions).toEqual([]);
  });

  it('resolves prices through the service, and looks them up as plain data', async () => {
    const table = await makeContext({ priceTable: makePriceTable({ 0: 0.2 }) }).prices.resolve([0]);
    expect(priceOf(table, 0)).toEqual({ usd: 0.2, confidence: 1, source: 'stub' });
    // Unpriced -> null, so §3.6.1 can exclude rather than contribute a zero.
    expect(priceOf(table, 999)).toBeNull();
  });

  it('gives a PriceTable that is plain JSON, so a fixture file can be one', () => {
    const table = makePriceTable({ 0: 0.18 });
    expect(JSON.parse(JSON.stringify(table))).toEqual(table);
  });
});

describe('healthCheck', () => {
  it('defaults to ok and reports a failure detail when given one', async () => {
    const ctx = makeContext();
    expect(await makeFakeConnector().healthCheck(ctx)).toEqual({ ok: true });
    expect(await makeFakeConnector({ health: { ok: false, detail: 'down' } }).healthCheck(ctx)).toEqual(
      { ok: false, detail: 'down' },
    );
  });
});
