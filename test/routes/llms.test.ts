import { describe, it, expect } from 'vitest';

import { networkConstants } from '../../src/config/x402.js';
import { buildLlmsTxt } from '../../src/routes/llms.js';
import { formatUsdc, freeRoutes, paidRoutes, priceUsdc } from '../../src/pricing.js';
import { gatedRoutes } from '../../src/gate/routes.js';

/**
 * `/llms.txt` — API_SPEC.md §3.6, content per DEPLOYMENT.md §6.2.
 *
 * It is generated rather than checked in, so the risk it carries is not that
 * it is wrong today but that it stops matching `pricing.ts` later. These tests
 * read both and compare.
 */

describe('llms.txt', () => {
  const text = buildLlmsTxt(networkConstants('testnet'));

  it('names every price from the price table', () => {
    for (const route of paidRoutes()) {
      for (const variant of route.variants) {
        expect(text).toContain(`$${formatUsdc(variant.amountAtomic)}`);
      }
    }
  });

  it('lists every free route', () => {
    for (const route of freeRoutes()) {
      expect(text).toContain(route.path);
    }
  });

  it('carries the payment constants for the configured network', () => {
    const net = networkConstants('testnet');
    expect(text).toContain(net.caip2);
    expect(text).toContain(String(net.usdcAsaId));
    expect(text).toContain(process.env.X402_PAYTO as string);
    expect(text).not.toContain(networkConstants('mainnet').caip2);
  });

  it('states the settle-after-success guarantee', () => {
    expect(text).toContain('settled only after a successful response');
  });

  it('states what a caller is buying when the cache is cold', () => {
    expect(text).toContain('What you are buying when our cache is cold');
    expect(text).toContain('labelled stale answer is charged for');
    expect(text).toContain('0.40 floor');
    expect(text).toContain('?fresh=true');
  });

  /**
   * Every priced route now has a handler, so nothing carries the marker. The
   * assertion is kept and inverted rather than deleted: the marker exists so a
   * price table that runs ahead of the handlers cannot advertise a route that
   * 404s, and the day someone prices `/history` this test is what says the
   * marker still works.
   */
  it('advertises no route it cannot serve', () => {
    expect(text).not.toContain('not yet live');
    for (const route of paidRoutes()) {
      expect(gatedRoutes().map((r) => r.path)).toContain(route.path);
    }
  });

  it('lists /ask with both of its price tiers', () => {
    expect(text).toContain('POST /ask');
    expect(text).toContain(`$${priceUsdc('/ask')}`);
    expect(text).toContain(`$${priceUsdc('/ask', 'deep')}`);
  });
});
