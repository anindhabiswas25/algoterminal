import { z } from 'zod';

import { activeNetwork, FEE_SPONSORED, type NetworkConstants } from '../config/x402.js';
import { env } from '../config/env.js';
import { ErrorEnvelopeSchema } from '../errors.js';
import { UnpaidBodySchema } from '../gate/routes.js';
import { gatedRoutes, routeDocs } from '../gate/routes.js';
import { formatUsdc, ROUTES, type PriceVariant, type RouteSpec } from '../pricing.js';
import {
  AskRequestSchema,
  BasisSchema,
  BooleanQueryOpenApiEnum,
  KpiIdSchema,
  ProtocolsCsvSchema,
  protocolIdSchema,
} from '../routes/params.js';
import { AskResponseSchema, CitationSchema, PlanSchema } from '../ask/schema.js';
import { SERVICE_NAME } from '../routes/catalog.js';
import { KPI_FACT_SCHEMA_PATH, SCHEMA_VERSION_KEY } from '../standardize/jsonschema.js';
import {
  ComparabilitySchema,
  ComparisonSchema,
  RankingEntrySchema,
  SpreadSchema,
} from '../standardize/compare.js';
import {
  CoverageSchema,
  FactErrorSchema,
  KpiFactSchema,
  SourceRefSchema,
} from '../standardize/schema.js';

/**
 * `GET /openapi.json` — API_SPEC.md §4.
 *
 * ## The one property this file exists for
 *
 * §4: "the implementation generates the full document from the same zod
 * schemas that validate requests, so spec and behavior cannot diverge." Nothing
 * below is transcribed. Every price comes from `src/pricing.ts` (the module the
 * payment middleware charges from), every payment constant from
 * `src/config/x402.ts`, every protocol id from the live connector registry,
 * every KPI id from the DATA_SCHEMA.md §4 registry, and every request and
 * response schema from the zod objects that validate the real thing.
 *
 * A hand-written OpenAPI document is the most reliable way to publish a lie: it
 * is read by machines, edited by humans, and nothing fails when the two drift.
 * The test suite validates the generated document against the OpenAPI 3.1
 * meta-schema, so a generator that produces something structurally invalid
 * fails CI rather than an integrator's client generator.
 *
 * ## Price extensions
 *
 * §4's skeleton is internally inconsistent about the extension key for a
 * non-base price: it writes `x-price-usdc-fresh` on `/metric` and
 * `x-price-fresh-usdc` on `/compare`, for the same concept. Both cannot be
 * right, so neither is copied. The generated form is
 * `x-price-usdc` for the base variant and `x-price-usdc-{variantId}` for every
 * other, derived from the variant ids in `src/pricing.ts` — which means adding
 * a price variant publishes its extension with no edit here.
 *
 * `x-price-usdc-variants` carries the whole table (id, atomic amount, decimal
 * string, and the condition that selects it), because the flat extensions
 * cannot express the selection rule and an agent budgeting a call needs it.
 */

/** §4 `info.version`. The API contract's version, not the methodology's. */
export const API_VERSION = '1.0.0';

/** The OpenAPI dialect this document is written in. */
export const OPENAPI_VERSION = '3.1.0';

// ---------------------------------------------------------------------------
// Components — generated from the zod schemas that validate the real payloads
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/**
 * The components, in a local registry so `z.toJSONSchema` emits cross-`$ref`s
 * instead of inlining `KpiFact` into every response that carries one.
 *
 * A local registry rather than `.meta({ id })` on the schemas themselves: the
 * schemas are used to validate requests and facts on the hot path, and hanging
 * OpenAPI naming off them would make a documentation concern a property of the
 * validator.
 */
const COMPONENTS = {
  KpiFact: KpiFactSchema,
  SourceRef: SourceRefSchema,
  Coverage: CoverageSchema,
  FactError: FactErrorSchema,
  CompareResponse: ComparisonSchema,
  RankingEntry: RankingEntrySchema,
  Spread: SpreadSchema,
  Comparability: ComparabilitySchema,
  AskRequest: AskRequestSchema,
  AskResponse: AskResponseSchema,
  AskPlan: PlanSchema,
  Citation: CitationSchema,
  ErrorEnvelope: ErrorEnvelopeSchema,
  PaymentRequiredBody: UnpaidBodySchema,
} as const satisfies Record<string, z.ZodType>;

export type ComponentName = keyof typeof COMPONENTS;

const ref = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });

