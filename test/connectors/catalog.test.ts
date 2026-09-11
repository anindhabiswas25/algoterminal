import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SERVICE_NAME,
  buildCatalog,
  catalogPayment,
  catalogProtocol,
  catalogRoutesWithAvailability,
  networkLabel,
} from '../../src/routes/catalog.js';
import { createApp } from '../../src/app.js';
import { getConnector, listProtocolIds, registry } from '../../src/connectors/registry.js';
import { makeFakeConnector, makeRegistry } from '../../src/connectors/testing.js';
import { paidRoutes, priceUsdc } from '../../src/pricing.js';
import {
  ALGORAND_MAINNET_CAIP2,
  FEE_SPONSORED,
  USDC_DECIMALS,
  USDC_MAINNET_ASA,
  USDC_SYMBOL,
  X402_VERSION,
  networkConstants,
} from '../../src/config/x402.js';
import { KPI_IDS } from '../../src/standardize/kpis.js';

/** API_SPEC.md §3.4 response shape. */
const CatalogSchema = z.object({
  service: z.string().min(1),
  methodology_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  network: z.string().min(1),
  payment: z.object({
    protocol: z.literal('x402'),
    version: z.number().int(),
    scheme: z.string().min(1),
    asset: z.string().regex(/^\d+$/),
    asset_symbol: z.string().min(1),
    decimals: z.number().int().nonnegative(),
    network: z.string().startsWith('algorand:'),
    facilitator: z.url(),
    payTo: z.string().regex(/^[A-Z2-7]{58}$/),
    fee_sponsored: z.boolean(),
  }),
  protocols: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      class: z.enum(['dex', 'lending', 'l1']),
      kpis: z.array(z.enum(KPI_IDS)),
      sources: z.array(z.string().min(1)).min(1),
      // Optional, and every reason must be non-empty prose: a decline with a
      // blank reason is worse than no decline, because it tells a buyer a KPI
      // is unavailable without telling it why.
      declined: z.partialRecord(z.enum(KPI_IDS), z.string().min(1)).optional(),
    }),
  ),
  routes: z.array(
    z.object({
      path: z.string(),
      method: z.enum(['GET', 'POST']),
      // Always present, never inferred from a missing key: an agent must be
      // able to check availability rather than deduce it.
      available: z.boolean(),
    }),
  ),
});

