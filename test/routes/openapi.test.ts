import { describe, it, expect } from 'vitest';
import '@hyperjump/json-schema/openapi-3-1';
import { validate } from '@hyperjump/json-schema/draft-2020-12';

import { createApp } from '../../src/app.js';
import { buildOpenApiDocument, priceExtensionKey } from '../../src/openapi/document.js';
import { networkConstants } from '../../src/config/x402.js';
import { envelope, ErrorEnvelopeSchema } from '../../src/errors.js';
import { UnpaidBodySchema } from '../../src/gate/routes.js';
import { ROUTES, formatUsdc, priceAtomic } from '../../src/pricing.js';
import { listProtocolIds } from '../../src/connectors/registry.js';
import { KPI_IDS } from '../../src/standardize/kpis.js';

/**
 * `GET /openapi.json` — API_SPEC.md §4.
 *
 * The claim under test is not "the document exists". It is §4's claim that the
 * document is GENERATED from the same objects the service runs on, so it cannot
 * describe behaviour the service does not have. Three checks carry that:
 *
 *  1. It validates against the OpenAPI 3.1 meta-schema. A generator that emits
 *     something structurally invalid fails here rather than in an integrator's
 *     client generator, where the failure is ours and the cost is theirs.
 *  2. Every published price is the integer `src/pricing.ts` charges — asserted
 *     by reading `priceAtomic` rather than by comparing against a literal.
 *  3. Every published enum is the live one. Registering connector #4 must
 *     change the document with no edit to the generator, and this is what makes
 *     that testable rather than hoped for.
 */

/**
 * The OpenAPI 3.1 meta-schema, from `@hyperjump/json-schema/openapi-3-1`.
 *
 * The schemas ship inside the package, so nothing here reaches
 * spec.openapis.org — a test that fetched its own oracle would fail on a CI
 * runner with no egress and, worse, would quietly change meaning the day the
 * spec is republished. Pinning it to a dependency version makes "valid OpenAPI"
 * a statement about our document rather than about today's internet.
 *
 * Ajv was tried first and rejected: its `$dynamicRef` support resolves the
 * Schema Object's `#meta` anchor to the nearest enclosing definition instead of
 * the dynamic scope, so it reports a perfectly valid `{ type: "string" }`
 * parameter schema as a malformed Parameter Object. A validator that is wrong
 * about the dialect cannot be used to check conformance to it.
 */
const META_SCHEMA = 'https://spec.openapis.org/oas/3.1/schema-base';

async function assertValidOpenApi(document: unknown, label: string): Promise<void> {
  const result = await validate(META_SCHEMA, document, 'BASIC');
  // Print the errors: "false" is not a debuggable failure message for a
  // generated document of this size.
  expect(result.errors ?? [], `${label}: ${JSON.stringify(result.errors, null, 2)}`).toEqual([]);
  expect(result.valid, label).toBe(true);
}

describe('/openapi.json', () => {
  it('validates against the OpenAPI 3.1 meta-schema', async () => {
    await assertValidOpenApi(buildOpenApiDocument(), 'document');
  });

  it('validates for both networks', async () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      await assertValidOpenApi(buildOpenApiDocument(networkConstants(network)), network);
    }
  });

  /**
   * A validator that never rejects would make every assertion above vacuous,
   * and "the spec is valid" is exactly the kind of claim that fails silently.
   * So: break the document in a way the meta-schema must catch.
   */
  it('the meta-schema check actually rejects an invalid document', async () => {
    const broken = buildOpenApiDocument() as Record<string, unknown>;
    broken.openapi = 'not-a-version';
    const result = await validate(META_SCHEMA, broken, 'BASIC');
    expect(result.valid).toBe(false);
  });

  it('is served free, as JSON, with permissive CORS', async () => {
    const res = await createApp().request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { openapi: string };
    expect(body.openapi).toBe('3.1.0');
  });

  it('publishes every route in the price table, and nothing else', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths).sort()).toEqual(ROUTES.map((r) => r.path).sort());
    for (const route of ROUTES) {
      expect(doc.paths[route.path]).toHaveProperty(route.method.toLowerCase());
    }
  });

  it('publishes the exact atomic price the middleware charges', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    for (const route of ROUTES) {
      const op = doc.paths[route.path]![route.method.toLowerCase()]!;
      expect(op['x-paid']).toBe(route.paid);
      for (const variant of route.variants) {
        // Not compared against a literal: read from the same function the
        // DynamicPrice closure reads from, so a price change is a one-line
        // change in pricing.ts and this stays true.
        expect(op[priceExtensionKey(variant)]).toBe(formatUsdc(priceAtomic(route.path, variant.id)));
      }
      if (!route.paid) expect(Object.keys(op).some((k) => k.startsWith('x-price'))).toBe(false);
    }
  });

  it('prices /ask at the $0.15 / $0.20 tiers of §3.3', () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const ask = doc.paths['/ask']!.post!;
    expect(ask['x-price-usdc']).toBe('0.15');
    expect(ask['x-price-usdc-deep']).toBe('0.2');
  });

  it('draws its protocol and KPI enums from the live registries', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { parameters?: { name: string; schema: { enum?: string[] } }[] }>>;
    };
    const params = doc.paths['/metric/{protocol}/{kpi}']!.get!.parameters!;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.protocol!.schema.enum).toEqual(listProtocolIds());
    expect(byName.kpi!.schema.enum).toEqual([...KPI_IDS]);
  });

  it('carries the §4 x-x402 block from the payment constants', () => {
    const net = networkConstants('mainnet');
    const doc = buildOpenApiDocument(net) as { info: { 'x-x402': Record<string, unknown> } };
    const x402 = doc.info['x-x402'];
    expect(x402.network).toBe(net.caip2);
    expect(x402.asset).toBe(String(net.usdcAsaId));
    expect(x402.scheme).toBe('exact');
    expect(x402.version).toBe(2);
    expect(x402.fee_sponsored).toBe(true);
  });

  it('references every component it declares, and declares every one it references', () => {
    const doc = buildOpenApiDocument();
    const declared = new Set(Object.keys((doc as { components: { schemas: object } }).components.schemas));
    const referenced = new Set<string>();
    JSON.stringify(doc, (key, value) => {
      if (key === '$ref' && typeof value === 'string') {
        referenced.add(value.replace('#/components/schemas/', ''));
      }
      return value;
    });
    // Every $ref resolves. A dangling $ref is the failure that makes a
    // generated client throw at import rather than at call time.
    for (const name of referenced) expect(declared).toContain(name);
  });
});

/**
 * The two components that describe payloads built by hand elsewhere in the
 * codebase rather than by a zod parse. Their schemas are published; these
 * assert the published schema accepts the real thing.
 */
describe('published components describe the real payloads', () => {
  it('ErrorEnvelope accepts an actual error envelope', () => {
    const real = envelope('KPI_NOT_APPLICABLE', 'not defined for a dex protocol', {
      protocol: 'tinyman',
      available_kpis: ['tvl'],
    });
    expect(ErrorEnvelopeSchema.safeParse(real).success).toBe(true);
  });

  it('PaymentRequiredBody accepts an actual 402 body', async () => {
    const res = await createApp().request('/metric/tinyman/tvl');
    expect(res.status).toBe(402);
    const parsed = UnpaidBodySchema.safeParse(await res.json());
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
