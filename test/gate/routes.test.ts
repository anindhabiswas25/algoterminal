import { describe, it, expect } from 'vitest';
import type { HTTPRequestContext, RouteConfig, RoutesConfig } from '@x402/core/server';

import { networkConstants } from '../../src/config/x402.js';
import {
  buildRoutes,
  CHALLENGE_TAG,
  DISCOVERY_TAGS,
  gatedRoutes,
  matchPaidRoute,
  variantIdForRequest,
  priceFor,
  routeDocs,
  toX402Pattern,
} from '../../src/gate/routes.js';
import { freeRoutes, paidRoutes, priceAtomic, ROUTES } from '../../src/pricing.js';
import { askConfigured } from '../../src/ask/client.js';

/**
 * The property `src/pricing.ts` exists to guarantee: the advertised price and
 * the charged price cannot drift, because they are the same integer.
 *
 * These tests read the middleware's own configuration and compare it to
 * `priceAtomic`. If someone adds a variant to the price table and forgets the
 * gate, or hard-codes an amount in a route config, this fails here rather than
 * in production as a caller charged something we never quoted.
 */

const NET = networkConstants('testnet');
const METRIC = '/metric/{protocol}/{kpi}';

function ctx(path: string, query: Record<string, string> = {}): HTTPRequestContext {
  return {
    path,
    method: 'GET',
    adapter: {
      getHeader: () => undefined,
      getMethod: () => 'GET',
      getPath: () => path,
      getUrl: () => `http://localhost${path}`,
      getAcceptHeader: () => '',
      getUserAgent: () => '',
      getQueryParams: () => query,
      getQueryParam: (name: string) => query[name],
    },
  };
}

function configs(): Record<string, RouteConfig> {
  return buildRoutes(NET) as Record<string, RouteConfig>;
}

describe('pricing.ts is the single source of truth', () => {
  it('charges exactly priceAtomic for every /metric variant', async () => {
    const route = paidRoutes().find((r) => r.path === METRIC)!;

    const cases: [string, HTTPRequestContext][] = [
      ['base', ctx('/metric/tinyman/tvl')],
      ['fresh', ctx('/metric/tinyman/tvl', { fresh: 'true' })],
      ['active_users', ctx('/metric/tinyman/active_users_24h')],
      // Both cost drivers at once: the higher price, never the lower.
      ['active_users', ctx('/metric/tinyman/active_users_24h', { fresh: 'true' })],
    ];

    for (const [variant, context] of cases) {
      expect(variantIdForRequest(route, context.path, (n) => context.adapter.getQueryParam?.(n))).toBe(variant);
      expect(priceFor(route, context)).toBe(priceAtomic(METRIC, variant));
    }
  });

  it('resolves the DynamicPrice to the same integer the table holds', async () => {
    const config = configs()[toX402Pattern(paidRoutes().find((r) => r.path === METRIC)!)]!;
    const option = Array.isArray(config.accepts) ? config.accepts[0]! : config.accepts;
    expect(typeof option.price).toBe('function');

    const price = await (option.price as (c: HTTPRequestContext) => Promise<{ amount: string; asset: string }>)(
      ctx('/metric/tinyman/tvl'),
    );
    // An explicit AssetAmount, so no decimal string is ever re-parsed into the
    // integer we charge.
    expect(price.amount).toBe(String(priceAtomic(METRIC, 'base')));
    expect(price.asset).toBe(String(NET.usdcAsaId));
  });

  it('quotes the body price and the header price from one call', async () => {
    const config = configs()[toX402Pattern(paidRoutes().find((r) => r.path === METRIC)!)]!;
    const context = ctx('/metric/tinyman/tvl', { fresh: 'true' });
    const body = (await config.unpaidResponseBody!(context)).body as {
      price: { amount_atomic: string; amount_usdc: string; variant: string };
    };
    expect(body.price.variant).toBe('fresh');
    expect(body.price.amount_atomic).toBe(String(priceAtomic(METRIC, 'fresh')));
    expect(body.price.amount_usdc).toBe('0.02');
  });
});