describe('GET /catalog', () => {
  it('returns 200, valid JSON, and the live registry as protocols[]', async () => {
    const res = await createApp().request('/catalog');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(() => CatalogSchema.parse(body)).not.toThrow();
    expect(body.protocols.map((p: { id: string }) => p.id)).toEqual(listProtocolIds());
  });

  it('advertises Tinyman with exactly the KPIs its connector declares', async () => {
    const body = await (await createApp().request('/catalog')).json();
    const tinyman = body.protocols.find((p: { id: string }) => p.id === 'tinyman');
    expect(tinyman).toBeDefined();
    // Generated from capabilities(), so an over-claim here is impossible by
    // construction rather than by review.
    expect(tinyman).toEqual(catalogProtocol(getConnector('tinyman')!));
    expect(tinyman.class).toBe('dex');
    expect(tinyman.kpis).toHaveLength(11);
  });

  it("publishes Pact's declines with their reasons, not just their absence", async () => {
    const body = await (await createApp().request('/catalog')).json();
    const pact = body.protocols.find((p: { id: string }) => p.id === 'pact');
    // The four KPIs of the §3.1 fee split Pact does not disclose, plus the
    // active-user count it has no single application to filter on.
    expect(Object.keys(pact.declined).sort()).toEqual([
      'active_users_24h',
      'fee_apr',
      'protocol_revenue_24h',
      'supply_side_revenue_24h',
      'take_rate',
    ]);
    // The whole point of the field: a reason a buyer can read, in each one.
    for (const reason of Object.values(pact.declined) as string[]) {
      expect(reason.length).toBeGreaterThan(40);
    }
    // And it is never both published and declined.
    for (const kpi of Object.keys(pact.declined)) expect(pact.kpis).not.toContain(kpi);
  });

  it('is free and permissively CORS-ed, per API_SPEC.md §1 and §5', async () => {
    const res = await createApp().request('/catalog', {
      headers: { Origin: 'https://example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('still advertises the full route and price table', async () => {
    const body = await (await createApp().request('/catalog')).json();
    expect(body.routes).toEqual(catalogRoutesWithAvailability());
  });
});

describe('protocols[] is generated from the registry, never from a static list', () => {
  it('lists exactly the KPIs a registered connector declares', () => {
    const connector = makeFakeConnector();
    const body = buildCatalog(makeRegistry(connector));
    expect(body.protocols).toEqual([
      {
        id: 'fake',
        name: 'Fake DEX',
        class: 'dex',
        kpis: ['tvl', 'volume_24h', 'pool_count'],
        sources: ['api.fake.test'],
      },
    ]);
    // A connector that declines nothing carries no `declined` key at all.
    expect(body.protocols[0]).not.toHaveProperty('declined');
    // The point: identical to capabilities(), with nothing added.
    expect(body.protocols[0]?.kpis).toEqual([...connector.capabilities().kpis]);
    // §3.4 publishes it as `sources`; the connector declares it as `sourceHosts`.
    expect(body.protocols[0]?.sources).toEqual([...connector.capabilities().sourceHosts]);
  });

  it('advertises no KPI a connector did not declare', () => {
    const body = buildCatalog(makeRegistry(makeFakeConnector({ capabilities: { kpis: ['tvl'] } })));
    expect(body.protocols[0]?.kpis).toEqual(['tvl']);
    // Structurally impossible to advertise the rest: there is no other source.
    for (const kpi of KPI_IDS) {
      if (kpi !== 'tvl') expect(body.protocols[0]?.kpis).not.toContain(kpi);
    }
  });

  it('grows and shrinks with the registry alone', () => {
    const one = makeFakeConnector({ capabilities: { id: 'alpha', name: 'Alpha' } });
    const two = makeFakeConnector({
      capabilities: { id: 'beta', name: 'Beta', class: 'lending', kpis: ['tvl', 'utilization'] },
    });
    expect(buildCatalog(makeRegistry(one)).protocols.map((p) => p.id)).toEqual(['alpha']);
    expect(buildCatalog(makeRegistry(one, two)).protocols.map((p) => p.id)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(buildCatalog(new Map()).protocols).toEqual([]);
  });

  it('copies the declared arrays rather than handing out connector state', () => {
    const connector = makeFakeConnector();
    const entry = catalogProtocol(connector);
    entry.kpis.push('take_rate');
    expect(connector.capabilities().kpis).toEqual(['tvl', 'volume_24h', 'pool_count']);
  });

  it('serves a registered connector over HTTP, through the real registry', async () => {
    const before = (await (await createApp().request('/catalog')).json()).protocols.length;
    const connector = makeFakeConnector();
    registry.set('fake', connector);
    try {
      const body = await (await createApp().request('/catalog')).json();
      expect(() => CatalogSchema.parse(body)).not.toThrow();
      expect(body.protocols).toHaveLength(before + 1);
      const fake = body.protocols.find((p: { id: string }) => p.id === 'fake');
      expect(fake.kpis).toEqual(['tvl', 'volume_24h', 'pool_count']);
    } finally {
      registry.delete('fake');
    }
    // ...and it disappears again the moment it is unregistered.
    const after = (await (await createApp().request('/catalog')).json()).protocols;
    expect(after.map((p: { id: string }) => p.id)).not.toContain('fake');
  });
});

describe('the payment block comes from src/config/x402.ts and env, never retyped', () => {
  it('matches the mainnet constants byte-for-byte', () => {
    const payment = catalogPayment(networkConstants('mainnet'));
    expect(payment).toEqual({
      protocol: 'x402',
      version: X402_VERSION,
      scheme: 'exact',
      asset: String(USDC_MAINNET_ASA),
      asset_symbol: USDC_SYMBOL,
      decimals: USDC_DECIMALS,
      network: ALGORAND_MAINNET_CAIP2,
      facilitator: process.env.X402_FACILITATOR_URL,
      payTo: process.env.X402_PAYTO,
      fee_sponsored: FEE_SPONSORED,
    });
    // The §3.4 example's literals, as published.
    expect(payment.asset).toBe('31566704');
    expect(payment.network).toBe('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=');
    expect(payment.decimals).toBe(6);
  });

  it('follows the configured network rather than hardcoding mainnet', () => {
    const testnet = catalogPayment(networkConstants('testnet'));
    expect(testnet.network).toBe(networkConstants('testnet').caip2);
    expect(testnet.asset).toBe('10458941');
    expect(networkLabel('mainnet')).toBe('algorand-mainnet');
    expect(networkLabel('testnet')).toBe('algorand-testnet');
  });
});

describe('the rest of the §3.4 envelope', () => {
  it('names the service and stamps the env methodology version', () => {
    const body = buildCatalog(new Map());
    expect(body.service).toBe(SERVICE_NAME);
    expect(body.methodology_version).toBe(process.env.METHODOLOGY_VERSION);
  });

  it('takes routes[] and every price from src/pricing.ts', () => {
    const body = buildCatalog(new Map());
    expect(body.routes).toEqual(catalogRoutesWithAvailability());
    for (const [i, route] of paidRoutes().entries()) {
      const entry = body.routes[i] as unknown as Record<string, string>;
      expect(entry.path).toBe(route.path);
      expect(entry.price_usdc).toBe(priceUsdc(route.path));
    }
  });

  it('quotes the §1 table prices verbatim', () => {
    const [metric, compare, ask] = buildCatalog(new Map()).routes as unknown as Array<
      Record<string, string>
    >;
    expect(metric?.price_usdc).toBe('0.005');
    expect(metric?.price_fresh_usdc).toBe('0.02');
    expect(compare?.price_usdc).toBe('0.05');
    expect(ask?.price_usdc).toBe('0.15');
    expect(ask?.price_deep_usdc).toBe('0.2');
  });
});
