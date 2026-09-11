import { z } from 'zod';

import type { HTTPRequestContext, RouteConfig, RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import { askConfigured } from '../ask/client.js';
import { env } from '../config/env.js';
import { activeNetwork, type NetworkConstants } from '../config/x402.js';
import { formatUsdc, paidRoutes, priceAtomic, type RouteSpec } from '../pricing.js';
import { QUOTED_TIMEOUT_SECONDS } from './deadline.js';
import { SERVICE_NAME } from '../routes/catalog.js';

/**
 * `src/pricing.ts` -> x402 `RoutesConfig`.
 *
 * ARCHITECTURE.md §4.1: the route/price table is the single source of truth for
 * both the middleware config and `/catalog`. This module is the half that feeds
 * the middleware. Nothing here contains a price; every amount is read from
 * `priceAtomic()`, the same function `/catalog` renders its strings from, so
 * the advertised price and the charged price are the same integer rather than
 * two constants someone has to keep in step.
 *
 * The price is resolved BEFORE the 402 is emitted — the `DynamicPrice` function
 * runs while the requirements are being built (API_SPEC.md §1: "the caller is
 * always quoted the exact amount it will be charged. We never quote low and
 * charge high").
 */

/** DEPLOYMENT.md §6.1 — required on every paid route for challenge tracking. */
export const CHALLENGE_TAG = 'x402-global-challenge';
export const DISCOVERY_TAGS = [CHALLENGE_TAG, 'defi', 'algorand', 'analytics', 'kpi'] as const;
export const DISCOVERY_CATEGORY = 'financial-data';

/**
 * §2.1 `maxTimeoutSeconds` — re-exported from the module that enforces it.
 *
 * It used to be a 60 defined here and used nowhere else, which made it a number
 * we advertised and never checked. It is now {@link QUOTED_TIMEOUT_SECONDS},
 * the same constant the gate caps every paid handler at, so the figure on the
 * 402 is the figure that governs. See `gate/deadline.ts` for why it moved from
 * 60 to 30, and `/llms.txt` for the caller's half of the contract — the
 * validity window on the payment the caller itself builds, which we can
 * explain but cannot promise.
 */
export const MAX_TIMEOUT_SECONDS = QUOTED_TIMEOUT_SECONDS;

/**
 * `/metric/{protocol}/{kpi}` -> `GET /metric/:protocol/:kpi`.
 *
 * The two syntaxes describe the same route: `src/pricing.ts` uses the
 * `{param}` form API_SPEC.md §1 publishes, and the x402 route matcher uses
 * Hono's `:param` form. Deriving one from the other means a new paid route is
 * still one line in `pricing.ts`.
 */
export function toX402Pattern(route: RouteSpec): string {
  return `${route.method} ${route.path.replace(/\{([^}]+)\}/g, ':$1')}`;
}

/** A regex that matches request paths for a `pricing.ts` route path. */
function pathMatcher(path: string): RegExp {
  const body = path
    .split('/')
    .map((segment) =>
      /^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${body}$`);
}

let matchers: readonly { route: RouteSpec; regex: RegExp }[] | null = null;

/**
 * The paid route this request hits, or undefined if it is free or not yet built.
 *
 * The gate consults this rather than an allowlist of its own, so `paid` in
 * `pricing.ts` is the one answer to "does this cost money?" — a paid route that
 * someone forgot to add to a second list would otherwise be served for nothing,
 * which is the failure API_SPEC.md §1's free-tier claim cannot survive.
 *
 * Built from {@link gatedRoutes}, not `paidRoutes()`: `pricing.ts` prices the
 * whole product, including routes later build steps will add. Lazily, because
 * `gatedRoutes` is defined below.
 */
export function matchPaidRoute(path: string, method: string): RouteSpec | undefined {
  matchers ??= gatedRoutes().map((route) => ({ route, regex: pathMatcher(route.path) }));
  const upper = method.toUpperCase();
  return matchers.find((m) => m.route.method === upper && m.regex.test(path))?.route;
}

// ---------------------------------------------------------------------------
// Variant selection — which of a route's prices this request pays
// ---------------------------------------------------------------------------

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isTrue(value: string | string[] | undefined): boolean {
  const v = first(value);
  return v === 'true' || v === '1';
}

/** The KPI segment of `/metric/{protocol}/{kpi}`. */
export function kpiFromPath(path: string): string | undefined {
  return path.split('/')[3];
}

/**
 * Which variants a request qualifies for, per route.
 *
 * `base` is always in the list; everything else is a cost this particular
 * request imposes. `/compare?fresh=true` forces an upstream round-trip on
 * every leg rather than on one, which is why it carries its own variant
 * (API_SPEC.md §3.2) instead of being priced flat with the cached path.
 */
function applicableVariants(
  route: RouteSpec,
  path: string,
  query: (name: string) => string | string[] | undefined,
): string[] {
  const applicable = ['base'];
  if (isTrue(query('fresh'))) applicable.push('fresh');
  if (route.path === '/metric/{protocol}/{kpi}' && kpiFromPath(path) === 'active_users_24h') {
    applicable.push('active_users');
  }
  // §3.3's `depth`. It is read from the QUERY STRING and not from the request
  // body, and that is a payment constraint rather than a stylistic choice: the
  // 402 is emitted before the handler runs and before the body is read, so the
  // body cannot participate in pricing a request we have already quoted. The
  // handler rejects a body `depth` that disagrees with what was quoted rather
  // than doing deep work at the standard price (`src/routes/ask.ts`).
  if (route.path === '/ask' && first(query('depth')) === 'deep') applicable.push('deep');
  // A variant the route does not price is not applicable to it, whatever the
  // query says: `?fresh=true` on a route with no `fresh` variant must resolve
  // to `base`, not throw out of `priceAtomic` while building a 402.
  return applicable.filter((id) => route.variants.some((v) => v.id === id));
}

/**
 * The variant id for any paid route: the HIGHEST-priced variant this request
 * qualifies for.
 *
 * Selection is by amount rather than by a hand-written precedence chain, so a
 * request that is both `?fresh=true` and `active_users_24h` pays for both costs
 * it imposes, and adding a fourth variant to `pricing.ts` cannot silently
 * under-quote. Taking the lower would quote below what the request costs us,
 * which is the direction that ends in a route we lose money on.
 */
export function variantIdFor(route: RouteSpec, ctx: HTTPRequestContext): string {
  return variantIdForRequest(route, ctx.path, (name) => ctx.adapter.getQueryParam?.(name));
}

export function variantIdForRequest(
  route: RouteSpec,
  path: string,
  query: (name: string) => string | string[] | undefined,
): string {
  return applicableVariants(route, path, query).reduce((best, id) =>
    priceAtomic(route.path, id) > priceAtomic(route.path, best) ? id : best,
  );
}

/** The atomic-unit price this exact request will be charged. */
export function priceFor(route: RouteSpec, ctx: HTTPRequestContext): number {
  return priceAtomic(route.path, variantIdFor(route, ctx));
}

// ---------------------------------------------------------------------------
// The 402 body (API_SPEC.md §2.1)
// ---------------------------------------------------------------------------

/**
 * The 402 body, as zod — the source of `/openapi.json`'s `PaymentRequiredBody`
 * component (API_SPEC.md §4).
 *
 * A 402 is the first thing an agent that has never called us sees, and §2.1
 * makes its body a documented contract rather than a courtesy. Publishing a
 * component generated from anything other than what {@link unpaidBody} builds
 * would put the one response every integration starts from into the category
 * of things nobody checks. A test parses a real 402 body with this.
 */
export const UnpaidBodyPriceSchema = z.strictObject({
  amount_atomic: z.string(),
  amount_usdc: z.string(),
  asset: z.string(),
  asset_symbol: z.string(),
  decimals: z.number().int(),
  network: z.string(),
  scheme: z.string(),
  x402Version: z.number().int(),
  payTo: z.string(),
  facilitator: z.string(),
  fee_sponsored: z.boolean(),
  /** Which of the route's price variants this request was quoted at. */
  variant: z.string(),
});

export const UnpaidBodySchema = z.strictObject({
  error: z.literal('payment_required'),
  resource: z.string(),
  description: z.string(),
  mimeType: z.string(),
  price: UnpaidBodyPriceSchema,
  discovery: z.strictObject({
    tags: z.array(z.string()),
    category: z.string(),
    input_example: z.record(z.string(), z.unknown()),
    output_example: z.record(z.string(), z.unknown()),
  }),
  docs: z.string(),
  settlement_policy: z.string(),
});

export interface UnpaidBodyPrice {
  amount_atomic: string;
  amount_usdc: string;
  asset: string;
  asset_symbol: string;
  decimals: number;
  network: string;
  scheme: string;
  x402Version: number;
  payTo: string;
  facilitator: string;
  fee_sponsored: boolean;
  variant: string;
}

export interface UnpaidBody {
  error: string;
  resource: string;
  description: string;
  mimeType: string;
  price: UnpaidBodyPrice;
  discovery: {
    tags: readonly string[];
    category: string;
    input_example: Record<string, unknown>;
    output_example: Record<string, unknown>;
  };
  docs: string;
  settlement_policy: string;
}

/**
 * The plain-JSON body that accompanies every 402.
 *
 * API_SPEC.md §2.1: "The response **body** (not just the header) restates
 * price, resource, and description in plain JSON, so an agent that does not yet
 * speak x402 still learns what it costs and why." The `PAYMENT-REQUIRED` header
 * is the machine contract; this is the part a caller can read without an x402
 * library, and it is the difference between a 402 that teaches and one that
 * just refuses.
 *
 * The price here is resolved through the SAME `priceFor` the middleware charges
 * from, so the quoted body and the charged amount are one value.
 */
export function unpaidBody(
  route: RouteSpec,
  ctx: HTTPRequestContext,
  net: NetworkConstants = activeNetwork(),
): UnpaidBody {
  const variant = variantIdFor(route, ctx);
  const amount = priceAtomic(route.path, variant);
  const spec = requireDocs(route.path);

  return {
    error: 'payment_required',
    resource: `${env.PUBLIC_BASE_URL}${ctx.path}`,
    description: spec.description,
    mimeType: 'application/json',
    price: {
      amount_atomic: String(amount),
      amount_usdc: formatUsdc(amount),
      asset: String(net.usdcAsaId),
      asset_symbol: net.usdcSymbol,
      decimals: net.usdcDecimals,
      network: net.caip2,
      scheme: net.scheme,
      x402Version: net.x402Version,
      payTo: env.X402_PAYTO,
      facilitator: env.X402_FACILITATOR_URL,
      fee_sponsored: true,
      variant,
    },
    discovery: {
      tags: DISCOVERY_TAGS,
      category: DISCOVERY_CATEGORY,
      input_example: spec.inputExample,
      output_example: spec.outputExample,
    },
    docs: `${env.PUBLIC_BASE_URL}/llms.txt`,
    // The one purchasing consideration an agent cannot infer from the price.
    settlement_policy:
      'Payment is settled only after a 2xx response. Errors are never charged (API_SPEC.md §2.3).',
  };
}

// ---------------------------------------------------------------------------
// Per-route prose and examples
// ---------------------------------------------------------------------------

/**
 * `declareDiscoveryExtension`'s config minus `output`, which every route fills
 * from its own `outputExample`.
 *
 * The omit has to distribute: the library's input type is a UNION of a query
 * shape, a body shape and an MCP shape, and a plain `Omit` over a union
 * collapses it to the keys they share — which is none of the ones we set. The
 * conditional below applies `Omit` to each member separately.
 */
type DistributiveOmitOutput<T> = T extends unknown ? Omit<T, 'output'> : never;
type DiscoveryDeclaration = DistributiveOmitOutput<Parameters<typeof declareDiscoveryExtension>[0]>;

interface RouteDocs {
  readonly description: string;
  readonly inputExample: Record<string, unknown>;
  readonly outputExample: Record<string, unknown>;
  /**
   * The route's own Bazaar declaration, minus the `output` block (which is
   * always `outputExample`). Per-route rather than shared, because the two
   * paid routes take their arguments in completely different places:
   * `/metric` is two path segments, `/compare` is two query parameters. A
   * single shared block would have advertised `/compare` with `/metric`'s
   * path params, which is a listing an agent cannot call.
   */
  readonly discovery: DiscoveryDeclaration;
}

/**
 * DEPLOYMENT.md §6.1 requires "a one-sentence description written for an agent,
 * not a human" plus a concrete input and output example on every paid route's
 * 402. They live here, next to the route table they describe, rather than
 * inline in the middleware.
 *
 * Presence in this map is also what marks a paid route as BUILT. `pricing.ts`
 * is the price table for the whole product and already carries `/compare`
 * (step 9) and `/ask` (step 10); gating a route whose handler does not exist
 * would sell a 402 for a 404. A route absent here is simply not gated, and
 * since it has no handler either, it 404s — nothing paid is ever given away,
 * which is the property the gate has to preserve.
 */
const ROUTE_DOCS: Record<string, RouteDocs> = {
  '/metric/{protocol}/{kpi}': {
    description:
      'One standardized financial KPI for one Algorand DeFi protocol, in USD or as a decimal ratio, with per-response provenance, cache state and a 0-1 confidence score.',
    inputExample: { method: 'GET', path: '/metric/tinyman/tvl' },
    outputExample: {
      metric: 'tvl',
      protocol: 'tinyman',
      // Measured against the live route on 2026-09-09, not invented. The
      // example previously read `value: 6300000, confidence: 0.95` while the
      // route served ~5.34M at 0.70 — and §6.1's warning is that an agent may
      // plan against this block, so a confidence it will never see is exactly
      // the kind of inaccuracy that is worse than no example at all. tvl is
      // denominated in USD, so §5's usd_conversion row caps it at 0.90 times a
      // TVL-weighted price confidence; 0.95 was never reachable here.
      value: 5344337.0,
      unit: 'USD',
      confidence: 0.7,
    },
    discovery: {
      pathParams: { protocol: 'tinyman', kpi: 'tvl' },
      pathParamsSchema: {
        properties: {
          protocol: { type: 'string', description: 'Protocol id, as listed at /catalog' },
          kpi: { type: 'string', description: 'KPI id, as listed at /catalog' },
        },
        required: ['protocol', 'kpi'],
      },
      input: { fresh: 'false', basis: 'all_pools_usd_priced' },
      inputSchema: {
        properties: {
          fresh: {
            type: 'string',
            enum: ['true', 'false'],
            description: 'Bypass the cache and force an upstream fetch. Priced higher.',
          },
          basis: {
            type: 'string',
            enum: ['all_pools_usd_priced', 'verified_only'],
            description: 'Inclusion basis (DATA_SCHEMA.md §3.6).',
          },
        },
      },
    },
  },
  '/compare': {
    description:
      'One standardized KPI across 2-5 Algorand DeFi protocols at once, ranked, with the spread between them and a generated statement of what makes them comparable - including across protocol types, so a DEX and a lending market can be ranked on the same axis.',
    inputExample: {
      method: 'GET',
      path: '/compare?protocols=tinyman,pact,folks&metric=capital_efficiency',
    },
    outputExample: {
      metric: 'capital_efficiency',
      unit: 'RATIO',
      ranking: [{ rank: 1, protocol: 'tinyman', value: 0.0754 }],
      spread: { max: 0.0754, min: 0.0196, ratio: 3.847 },
      comparability: { confidence: 0.7, caveats: ['...'] },
    },
    discovery: {
      input: {
        protocols: 'tinyman,pact,folks',
        metric: 'capital_efficiency',
        fresh: 'false',
        basis: 'all_pools_usd_priced',
      },
      inputSchema: {
        properties: {
          protocols: {
            type: 'string',
            description: 'Comma-separated protocol ids, 2-5 distinct, as listed at /catalog.',
          },
          metric: { type: 'string', description: 'KPI id, as listed at /catalog.' },
          fresh: {
            type: 'string',
            enum: ['true', 'false'],
            description: 'Force an upstream fetch on every leg. Priced higher.',
          },
          basis: {
            type: 'string',
            enum: ['all_pools_usd_priced', 'verified_only'],
            description: 'Inclusion basis (DATA_SCHEMA.md §3.6).',
          },
        },
        required: ['protocols', 'metric'],
      },
    },
  },
  '/ask': {
    description:
      'A natural-language question about Algorand DeFi, answered strictly from AlgoTerminal\'s own standardized KPIs, with every fact the answer rests on returned alongside the prose so the narrative can be verified or ignored. Descriptive only: no forecasts, no price targets, no advice. The question travels in the JSON request body; ?depth=deep is the only query parameter, and is priced higher.',
    inputExample: {
      method: 'POST',
      path: '/ask',
      body: {
        question: 'Which Algorand DeFi protocol generates the most fee revenue per dollar of TVL?',
        format: 'both',
      },
    },
    outputExample: {
      question: 'Which Algorand DeFi protocol generates the most fee revenue per dollar of TVL?',
      answer:
        'Tinyman generates the most fee revenue per dollar of TVL, at a capital efficiency of 0.0737 (7.37% annualized)...',
      facts: [{ metric: 'capital_efficiency', protocol: 'tinyman', value: 0.0737, unit: 'RATIO' }],
      plan: { protocols: ['tinyman', 'pact', 'folks'], kpis: ['capital_efficiency'], comparison_type: 'cross_class_comparison' },
      confidence: 0.7,
    },
    discovery: {
      /**
       * `bodyType: 'json'` is load-bearing, not decoration.
       *
       * `declareDiscoveryExtension` has two HTTP branches, and it picks between
       * them on the presence of this field alone. Without it, a POST route's
       * `input` is rendered into the discovery block as **`queryParams`** — so
       * the block told an agent to send `POST /ask?question=...&format=both`,
       * which this handler answers 400 to. DEPLOYMENT.md §6.1's warning is that
       * an inaccurate example is worse than none because an agent may plan
       * against it, and that was exactly the shape of the bug: nothing failed
       * on our side, and the caller's first request failed on theirs.
       *
       * `depth` is deliberately NOT in here. It is a query parameter, not a
       * body field — it has to be, because it is priced and the 402 is quoted
       * before the body is read — and the body branch has no `queryParams` to
       * put it in. Declaring it beside the body fields would restate the same
       * error one field smaller, so it lives in `description` instead, where it
       * cannot be mistaken for part of the JSON.
       */
      bodyType: 'json',
      input: {
        question: 'Which Algorand DeFi protocol generates the most fee revenue per dollar of TVL?',
        format: 'both',
        max_facts: 12,
      },
      inputSchema: {
        properties: {
          question: {
            type: 'string',
            description: 'A natural-language question about Algorand DeFi protocol accounting. Max 500 characters.',
          },
          format: {
            type: 'string',
            enum: ['prose', 'facts', 'both'],
            description: 'facts[] is returned under all three; format only controls whether prose is written.',
          },
          max_facts: { type: 'integer', description: '1-24, default 12.' },
        },
        required: ['question'],
      },
    },
  },
};

/**
 * The §6.1 prose for a route, or a throw. Called only on routes the gate has
 * already matched, so a miss here is a route configured as paid with no
 * discovery block — a Bazaar listing with no description, which DEPLOYMENT.md
 * §6.1 makes a submission requirement. Loud beats invisible.
 */
function requireDocs(path: string): RouteDocs {
  const spec = ROUTE_DOCS[path];
  if (spec === undefined) {
    throw new Error(
      `paid route "${path}" has no ROUTE_DOCS entry — DEPLOYMENT.md §6.1 requires a description, ` +
        'input example and output example on every paid route',
    );
  }
  return spec;
}

/** The §6.1 prose for a route, or undefined when the route is not built yet. */
export function routeDocs(path: string): RouteDocs | undefined {
  return ROUTE_DOCS[path];
}

/**
 * Paid routes this deployment can actually serve, and therefore gates.
 *
 * Two conditions, and both exist to stop the gate selling a 402 for a request
 * that then fails:
 *
 *  - a `ROUTE_DOCS` entry, i.e. the route has a handler (see above);
 *  - for `/ask`, a configured `ANTHROPIC_API_KEY`. `/ask` is the one route
 *    whose availability is a deployment-time choice rather than a build-time
 *    one: a service without the key still serves `/metric`, `/compare` and
 *    every free route perfectly well, so the key is not a boot requirement
 *    (`src/config/env.ts`). Quoting $0.15 for a route that would then answer
 *    503 is exactly the failure the `ROUTE_DOCS` gate exists to prevent, so it
 *    is prevented the same way: unconfigured means ungated, and `/llms.txt`
 *    and `/openapi.json` both mark it unavailable rather than advertising it.
 */
export function gatedRoutes(askAvailable: boolean = askConfigured()): RouteSpec[] {
  return paidRoutes().filter((route) => {
    if (routeDocs(route.path) === undefined) return false;
    // A parameter with a default, like `buildRoutes(net)` and
    // `cacheKey(key, version)` elsewhere: the property "an unconfigured
    // deployment does not gate /ask" is only testable if the condition can be
    // supplied, since `env` is parsed once at import and cannot be un-set.
    if (route.path === '/ask') return askAvailable;
    return true;
  });
}

// ---------------------------------------------------------------------------
// RoutesConfig
// ---------------------------------------------------------------------------

/**
 * The Bazaar discovery declaration (DEPLOYMENT.md §6.1, ARCHITECTURE.md §5.3).
 *
 * Declared through `declareDiscoveryExtension` rather than hand-written into
 * `extra`, so the shape is the one the Bazaar indexer validates rather than the
 * one we guessed. Getting this wrong is invisible until the listing does not
 * appear, which is the worst kind of bug to hold until submission day.
 */
function discoveryExtension(spec: RouteDocs): Record<string, unknown> {
  return declareDiscoveryExtension({
    ...spec.discovery,
    output: { example: spec.outputExample },
  } as Parameters<typeof declareDiscoveryExtension>[0]) as unknown as Record<string, unknown>;
}

/**
 * One `RouteConfig` per paid route, generated from `pricing.ts`.
 *
 * `payTo`, `network` and the asset all come from validated config; `price` is a
 * `DynamicPrice` closure over `priceFor`. Passing the price as an explicit
 * `AssetAmount` rather than as a dollar string is deliberate: it hands the
 * scheme the exact integer `pricing.ts` holds, instead of a decimal string that
 * would be re-parsed into one. There is no rounding step in which $0.005 can
 * become 4999 or 5001.
 */
export function buildRoutes(
  net: NetworkConstants = activeNetwork(),
  askAvailable?: boolean,
): RoutesConfig {
  const routes: Record<string, RouteConfig> = {};

  // A parameter with a default, for the same reason `gatedRoutes` takes one:
  // `/ask`'s discovery block is only reachable through here when the route is
  // gated, so without this the block ships unverified on exactly the
  // deployments that do not configure a key — which is all of them today.
  for (const route of gatedRoutes(askAvailable)) {
    const spec = requireDocs(route.path);
    routes[toX402Pattern(route)] = {
      accepts: {
        scheme: net.scheme,
        network: net.caip2 as Network,
        payTo: env.X402_PAYTO,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        price: (ctx: HTTPRequestContext) => ({
          amount: String(priceFor(route, ctx)),
          asset: String(net.usdcAsaId),
        }),
        // §2.1's `extra.decimals`. `extra.feePayer` is NOT set here: it is
        // filled from the facilitator's own /supported response by the AVM
        // scheme, which is the only source that can be right about whose
        // address is sponsoring the fee.
        extra: { decimals: net.usdcDecimals },
      },
      description: spec.description,
      mimeType: 'application/json',
      serviceName: SERVICE_NAME,
      tags: [...DISCOVERY_TAGS],
      unpaidResponseBody: (ctx) => ({
        contentType: 'application/json',
        body: unpaidBody(route, ctx, net),
      }),
      extensions: discoveryExtension(spec),
    };
  }

  return routes;
}
