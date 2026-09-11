import { USDC_DECIMALS } from './config/x402.js';

/**
 * API_SPEC.md §1 — the route and price table, as data.
 *
 * ARCHITECTURE.md §4.1: "Route → price table lives in one module
 * (`src/pricing.ts`) and is the single source of truth for both the middleware
 * config and the `/catalog` response, so the advertised price can never drift
 * from the charged price." This is that module. The payment middleware (step 6)
 * consumes the same `priceAtomic` these `/catalog` strings are rendered from,
 * which is what makes advertised and charged prices structurally incapable of
 * disagreeing — not two constants someone remembers to keep in step.
 *
 * Prices are stored in ATOMIC USDC units (6 decimals), because that is what a
 * payment requirement carries on the wire (§2.1: `"amount": "5000"`), and
 * because integer cents cannot accumulate the float error that `0.1 + 0.2`
 * would introduce into a price we charge.
 */

export type HttpMethod = 'GET' | 'POST';

/**
 * A priced variant of a route. §1's `/metric` row is three prices on one path,
 * selected by query param, so a route is a set of variants rather than a
 * single number.
 *
 * `catalogKey` is the field name this variant takes in the `/catalog` `routes[]`
 * entry (API_SPEC.md §3.4).
 */
export interface PriceVariant {
  /** Stable id, used by the step-6 `DynamicPrice` resolver. */
  readonly id: string;
  /** Atomic USDC units (6 decimals). `5000` = $0.005. */
  readonly amountAtomic: number;
  /** Which request this variant prices, for `/catalog` and `/llms.txt`. */
  readonly when: string;
  /** Field name in the §3.4 `routes[]` entry. */
  readonly catalogKey: string;
}

export interface RouteSpec {
  readonly path: string;
  readonly method: HttpMethod;
  readonly paid: boolean;
  /** §1's "Tier rationale" column. Free routes carry it too — see below. */
  readonly rationale: string;
  /** Empty on a free route. */
  readonly variants: readonly PriceVariant[];
}

/**
 * §1, in table order.
 *
 * The free routes are listed even though nothing charges for them, because the
 * free tier is a compliance-relevant claim (§1: "everything needed to evaluate
 * AlgoTerminal is free"). Keeping them here means "is this route free?" has one
 * answer in one place, and the step-6 middleware gates exactly the routes this
 * table marks paid rather than an allowlist maintained alongside it.
 */
export const ROUTES = [
  {
    path: '/health',
    method: 'GET',
    paid: false,
    rationale: 'Liveness; must never require payment',
    variants: [],
  },
  {
    path: '/catalog',
    method: 'GET',
    paid: false,
    rationale: 'Capability discovery; an agent must be able to learn what we sell before buying',
    variants: [],
  },
  {
    path: '/openapi.json',
    method: 'GET',
    paid: false,
    rationale: 'Machine-readable spec',
    variants: [],
  },
  {
    path: '/llms.txt',
    method: 'GET',
    paid: false,
    rationale: 'Agent discovery (llmstxt.org)',
    variants: [],
  },
  {
    path: '/methodology',
    method: 'GET',
    paid: false,
    rationale: 'Published accounting policy (DATA_SCHEMA.md)',
    variants: [],
  },
  {
    path: '/metric/{protocol}/{kpi}',
    method: 'GET',
    paid: true,
    rationale: 'Cache-backed lookup; >99% gross margin',
    variants: [
      {
        id: 'base',
        amountAtomic: 5_000,
        when: 'Cache-backed lookup',
        catalogKey: 'price_usdc',
      },
      {
        id: 'fresh',
        amountAtomic: 20_000,
        when: '?fresh=true — forces an upstream round-trip; we sell recency honestly',
        catalogKey: 'price_fresh_usdc',
      },
      {
        id: 'active_users',
        amountAtomic: 30_000,
        when: 'kpi=active_users_24h — indexer aggregation is materially more expensive',
        catalogKey: 'price_active_users_usdc',
      },
    ],
  },
  {
    path: '/compare',
    method: 'GET',
    paid: true,
    rationale: 'Multi-source synthesis; flat price keeps agent budgeting simple',
    variants: [
      { id: 'base', amountAtomic: 50_000, when: 'Flat, 2-5 protocols', catalogKey: 'price_usdc' },
      {
        id: 'fresh',
        amountAtomic: 80_000,
        when: '?fresh=true — forces an upstream round-trip on EVERY leg',
        catalogKey: 'price_fresh_usdc',
      },
    ],
  },
  {
    path: '/ask',
    method: 'POST',
    paid: true,
    rationale: 'Two LLM calls + N cached lookups; ~80% margin',
    variants: [
      { id: 'base', amountAtomic: 150_000, when: 'Standard synthesis', catalogKey: 'price_usdc' },
      {
        id: 'deep',
        amountAtomic: 200_000,
        when: '?depth=deep — wider KPI sweep + longer synthesis budget',
        catalogKey: 'price_deep_usdc',
      },
    ],
  },
] as const satisfies readonly RouteSpec[];