describe('which routes are gated', () => {
  it('gates every paid route, now that all three have handlers', () => {
    expect(gatedRoutes().map((r) => r.path)).toEqual([METRIC, '/compare', '/ask']);
    // The product is complete: nothing in the price table is priced-but-unbuilt.
    // Until /ask landed this list was a strict subset of paidRoutes(), and the
    // gap was what stopped the gate selling a 402 for a route that 404s.
    expect(gatedRoutes().map((r) => r.path)).toEqual(paidRoutes().map((r) => r.path));
  });

  it('never matches a free route', () => {
    for (const route of freeRoutes()) {
      expect(matchPaidRoute(route.path, route.method)).toBeUndefined();
    }
  });

  it('matches a paid route on its concrete path', () => {
    expect(matchPaidRoute('/metric/tinyman/tvl', 'GET')?.path).toBe(METRIC);
    expect(matchPaidRoute('/metric/tinyman/tvl', 'POST')).toBeUndefined();
    // One segment too many is a different route, not this one.
    expect(matchPaidRoute('/metric/tinyman/tvl/extra', 'GET')).toBeUndefined();
  });

  it('gates /compare now that it has a handler', () => {
    expect(matchPaidRoute('/compare', 'GET')?.path).toBe('/compare');
    expect(matchPaidRoute('/compare', 'POST')).toBeUndefined();
  });

  it('gates /ask now that it has a handler', () => {
    expect(matchPaidRoute('/ask', 'POST')?.path).toBe('/ask');
    // A GET is not this route. /ask takes a body, and a route matched on the
    // wrong method would emit a 402 for a request that then 404s.
    expect(matchPaidRoute('/ask', 'GET')).toBeUndefined();
    expect(ROUTES.find((r) => r.path === '/ask')?.paid).toBe(true);
  });

  /**
   * The property that made the priced/gated distinction worth having, kept
   * now that the two sets coincide: a route added to `pricing.ts` for a future
   * build step must NOT be gated until it has a `ROUTE_DOCS` entry, because a
   * gated route with no handler sells a 402 for a 404.
   */
  it('would not gate a priced route that had no ROUTE_DOCS entry', () => {
    expect(routeDocs('/history')).toBeUndefined();
    expect(matchPaidRoute('/history', 'GET')).toBeUndefined();
  });

  /**
   * The same rule, for the one route whose availability is a DEPLOYMENT choice
   * rather than a build one. A service with no ANTHROPIC_API_KEY still sells
   * /metric and /compare; quoting $0.15 for an /ask that would then answer 503
   * is the failure the gate exists to prevent.
   */
  it('does not gate /ask on a deployment with no ANTHROPIC_API_KEY', () => {
    expect(gatedRoutes(false).map((r) => r.path)).not.toContain('/ask');
    // The other two are unaffected: /ask being unavailable is not an outage.
    expect(gatedRoutes(false).map((r) => r.path)).toEqual([METRIC, '/compare']);
    expect(gatedRoutes(true).map((r) => r.path)).toContain('/ask');
    // This test process IS configured, which is what the rest of the suite
    // assumes when it exercises the paid /ask path.
    expect(askConfigured()).toBe(true);
  });
});

