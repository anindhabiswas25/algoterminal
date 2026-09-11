import { describe, expect, it } from 'vitest';

import {
  ROUTES,
  catalogRoutes,
  formatUsdc,
  freeRoutes,
  getRoute,
  isFreeRoute,
  paidRoutes,
  priceAtomic,
  priceUsdc,
} from '../src/pricing.js';
import { USDC_DECIMALS } from '../src/config/x402.js';

/**
 * API_SPEC.md §1 is the contract, and this module is the single source of truth
 * for it (ARCHITECTURE.md §4.1). The expectations below are transcribed from
 * the §1 table by hand, so the module drifting away from the published table is
 * a red test rather than a silent overcharge.
 */

describe('the §1 route and price table', () => {
  const table: ReadonlyArray<[string, string, boolean, string | null]> = [
    ['GET', '/health', false, null],
    ['GET', '/catalog', false, null],
    ['GET', '/openapi.json', false, null],
    ['GET', '/llms.txt', false, null],
    ['GET', '/methodology', false, null],
    ['GET', '/schema/kpi-fact.json', false, null],
    ['GET', '/metric/{protocol}/{kpi}', true, '0.005'],
    ['GET', '/compare', true, '0.05'],
    ['POST', '/ask', true, '0.15'],
  ];

  it('lists exactly the §1 rows, in table order', () => {
    expect(ROUTES.map((r) => r.path)).toEqual(table.map(([, path]) => path));
  });

  it.each(table)('%s %s — paid: %o, base price %s', (method, path, paid, price) => {
    const route = getRoute(path);
    expect(route?.method).toBe(method);
    expect(route?.paid).toBe(paid);
    if (price === null) {
      expect(route?.variants).toEqual([]);
    } else {
      expect(priceUsdc(path)).toBe(price);
    }
  });

  it('prices the §1 dynamic variants', () => {
    // "?fresh=true — raises price to $0.02"; active_users_24h at $0.03.
    expect(priceUsdc('/metric/{protocol}/{kpi}', 'fresh')).toBe('0.02');
    expect(priceUsdc('/metric/{protocol}/{kpi}', 'active_users')).toBe('0.03');
    // "/ask?depth=deep — $0.20"
    expect(priceUsdc('/ask', 'deep')).toBe('0.2');
  });

  it('keeps the free tier free — the §1 compliance claim', () => {
    // "everything needed to evaluate AlgoTerminal is free": discover, read the
    // schema, read the methodology, check health. `/schema/kpi-fact.json` is
    // the KpiFact envelope as JSON Schema — the contract a buyer generates
    // types from — and it is on this list for the same §7.5 reason as the rest:
    // an agent must be able to evaluate us completely before it pays.
    expect(freeRoutes().map((r) => r.path)).toEqual([
      '/health',
      '/catalog',
      '/openapi.json',
      '/llms.txt',
      '/methodology',
      '/schema/kpi-fact.json',
    ]);
    for (const route of freeRoutes()) expect(route.variants).toEqual([]);
    expect(isFreeRoute('/health')).toBe(true);
    expect(isFreeRoute('/ask')).toBe(false);
    expect(isFreeRoute('/nope')).toBe(false);
  });

  it('charges on exactly three paths', () => {
    expect(paidRoutes().map((r) => r.path)).toEqual([
      '/metric/{protocol}/{kpi}',
      '/compare',
      '/ask',
    ]);
    for (const route of paidRoutes()) expect(route.variants.length).toBeGreaterThan(0);
  });
});

describe('atomic units — what actually goes on the wire', () => {
  it('stores the §2.1 amounts, so the quote and the charge are one integer', () => {
    // API_SPEC.md §2.1: `"amount": "5000"` = 0.005 USDC at 6 decimals.
    expect(priceAtomic('/metric/{protocol}/{kpi}')).toBe(5_000);
    expect(priceAtomic('/metric/{protocol}/{kpi}', 'fresh')).toBe(20_000);
    expect(priceAtomic('/metric/{protocol}/{kpi}', 'active_users')).toBe(30_000);
    expect(priceAtomic('/compare')).toBe(50_000);
    expect(priceAtomic('/ask')).toBe(150_000);
    expect(priceAtomic('/ask', 'deep')).toBe(200_000);
  });

  it('every advertised string is an exact rendering of the charged integer', () => {
    for (const route of paidRoutes()) {
      for (const variant of route.variants) {
        expect(Number(formatUsdc(variant.amountAtomic)) * 10 ** USDC_DECIMALS).toBeCloseTo(
          variant.amountAtomic,
          6,
        );
      }
    }
  });

  it('renders atomic USDC without float arithmetic', () => {
    expect(formatUsdc(0)).toBe('0');
    expect(formatUsdc(1)).toBe('0.000001');
    expect(formatUsdc(5_000)).toBe('0.005');
    expect(formatUsdc(1_000_000)).toBe('1');
    expect(formatUsdc(1_500_000)).toBe('1.5');
    expect(formatUsdc(123_456_789)).toBe('123.456789');
  });

  it('refuses a fractional or negative atomic amount', () => {
    expect(() => formatUsdc(1.5)).toThrow(RangeError);
    expect(() => formatUsdc(-1)).toThrow(RangeError);
  });

  it('throws rather than defaulting on an unknown route or variant', () => {
    // A silent fallback price is how a caller gets charged something we never
    // quoted, which §1's "we never quote low and charge high" forbids.
    expect(() => priceAtomic('/nope')).toThrow(RangeError);
    expect(() => priceAtomic('/ask', 'shallow')).toThrow(RangeError);
    expect(() => priceAtomic('/health')).toThrow(RangeError);
  });
});

describe('catalogRoutes — the §3.4 routes[] array', () => {
  it('matches the §3.4 example, plus the §1 active-users price', () => {
    expect(catalogRoutes()).toEqual([
      {
        path: '/metric/{protocol}/{kpi}',
        method: 'GET',
        price_usdc: '0.005',
        price_fresh_usdc: '0.02',
        // Not in the §3.4 example, but §1 charges $0.03 for it. Advertising
        // only two of three prices would be the exact drift this module exists
        // to prevent.
        price_active_users_usdc: '0.03',
      },
      // §3.2 prices ?fresh=true at $0.08; the §1 table lists only the flat
      // price, and the two must not disagree in what we advertise.
      { path: '/compare', method: 'GET', price_usdc: '0.05', price_fresh_usdc: '0.08' },
      { path: '/ask', method: 'POST', price_usdc: '0.15', price_deep_usdc: '0.2' },
    ]);
  });

  it('advertises every paid variant, so no chargeable price is unquoted', () => {
    const advertised = catalogRoutes();
    for (const [i, route] of paidRoutes().entries()) {
      const entry = advertised[i] as Record<string, string>;
      for (const variant of route.variants) {
        expect(entry[variant.catalogKey], `${route.path} ${variant.id}`).toBe(
          formatUsdc(variant.amountAtomic),
        );
      }
    }
  });
});