export type RoutePath = (typeof ROUTES)[number]['path'];

const BY_PATH = new Map<string, RouteSpec>(ROUTES.map((r) => [r.path, r]));

export function getRoute(path: string): RouteSpec | undefined {
  return BY_PATH.get(path);
}

export function paidRoutes(): RouteSpec[] {
  return ROUTES.filter((r) => r.paid);
}

export function freeRoutes(): RouteSpec[] {
  return ROUTES.filter((r) => !r.paid);
}

/** Is this route free? The one answer to that question (§1 free-tier claim). */
export function isFreeRoute(path: string): boolean {
  return BY_PATH.get(path)?.paid === false;
}

/**
 * The atomic-unit price the step-6 middleware charges. Throws on an unknown
 * route or variant rather than defaulting: a silent fallback price is how a
 * caller gets charged something we never quoted.
 */
export function priceAtomic(path: string, variantId = 'base'): number {
  const route = BY_PATH.get(path);
  if (route === undefined) throw new RangeError(`no route priced at "${path}" (API_SPEC.md §1)`);
  const variant = route.variants.find((v) => v.id === variantId);
  if (variant === undefined) {
    throw new RangeError(`route "${path}" has no price variant "${variantId}" (API_SPEC.md §1)`);
  }
  return variant.amountAtomic;
}

/**
 * Render atomic USDC as the decimal string `/catalog` publishes.
 *
 * Done with integer arithmetic and string padding, never `amount / 1e6`, so
 * the advertised string is an exact rendering of the integer we charge.
 * Trailing zeros are trimmed to match the §1 table's "0.005" / "0.02" / "0.05".
 */
export function formatUsdc(amountAtomic: number): string {
  if (!Number.isInteger(amountAtomic) || amountAtomic < 0) {
    throw new RangeError(`atomic USDC must be a non-negative integer, got ${amountAtomic}`);
  }
  const scale = 10 ** USDC_DECIMALS;
  const whole = Math.floor(amountAtomic / scale);
  const frac = String(amountAtomic % scale)
    .padStart(USDC_DECIMALS, '0')
    .replace(/0+$/, '');
  return frac.length === 0 ? String(whole) : `${whole}.${frac}`;
}

/** The advertised decimal price, e.g. `priceUsdc('/compare')` -> `"0.05"`. */
export function priceUsdc(path: string, variantId = 'base'): string {
  return formatUsdc(priceAtomic(path, variantId));
}

/** One `/catalog` `routes[]` entry (API_SPEC.md §3.4). */
export interface CatalogRoute {
  readonly path: string;
  readonly method: HttpMethod;
  /**
   * False when this deployment cannot actually serve the route — today, `/ask`
   * without an `ANTHROPIC_API_KEY`.
   *
   * `/catalog` is where an agent learns what we sell before it buys, so a route
   * listed with a price and no availability flag is a quote we would then
   * answer 503 to. Set here rather than omitted so the field is always present
   * to check: an agent must not have to infer availability from the absence of
   * a key. `/llms.txt`, `/openapi.json` and the landing page all mark the same
   * route the same way, from the same `gatedRoutes()` call.
   */
  readonly available?: boolean;
  readonly [priceKey: string]: string | boolean | undefined;
}

/**
 * The §3.4 `routes[]` array, generated from the table above.
 *
 * Paid routes only, matching the §3.4 example — the free routes are discovered
 * from `/llms.txt` and the OpenAPI document, and listing them here with no
 * price would invite an agent to parse a missing `price_usdc` as free-by-
 * omission on a route that is merely mis-rendered.
 */
export function catalogRoutes(): CatalogRoute[] {
  return paidRoutes().map((route) => {
    const entry: Record<string, string> = { path: route.path, method: route.method };
    for (const variant of route.variants) entry[variant.catalogKey] = formatUsdc(variant.amountAtomic);
    return entry as unknown as CatalogRoute;
  });
}