/**
 * Render the registry to `components.schemas`.
 *
 * `$schema` and `$id` are stripped from each component. Both are legal in an
 * OAS 3.1 Schema Object, and both are noise here: `$schema` re-declares the
 * dialect the document already fixes, and `$id` would announce a resolution
 * base that is not a real retrievable URI.
 */
function componentSchemas(): Record<string, JsonObject> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(COMPONENTS)) registry.add(schema, { id });

  const rendered = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    uri: (id) => `#/components/schemas/${id}`,
  }).schemas as Record<string, JsonObject>;

  return Object.fromEntries(
    Object.entries(rendered).map(([id, schema]) => {
      const { $schema, $id, ...rest } = schema;
      void $schema;
      void $id;
      return [id, rest];
    }),
  );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * A parameter's `schema` block, from the zod schema that validates it.
 *
 * `$schema` is stripped for the same reason as above. `enum` values therefore
 * reach the document from `src/standardize/types.ts` and the connector
 * registry, never from a list typed here.
 */
function paramSchema(schema: z.ZodType, extra: JsonObject = {}): JsonObject {
  const { $schema, ...rest } = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as JsonObject;
  void $schema;
  return { ...rest, ...extra };
}

interface ParamOptions {
  readonly required?: boolean;
  readonly description: string;
  readonly example?: unknown;
}

function param(
  name: string,
  location: 'path' | 'query',
  schema: JsonObject,
  opts: ParamOptions,
): JsonObject {
  return {
    name,
    in: location,
    required: opts.required ?? location === 'path',
    description: opts.description,
    schema,
    ...(opts.example === undefined ? {} : { example: opts.example }),
  };
}

/** `?basis=` — shared by `/metric` and `/compare`, as one declaration. */
const basisParam = (location: 'query') =>
  param(
    'basis',
    location,
    paramSchema(BasisSchema, { default: 'all_pools_usd_priced' }),
    {
      description:
        'Inclusion basis (DATA_SCHEMA.md §3.6). A protocol that does not implement the requested ' +
        'basis returns 400 INVALID_PARAM listing the ones it does — it never silently substitutes ' +
        'the default, which would return a different number than the one asked for.',
    },
  );

/**
 * `?fresh=` — published as `true`/`false` only.
 *
 * `"1"`/`"0"` are also accepted (`BooleanQuerySchema`); they are a legacy
 * spelling we honour and would not recommend. Accept broadly, publish narrowly.
 */
const freshParam = (description: string) =>
  param(
    'fresh',
    'query',
    { type: 'string', enum: [...BooleanQueryOpenApiEnum], default: 'false' },
    { description },
  );

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const jsonContent = (schema: JsonObject) => ({ 'application/json': { schema } });

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ref('ErrorEnvelope')),
});

/**
 * The shared 402.
 *
 * The `PAYMENT-REQUIRED` header is the machine contract; the body restates the
 * price in plain JSON so an agent that does not yet speak x402 still learns
 * what the route costs and why (§2.1).
 */
const paymentRequiredResponse = {
  description:
    'x402 payment required. `PAYMENT-REQUIRED` carries the base64 v2 payment requirements; the ' +
    'body restates price, resource and description in plain JSON.',
  headers: {
    'PAYMENT-REQUIRED': {
      schema: { type: 'string' },
      description: 'Base64-encoded x402 v2 payment requirements.',
    },
  },
  content: jsonContent(ref('PaymentRequiredBody')),
};

/**
 * Every paid route's payment-layer failures, which are identical across routes
 * because they are decided by the gate rather than by the handler (§2.4).
 */
const paymentResponses = {
  '402': paymentRequiredResponse,
  '409': errorResponse('PAYMENT_REPLAYED — this payment txid has already been recorded.'),
  '503': errorResponse(
    'FACILITATOR_UNAVAILABLE — the payment facilitator could not be reached. We do not fail open: ' +
      'no data is served without a verified payment. `Retry-After: 5`.',
  ),
};

/** §2.3 — the two headers every successful data response carries. */
const dataHeaders = {
  'X-AlgoTerminal-Cache': {
    schema: { type: 'string', enum: ['hit', 'miss', 'stale'] },
    description: 'Cache state of this response. On a composite, the WORST state across its parts.',
  },
  'X-AlgoTerminal-Methodology': {
    schema: { type: 'string' },
    description: 'The methodology_version this number was computed under.',
  },
};

// ---------------------------------------------------------------------------
// Price extensions, from src/pricing.ts
// ---------------------------------------------------------------------------