describe('Bazaar discovery (DEPLOYMENT.md §6.1)', () => {
  it('tags every gated route with the challenge tag and declares a discovery block', () => {
    const built: RoutesConfig = buildRoutes(NET);
    const entries = Object.entries(built as Record<string, RouteConfig>);
    expect(entries.length).toBeGreaterThan(0);

    for (const [pattern, config] of entries) {
      expect(config.tags, pattern).toContain(CHALLENGE_TAG);
      expect(config.description, pattern).toBeTruthy();
      expect(config.extensions?.bazaar, pattern).toBeDefined();
      expect(config.mimeType, pattern).toBe('application/json');
    }
  });

  /**
   * §6.1 requires the discovery block on EVERY paid route, and the test above
   * can only see the routes this process gates — which excludes `/ask` whenever
   * no ANTHROPIC_API_KEY is set, i.e. in CI and on the current deployment. So
   * `/ask`'s block would ship unchecked exactly when it is newest.
   *
   * DEPLOYMENT.md §6.1's warning is that "an inaccurate output_example is worse
   * than none, because an agent may plan against it", so these assert the
   * examples are structurally usable and not merely present.
   */
  it('declares a complete §6.1 block for every paid route, gated or not', () => {
    for (const route of paidRoutes()) {
      const docs = routeDocs(route.path);
      expect(docs, route.path).toBeDefined();
      if (docs === undefined) continue;

      // A one-sentence description written for an agent, not a placeholder.
      expect(docs.description.length, route.path).toBeGreaterThan(80);
      // A concrete request and a concrete response, both non-empty.
      expect(Object.keys(docs.inputExample).length, route.path).toBeGreaterThan(0);
      expect(Object.keys(docs.outputExample).length, route.path).toBeGreaterThan(0);
      expect(Object.keys(docs.discovery.input ?? {}).length, route.path).toBeGreaterThan(0);
    }
  });

  it("gates /ask with the same tags and block once a key is configured", () => {
    // The condition is a parameter precisely so this is testable: `env` is
    // parsed once at import and cannot be un-set.
    const withAsk = gatedRoutes(true).map((r) => r.path);
    expect(withAsk).toContain('/ask');

    const docs = routeDocs('/ask');
    expect(docs).toBeDefined();
    // `tags` is DISCOVERY_TAGS applied uniformly in buildRoutes, so the
    // challenge tag is structural rather than per-route — assert the invariant
    // that makes that true, so a future per-route tags field cannot drop it.
    expect(DISCOVERY_TAGS).toContain(CHALLENGE_TAG);

    // The output example must be shaped like a real answer: an agent that
    // plans against it will look for these keys.
    const out = docs!.outputExample as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(['question', 'answer', 'facts', 'confidence']),
    );
    expect(Array.isArray(out.facts)).toBe(true);
    // The question travels in the JSON body, and the block must SAY so.
    // Without `bodyType`, declareDiscoveryExtension renders `input` as
    // queryParams, and an agent planning against that sends
    // `POST /ask?question=...` — which this route answers 400 to.
    const discovery = docs!.discovery as { bodyType?: string; input: Record<string, unknown> };
    expect(discovery.bodyType).toBe('json');
    expect(discovery.input).toHaveProperty('question');
    // `depth` is a query parameter and the body branch has no queryParams to
    // hold it, so it must NOT be declared as a body field.
    expect(discovery.input).not.toHaveProperty('depth');
    expect(docs!.description).toContain('depth=deep');
  });

  it('renders /ask as a body route, not a query route, in the built block', () => {
    // The end-to-end version of the check above, through the real extension
    // helper: what an agent decoding our 402 actually receives.
    const built = buildRoutes(NET, true) as Record<string, RouteConfig>;
    const ask = built['POST /ask'];
    expect(ask, Object.keys(built).join(', ')).toBeDefined();
    const info = (ask!.extensions as { bazaar: { info: { input: Record<string, unknown> } } })
      .bazaar.info.input;
    expect(info.type).toBe('http');
    // The body branch carries `bodyType` + `body`; the query branch would
    // carry `queryParams` instead, and that is the whole distinction.
    expect(info.bodyType).toBe('json');
    expect(info).toHaveProperty('body');
    expect(info).not.toHaveProperty('queryParams');
    expect((info.body as Record<string, unknown>).question).toBeTruthy();
    // And the sibling GET routes still render as query routes, so this change
    // did not move all three onto the wrong branch.
    for (const pattern of ['GET /metric/:protocol/:kpi', 'GET /compare']) {
      const q = (built[pattern]!.extensions as { bazaar: { info: { input: Record<string, unknown> } } })
        .bazaar.info.input;
      expect(q, pattern).toHaveProperty('queryParams');
      expect(q, pattern).not.toHaveProperty('body');
    }
  });

  it('every route\'s output_example matches the shape its input asks for', () => {
    // /metric's example must name the protocol and kpi its input example asks
    // for. A mismatched pair is the specific inaccuracy §6.1 warns about.
    const metric = routeDocs('/metric/{protocol}/{kpi}')!;
    const path = (metric.discovery as { pathParams: Record<string, unknown> }).pathParams;
    const out = metric.outputExample as Record<string, unknown>;
    expect(out.protocol).toBe(path.protocol);
    expect(out.metric).toBe(path.kpi);

    const compare = routeDocs('/compare')!;
    const cIn = compare.discovery.input as Record<string, string>;
    const cOut = compare.outputExample as Record<string, unknown>;
    expect(cOut.metric).toBe(cIn.metric);
    // Every ranked protocol must be one the input example actually asked for.
    const asked = cIn.protocols.split(',');
    for (const row of cOut.ranking as Array<{ protocol: string }>) {
      expect(asked).toContain(row.protocol);
    }
  });
});

describe('route pattern translation', () => {
  it('converts the API_SPEC path form to the x402 matcher form', () => {
    expect(toX402Pattern(paidRoutes().find((r) => r.path === METRIC)!)).toBe(
      'GET /metric/:protocol/:kpi',
    );
  });
});
