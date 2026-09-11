import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { buildLandingPage, esc } from '../../src/routes/landing.js';
import { env } from '../../src/config/env.js';
import { activeNetwork, networkConstants } from '../../src/config/x402.js';
import { listConnectors } from '../../src/connectors/registry.js';
import { gatedRoutes } from '../../src/gate/routes.js';
import { formatUsdc, paidRoutes, freeRoutes } from '../../src/pricing.js';

/**
 * DEPLOYMENT.md §6.3. The landing page is fetched daily by the Bazaar
 * enrichment engine and read by an agent operator deciding in thirty seconds
 * whether to integrate, and it is the one document in the product that carries
 * prices with no consumer that fails loudly when they are wrong. So the tests
 * that matter are the ones that pin it to `pricing.ts` rather than to a string.
 */
describe('GET / — the landing page', () => {
  it('is free, and served as HTML', async () => {
    const res = await createApp().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // Never gated: an agent that cannot read the page cannot decide to buy.
    expect(res.headers.get('payment-required')).toBeNull();
  });

  it('quotes every price from the table the gate charges from', async () => {
    const html = await (await createApp().request('/')).text();
    for (const route of paidRoutes()) {
      for (const variant of route.variants) {
        // The rendered string, not the atomic integer: this is the assertion
        // that catches a page quoting $0.05 for a 5000-unit route.
        expect(html).toContain(`$${formatUsdc(variant.amountAtomic)}`);
      }
      expect(html).toContain(esc(`${route.method} ${route.path}`));
    }
  });

  it('lists every free route as free, so evaluation is visibly unpaid', async () => {
    const html = await (await createApp().request('/')).text();
    for (const route of freeRoutes()) {
      expect(html).toContain(`${route.method} ${route.path}`);
      expect(html).toContain(esc(route.rationale));
    }
  });

  it('marks a paid route this deployment cannot serve as not yet live', async () => {
    const html = await (await createApp().request('/')).text();
    const ungated = paidRoutes().filter(
      (r) => !new Set(gatedRoutes().map((g) => g.path)).has(r.path),
    );
    // In a test process with no ANTHROPIC_API_KEY this is /ask, and the page
    // must say so rather than advertising a route that answers 503.
    if (ungated.length > 0) expect(html).toContain('not yet live');
    else expect(html).not.toContain('not yet live');
  });

  it('advertises the OpenGraph card §6.3 requires, at absolute URLs', async () => {
    const html = await (await createApp().request('/')).text();
    for (const tag of [
      '<meta property="og:title" content="AlgoTerminal">',
      `<meta property="og:image" content="${env.PUBLIC_BASE_URL}/og-banner.png">`,
      `<meta property="og:url" content="${env.PUBLIC_BASE_URL}/">`,
      '<meta property="og:type" content="website">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<link rel="icon" href="/favicon.png" type="image/png">',
    ]) {
      expect(html).toContain(tag);
    }
    // A crawler resolves og:image against nothing; a relative path is a card
    // with a broken image, which is the §6.4 failure that is invisible locally.
    expect(html).toMatch(/<meta property="og:image" content="https?:\/\//);
  });

  it('carries a title and description for the directory card', async () => {
    const html = await (await createApp().request('/')).text();
    expect(html).toContain(
      '<title>AlgoTerminal — Standardized Algorand DeFi KPIs, priced per query in USDC</title>',
    );
    expect(html).toMatch(/<meta name="description" content="[^"]{80,}">/);
  });

  it('publishes each protocol with its KPIs and its declines', async () => {
    const html = await (await createApp().request('/')).text();
    for (const connector of listConnectors()) {
      const caps = connector.capabilities();
      expect(html).toContain(`<code>${caps.id}</code>`);
      for (const kpi of caps.kpis) expect(html).toContain(`<code>${kpi}</code>`);
      // The declines are the point: a page listing only `kpis` reads as thin
      // coverage where the truth is a source that does not disclose.
      for (const kpi of Object.keys(caps.declined ?? {})) {
        expect(html).toContain(`<code>${kpi}</code>`);
      }
    }
  });

  it('states the two guarantees an operator buys on', async () => {
    const html = await (await createApp().request('/')).text();
    expect(html).toContain('settle only after a successful response');
    expect(html).toContain('never sold as a fresh one');
  });

  it('names the network it actually settles on, not a hardcoded one', () => {
    expect(buildLandingPage(networkConstants('mainnet'))).toContain('Algorand MainNet');
    expect(buildLandingPage(networkConstants('testnet'))).toContain('Algorand TestNet');
    const live = activeNetwork();
    expect(buildLandingPage()).toContain(String(live.usdcAsaId));
  });

  it('points a mainnet visitor at the free TestNet surface, when one is configured', () => {
    const mainnet = buildLandingPage(networkConstants('mainnet'));
    if (env.TESTNET_BASE_URL === undefined) {
      // Nothing to point at; the page must not invent a URL.
      expect(mainnet).not.toContain('Evaluate for free first');
    } else {
      expect(mainnet).toContain(env.TESTNET_BASE_URL);
    }
    // On the TestNet deployment itself, it says so instead of self-linking.
    expect(buildLandingPage(networkConstants('testnet'))).toContain(
      'This is the TestNet deployment',
    );
  });

  it('escapes interpolated values rather than trusting them to be inert', () => {
    expect(esc('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });
});