/** `base` -> `x-price-usdc`; anything else -> `x-price-usdc-{id}`. */
export function priceExtensionKey(variant: PriceVariant): string {
  return variant.id === 'base' ? 'x-price-usdc' : `x-price-usdc-${variant.id}`;
}

function priceExtensions(route: RouteSpec): JsonObject {
  if (!route.paid) return {};
  const flat = Object.fromEntries(
    route.variants.map((v) => [priceExtensionKey(v), formatUsdc(v.amountAtomic)]),
  );
  return {
    ...flat,
    // The flat keys cannot say WHICH request gets which price. This can, and an
    // agent budgeting a call needs it more than it needs the flat keys.
    'x-price-usdc-variants': route.variants.map((v) => ({
      id: v.id,
      amount_atomic: String(v.amountAtomic),
      amount_usdc: formatUsdc(v.amountAtomic),
      when: v.when,
    })),
    // Selection is by highest applicable price, not by a precedence chain
    // (`src/gate/routes.ts`), and a caller quoting itself needs to know that.
    'x-price-selection':
      'The highest-priced variant this request qualifies for. A request that triggers two ' +
      'variants pays for both costs it imposes; the 402 quotes the exact amount that will be ' +
      'charged, before the handler runs.',
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Per-route operation bodies, keyed by the `src/pricing.ts` path.
 *
 * Keyed by that path rather than listed independently so that {@link build}
 * can iterate `ROUTES` and fail loudly on a route with no operation — the same
 * discipline `ROUTE_DOCS` enforces for Bazaar declarations. A priced route with
 * no published operation is a route an agent cannot discover.
 */
function operations(): Record<string, JsonObject> {
  const protocolEnum = paramSchema(protocolIdSchema());
  const kpiEnum = paramSchema(KpiIdSchema);

  return {
    '/health': {
      operationId: 'getHealth',
      summary: 'Liveness and dependency status',
      description:
        'Free, never gated, and never dependent on the payment facilitator being reachable.',
      responses: {
        '200': { description: 'Service status, connector probes, cache and facilitator health.' },
        '503': { description: 'Unhealthy: a dependency required to serve paid traffic is down.' },
      },
    },

    '/catalog': {
      operationId: 'getCatalog',
      summary: 'What we sell, and what it costs',
      description:
        'Capability discovery. `protocols[]` is generated by iterating the connector registry, so ' +
        'it is structurally impossible to advertise a KPI no connector implements.',
      responses: { '200': { description: 'Service, payment block, protocols and priced routes.' } },
    },

    '/openapi.json': {
      operationId: 'getOpenApi',
      summary: 'This document',
      description:
        'Generated from the same zod schemas that validate requests and the same price table the ' +
        'payment middleware charges from.',
      responses: { '200': { description: 'This OpenAPI 3.1 document.' } },
    },

    '/llms.txt': {
      operationId: 'getLlmsTxt',
      summary: 'Agent-facing description (llmstxt.org)',
      responses: {
        '200': { description: 'Markdown.', content: { 'text/plain': { schema: { type: 'string' } } } },
      },
    },

    '/methodology': {
      operationId: 'getMethodology',
      summary: 'The published accounting policy',
      description:
        'DATA_SCHEMA.md, in two renderings. JSON by default — the KPI registry, the confidence ' +
        'ladder and the per-connector policy as data an agent can branch on. `?format=markdown` ' +
        '(or `Accept: text/markdown`) returns the document itself. `/ask` cites this route.',
      parameters: [
        param(
          'format',
          'query',
          { type: 'string', enum: ['json', 'markdown'], default: 'json' },
          {
            description:
              'json (default) is the structured rendering; markdown is the source document.',
          },
        ),
      ],
      responses: {
        '200': {
          description: 'The accounting policy.',
          content: {
            'application/json': { schema: { type: 'object' } },
            'text/markdown': { schema: { type: 'string' } },
          },
        },
      },
    },

    [KPI_FACT_SCHEMA_PATH]: {
      operationId: 'getKpiFactSchema',
      summary: 'The KpiFact envelope as JSON Schema',
      description:
        'The envelope every number arrives in, as a self-contained JSON Schema draft 2020-12 ' +
        'document, stamped `' +
        SCHEMA_VERSION_KEY +
        '`. Free. Generate types from it in any language, or validate a response before acting ' +
        'on it — including the cross-field rules the components block below cannot carry: a null ' +
        'value is legal only beside an error, and an estimate always names its estimation_method. ' +
        'It is a contract artefact, not a client library. DATA_SCHEMA.md §7 governs what a ' +
        'version bump may change it.',
      responses: {
        '200': {
          description: 'The KpiFact JSON Schema.',
          content: {
            'application/schema+json': { schema: { type: 'object' } },
          },
        },
      },
    },

    '/metric/{protocol}/{kpi}': {
      operationId: 'getMetric',
      summary: 'One standardized KPI for one protocol',
      parameters: [
        param('protocol', 'path', protocolEnum, {
          description: 'Protocol id, as listed at /catalog.',
          example: 'tinyman',
        }),
        param('kpi', 'path', kpiEnum, {
          description: 'KPI id, as listed at /catalog and defined in DATA_SCHEMA.md §4.',
          example: 'capital_efficiency',
        }),
        freshParam(
          'Bypass L0/L1 and force an upstream fetch. Priced higher. NOT CHARGED if we cannot ' +
            'produce a non-stale number — recency is what the tier buys.',
        ),
        basisParam('query'),
      ],
      responses: {
        '200': {
          description: 'One KpiFact.',
          headers: dataHeaders,
          content: jsonContent(ref('KpiFact')),
        },
        ...paymentResponses,
        '400': errorResponse('INVALID_PARAM — unknown basis, or one this protocol does not support. NOT charged.'),
        '404': errorResponse(
          'PROTOCOL_NOT_FOUND, KPI_NOT_FOUND, or KPI_NOT_APPLICABLE (including a KPI this ' +
            'protocol deliberately declines, with the reason). NOT charged.',
        ),
        '502': errorResponse(
          'UPSTREAM_UNAVAILABLE — every tier exhausted, or the best answer sits at the 0.40 ' +
            'confidence floor and its error can no longer be bounded. NOT charged.',
        ),
      },
    },

    '/compare': {
      operationId: 'compareMetric',
      summary: 'One KPI across 2-5 protocols, ranked',
      description:
        'Composed from the same cached facts /metric serves and never cached as a unit, so the ' +
        'composite reports the worst cache state across its legs and can never be fresher than ' +
        'them. Every leg appears in `facts[]`, including failures, as an error fact with a reason.',
      parameters: [
        param('protocols', 'query', paramSchema(ProtocolsCsvSchema), {
          required: true,
          description: 'Comma-separated protocol ids. 2-5 distinct; duplicates are collapsed first.',
          example: 'tinyman,pact,folks',
        }),
        param('metric', 'query', kpiEnum, {
          required: true,
          description: 'KPI id, as listed at /catalog.',
          example: 'capital_efficiency',
        }),
        freshParam('Force an upstream fetch on EVERY leg. Priced higher.'),
        basisParam('query'),
      ],
      responses: {
        '200': {
          description:
            'The comparison. `partial: true` with `excluded_protocols` when some legs failed; ' +
            'this is still charged, because a usable comparison was delivered.',
          headers: dataHeaders,
          content: jsonContent(ref('CompareResponse')),
        },
        ...paymentResponses,
        '400': errorResponse('TOO_FEW_PROTOCOLS / TOO_MANY_PROTOCOLS / INVALID_PARAM. NOT charged.'),
        '404': errorResponse('KPI_NOT_FOUND or PROTOCOL_NOT_FOUND. NOT charged.'),
        '422': errorResponse(
          'KPI_NOT_APPLICABLE_TO_ANY — the metric fits none of the requested protocols, so ' +
            'nothing was computed and nothing could have been. NOT charged.',
        ),
        '502': errorResponse(
          'INSUFFICIENT_DATA — fewer than 2 legs resolved. A one-way comparison is not the ' +
            'product. NOT charged.',
        ),
      },
    },

    '/ask': {
      operationId: 'ask',
      summary: 'Natural-language question, answered strictly from our own facts',
      description:
        'Two model calls: a cheap router turns the question into a plan validated against the live ' +
        'capability matrix, then a synthesizer answers from the fetched KpiFacts and nothing else. ' +
        '`facts[]` is always returned, including under `format: "prose"`, so a downstream agent can ' +
        'ignore the narrative and read the numbers. Descriptive only: no forecasts, no price ' +
        'targets, no advice.',
      parameters: [
        param(
          'depth',
          'query',
          { type: 'string', enum: ['standard', 'deep'], default: 'standard' },
          {
            description:
              'Priced. It is read from the query string and not the body because the 402 is ' +
              'quoted before the body is read; a body `depth` that disagrees with it is a 400.',
          },
        ),
      ],
      requestBody: {
        required: true,
        content: jsonContent(ref('AskRequest')),
      },
      responses: {
        '200': {
          description: 'The grounded answer, its facts, and the plan that produced them.',
          headers: dataHeaders,
          content: jsonContent(ref('AskResponse')),
        },
        ...paymentResponses,
        '400': errorResponse(
          'QUESTION_TOO_LONG (> 500 chars), INVALID_BODY, or DEPTH_MISMATCH. NOT charged.',
        ),
        '422': errorResponse(
          'UNROUTABLE_QUESTION — could not be mapped onto covered protocols and KPIs; the body ' +
            'lists what we do cover. Or OUT_OF_SCOPE — a forecast, a price target, trading advice, ' +
            'or a non-Algorand-DeFi topic. NEITHER IS CHARGED: the routing call is cheap and we eat ' +
            'it rather than charging for a non-answer.',
        ),
        '502': errorResponse(
          'INSUFFICIENT_DATA — routed successfully but fewer than one fact resolved, or the ' +
            'synthesis could not be grounded in the facts we fetched. NOT charged.',
        ),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * `servers[]`, running service first.
 *
 * The deployment an agent fetched this document FROM is the one it should call,
 * so `PUBLIC_BASE_URL` leads. The other network is listed after it, because an
 * agent that found the MainNet spec should be able to discover that a TestNet
 * copy exists to integrate against without paying real USDC.
 */
function servers(net: NetworkConstants): JsonObject[] {
  const here = {
    url: env.PUBLIC_BASE_URL,
    description:
      net.network === 'mainnet'
        ? 'MainNet — paid in real USDC (ASA 31566704). This deployment.'
        : `TestNet — paid in TestNet USDC (ASA ${net.usdcAsaId}). This deployment; integrate here first.`,
  };
  const other =
    net.network === 'mainnet'
      ? { url: 'https://testnet.algoterminal.xyz', description: 'TestNet — identical API, TestNet USDC.' }
      : { url: 'https://api.algoterminal.xyz', description: 'MainNet — identical API, real USDC.' };
  return here.url === other.url ? [here] : [here, other];
}

export function buildOpenApiDocument(net: NetworkConstants = activeNetwork()): JsonObject {
  const ops = operations();
  const gated = new Set(gatedRoutes().map((r) => r.path));
  const paths: Record<string, JsonObject> = {};

  for (const route of ROUTES) {
    const operation = ops[route.path];
    if (operation === undefined) {
      // Loud rather than silent, for the same reason `requireDocs` throws: a
      // route we charge for and do not publish is a route an agent cannot find.
      throw new Error(
        `route "${route.path}" is priced in src/pricing.ts but has no OpenAPI operation ` +
          '(API_SPEC.md §4 publishes the whole route table)',
      );
    }

    const docs = routeDocs(route.path);
    paths[route.path] ??= {};
    (paths[route.path] as JsonObject)[route.method.toLowerCase()] = {
      ...operation,
      ...priceExtensions(route),
      'x-paid': route.paid,
      // `pricing.ts` prices the whole product, including routes a later build
      // step will add; `gatedRoutes()` is the subset that has a handler today.
      // Publishing a route we cannot serve would sell a 402 for a 404.
      ...(route.paid && !gated.has(route.path) ? { 'x-available': false, deprecated: true } : {}),
      ...(docs === undefined ? {} : { 'x-agent-description': docs.description }),
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: SERVICE_NAME,
      version: API_VERSION,
      description:
        'Standardized, agent-native financial KPIs for Algorand DeFi.\n' +
        'Paid per query in USDC over x402 (Algorand ' +
        (net.network === 'mainnet' ? 'MainNet' : 'TestNet') +
        ', GoPlausible facilitator).\n' +
        `Methodology published at ${env.PUBLIC_BASE_URL}/methodology.\n` +
        'Payment settles only after a 2xx. Errors are never charged.',
      license: { name: 'MIT', identifier: 'MIT' },
      'x-x402': {
        version: net.x402Version,
        scheme: net.scheme,
        network: net.caip2,
        asset: String(net.usdcAsaId),
        asset_decimals: net.usdcDecimals,
        facilitator: env.X402_FACILITATOR_URL,
        payTo: env.X402_PAYTO,
        fee_sponsored: FEE_SPONSORED,
        settlement_policy:
          'Payment is settled only after a 2xx response. Every 4xx and 5xx is free.',
      },
      'x-methodology-version': env.METHODOLOGY_VERSION,
    },
    servers: servers(net),
    paths,
    components: { schemas: componentSchemas() },
  };
}
