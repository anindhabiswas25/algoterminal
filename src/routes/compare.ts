import { Hono } from 'hono';

import { getFact } from '../cache/index.js';
import { DEFAULT_PARAMS, type FactParams } from '../cache/keys.js';
import { env } from '../config/env.js';
import { getConnector, listProtocolIds } from '../connectors/registry.js';
import { ApiError } from '../errors.js';
import {
  composeComparison,
  isComparable,
  MIN_COMPARABLE_LEGS,
  type ComparisonLeg,
} from '../standardize/compare.js';
import { isKpiId, KPI_IDS, type KpiId } from '../standardize/kpis.js';
import { makeErrorFact, type KpiFact } from '../standardize/schema.js';
import type { ProtocolClass } from '../standardize/types.js';
import { underFreshBudget } from './budget.js';
import {
  CACHE_HEADER,
  METHODOLOGY_HEADER,
  parseBasis,
  parseFresh,
  resolveTarget,
  unsellable,
} from './metric.js';

/**
 * `GET /compare?protocols=a,b,c&metric=x` — API_SPEC.md §3.2. Paid, flat.
 *
 * This is the route the methodology exists for. `/metric` sells one number;
 * this sells the claim that two numbers from structurally different protocols
 * belong on the same axis, which is the claim DATA_SCHEMA.md §3 spends its
 * length establishing. `capital_efficiency` across a DEX and a lending market
 * is that claim being cashed.
 *
 * Thin, per ARCHITECTURE.md §4.2: it parses, validates against the registry,
 * fetches each leg through the ordinary cached path, and hands the results to
 * `src/standardize/compare.ts`. There is no arithmetic here and no protocol
 * knowledge — no `if (protocol === 'folks')`, and there must never be one.
 *
 * ## Composed, never cached as a unit
 *
 * ARCHITECTURE.md §6 is explicit: `/compare` results are "not cached as a
 * unit. Composed from already-cached component facts. Caching the composite
 * would double the staleness surface for no gain." So each leg is an ordinary
 * `getFact` — sharing the cache, the TTLs, the stampede lock and the L2
 * fallback with `/metric` — and the composite reports the worst cache state
 * across them. A caller cannot be served a composite that is fresher than its
 * legs, because there is no composite stored anywhere to go stale.
 *
 * The legs are fetched in parallel. They are independent keys on independent
 * connectors, and doing them in series would make a five-protocol comparison
 * cost the sum of five upstream latencies on a cold cache.
 *
 * ## What this route charges for
 *
 * Its status code is the gate's entire settle input, so every rule below is a
 * pricing decision as much as a data one:
 *
 *  - **>= 2 legs resolve** -> 200 with `partial: true` and `excluded_protocols`,
 *    and the payment settles. The caller got a usable comparison, and every
 *    leg it did not get is present in `facts[]` as a §2 error fact saying why.
 *  - **< 2 legs resolve** -> 502 `INSUFFICIENT_DATA`, not settled. A one-way
 *    "comparison" is not the product. Charging $0.05 for it would break the
 *    same trust rule that makes an unroutable `/ask` free, and that rule is
 *    published at `/llms.txt` where agent operators read it before integrating.
 *  - **The metric applies to no requested protocol** -> 422
 *    `KPI_NOT_APPLICABLE_TO_ANY`, not settled. Nothing was computed and nothing
 *    could have been.
 */

/** §3.2: "2-5 ids". Two is a comparison; one is a lookup with extra steps. */
export const MIN_PROTOCOLS = MIN_COMPARABLE_LEGS;
/**
 * Five is the flat price's ceiling. §1 prices `/compare` flat "to keep agent
 * budgeting simple", and a flat price only works over a bounded amount of
 * work — the sixth leg is a sixth upstream fetch at the same $0.05.
 */
export const MAX_PROTOCOLS = 5;

/**
 * The csv, deduplicated, in the order the caller wrote it.
 *
 * Duplicates are collapsed rather than rejected or compared against
 * themselves. `protocols=tinyman,tinyman` is a caller bug, but the useful
 * answer to it is not a ranking of Tinyman against Tinyman with a spread ratio
 * of exactly 1.0 — that is a confident-looking non-answer of the kind §1.5
 * rules out, and it would be *settled*. Collapsed, it becomes one protocol,
 * which fails the `MIN_PROTOCOLS` check below and is a free 400 telling the
 * caller exactly what happened.
 *
 * Bounds are checked AFTER collapsing, because the deduplicated list is what
 * determines both the work we do and the answer we return.
 */
export function parseProtocols(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new ApiError(400, 'TOO_FEW_PROTOCOLS', 'The `protocols` query parameter is required.', {
      param: 'protocols',
      min: MIN_PROTOCOLS,
      max: MAX_PROTOCOLS,
      available_protocols: listProtocolIds(),
    });
  }

  const requested = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const unique = [...new Set(requested)];

  if (unique.length < MIN_PROTOCOLS) {
    throw new ApiError(
      400,
      'TOO_FEW_PROTOCOLS',
      `A comparison needs at least ${MIN_PROTOCOLS} distinct protocols; got ${unique.length}.`,
      {
        param: 'protocols',
        provided: requested,
        distinct: unique,
        min: MIN_PROTOCOLS,
        max: MAX_PROTOCOLS,
        available_protocols: listProtocolIds(),
        // Named explicitly, because "I passed two" and "I passed two of the
        // same" produce the same count and very different confusion.
        ...(requested.length > unique.length
          ? { note: 'Duplicate ids were collapsed; a protocol is not compared against itself.' }
          : {}),
      },
    );
  }

  if (unique.length > MAX_PROTOCOLS) {
    throw new ApiError(
      400,
      'TOO_MANY_PROTOCOLS',
      `A comparison takes at most ${MAX_PROTOCOLS} distinct protocols; got ${unique.length}.`,
      {
        param: 'protocols',
        distinct: unique,
        min: MIN_PROTOCOLS,
        max: MAX_PROTOCOLS,
      },
    );
  }

  return unique;
}

/**
 * The KPI, validated against the §4 registry itself.
 *
 * This is a different question from "does protocol X publish it", which is
 * per-leg and becomes an error fact. A metric that is not in the registry at
 * all cannot be compared across anything, so it fails the whole request — and
 * fails it for free.
 */
export function parseMetric(raw: string | undefined): KpiId {
  if (raw === undefined || raw.trim().length === 0) {
    throw new ApiError(404, 'KPI_NOT_FOUND', 'The `metric` query parameter is required.', {
      param: 'metric',
      available_kpis: [...KPI_IDS],
    });
  }
  if (!isKpiId(raw)) {
    throw new ApiError(404, 'KPI_NOT_FOUND', `"${raw}" is not a KPI we publish.`, {
      param: 'metric',
      provided: raw,
      available_kpis: [...KPI_IDS],
    });
  }
  return raw;
}

/**
 * A protocol we do not cover at all fails the whole request rather than
 * becoming an error fact.
 *
 * The distinction is deliberate. `UPSTREAM_UNAVAILABLE` on Pact means "we
 * cover Pact and could not reach it this time" — a transient fact about the
 * world, and exactly what the partial-result policy is for. An unknown id
 * means the caller's request is malformed, will fail identically on every
 * retry, and would otherwise be *settled* as a partial comparison that quietly
 * dropped a protocol the caller believed it was buying.
 */
function requireKnownProtocols(protocols: readonly string[]): void {
  const unknown = protocols.filter((id) => getConnector(id) === undefined);
  if (unknown.length === 0) return;

  throw new ApiError(
    404,
    'PROTOCOL_NOT_FOUND',
    `No connector for ${unknown.length === 1 ? 'protocol' : 'protocols'} ${unknown.map((u) => `"${u}"`).join(', ')}.`,
    { unknown_protocols: unknown, available_protocols: listProtocolIds() },
  );
}

/** The §2 error-fact variant, for a leg that could not be answered. */
function errorLeg(
  protocol: string,
  protocolClass: ProtocolClass,
  metric: KpiId,
  code: string,
  message: string,
  timestamp: string,
): ComparisonLeg {
  return {
    protocol,
    protocolClass,
    fact: makeErrorFact({
      metric,
      protocol,
      code,
      message,
      methodologyVersion: env.METHODOLOGY_VERSION,
      timestamp,
    }),
  };
}

/**
 * Whether a leg's failure is one of *applicability* — the protocol structurally
 * cannot answer this KPI, and no retry will change that.
 *
 * Counted separately from a fetch failure because it is what decides between a
 * 422 (the metric fits none of the requested protocols; nothing was computable)
 * and a 502 (the metric fits them, but too few answered today).
 */
const APPLICABILITY_CODES = new Set(['KPI_NOT_APPLICABLE', 'KPI_NOT_FOUND', 'INVALID_PARAM']);

interface LegOutcome {
  readonly leg: ComparisonLeg;
  /** True when this protocol can never answer this metric, as configured. */
  readonly inapplicable: boolean;
}

/**
 * Resolve and fetch one leg, converting every per-leg failure into a fact.
 *
 * The applicability rules come from `resolveTarget` — the same function
 * `/metric` uses — so a KPI Pact declines produces the identical reason string
 * on both routes, and there is one place those rules live. What differs is
 * only what we do with the failure: `/metric` returns it as the response,
 * `/compare` files it in `facts[]` and carries on with the other legs.
 */
async function fetchLeg(
  protocol: string,
  metric: KpiId,
  params: FactParams,
  fresh: boolean,
  timestamp: string,
): Promise<LegOutcome> {
  // Guaranteed present: `requireKnownProtocols` ran first.
  const protocolClass = (getConnector(protocol) as NonNullable<ReturnType<typeof getConnector>>)
    .capabilities().class;

  try {
    resolveTarget(protocol, metric, params.basis);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      leg: errorLeg(protocol, protocolClass, metric, err.code, err.message, timestamp),
      inapplicable: APPLICABILITY_CODES.has(err.code),
    };
  }

  const fact: KpiFact = await getFact({ protocol, kpi: metric, params }, { fresh });

  // The same two "not worth money" tests `/metric` applies, for the same
  // reason (§3.1.1): a fact at or below the §5 floor is one whose error we can
  // no longer bound, and `?fresh=true` is a no-stale-or-no-charge contract. On
  // `/metric` each is a 502; here each removes one leg, and if that takes the
  // comparison below two legs the route returns its own 502 and is not
  // settled. A number we would not sell alone is not one we will sell inside a
  // ranking, where it would be even harder to notice.
  const problem = unsellable(fact);
  if (problem !== null) {
    return {
      leg: errorLeg(protocol, protocolClass, metric, problem.code, problem.message, timestamp),
      inapplicable: false,
    };
  }

  if (fresh && fact.stale === true) {
    return {
      leg: errorLeg(
        protocol,
        protocolClass,
        metric,
        'UPSTREAM_UNAVAILABLE',
        'Could not produce a fresh value for this leg, and ?fresh=true is not fulfilled by a stale one. ' +
          'Retry without ?fresh=true to include it at the base price.',
        timestamp,
      ),
      inapplicable: false,
    };
  }

  return { leg: { protocol, protocolClass, fact }, inapplicable: false };
}

export const compare = new Hono();

compare.get('/compare', async (c) => {
  const protocols = parseProtocols(c.req.query('protocols'));
  const metric = parseMetric(c.req.query('metric'));
  const fresh = parseFresh(c.req.query('fresh'));
  const params: FactParams = { ...DEFAULT_PARAMS, basis: parseBasis(c.req.query('basis')) };

  requireKnownProtocols(protocols);

  const timestamp = new Date().toISOString();
  // One budget for the whole request, not one per leg (§4g item 2). `?fresh=true`
  // on /compare forces an upstream fetch on EVERY leg — which is why it carries
  // its own price variant — so five legs each given the full budget would be
  // five times the fetch the payment can actually cover. The legs share it, and
  // a leg starved by the ones before it fails the same way any other upstream
  // failure does: L2, `stale: true`, and dropped from the comparison uncharged.
  const outcomes = await underFreshBudget(c, fresh, () =>
    Promise.all(protocols.map((protocol) => fetchLeg(protocol, metric, params, fresh, timestamp))),
  );

  // 422 before 502: "this KPI does not apply to anything you asked for" is a
  // different statement from "it applies and we could not fetch it", and the
  // caller fixes them differently. Neither is settled.
  if (outcomes.every((outcome) => outcome.inapplicable)) {
    throw new ApiError(
      422,
      'KPI_NOT_APPLICABLE_TO_ANY',
      `"${metric}" is not available for any of the requested protocols, so there is nothing to compare.`,
      {
        metric,
        protocols,
        reasons: Object.fromEntries(
          outcomes.map((o) => [o.leg.protocol, o.leg.fact.error?.message ?? null]),
        ),
      },
    );
  }

  const legs = outcomes.map((outcome) => outcome.leg);

  if (!isComparable(legs)) {
    const resolved = legs.filter((leg) => leg.fact.error === undefined).length;
    throw new ApiError(
      502,
      'INSUFFICIENT_DATA',
      `Only ${resolved} of ${legs.length} protocols resolved, and a comparison needs at least ` +
        `${MIN_COMPARABLE_LEGS}. Not charged: a one-way comparison is not the product.`,
      {
        metric,
        protocols,
        resolved,
        required: MIN_COMPARABLE_LEGS,
        reasons: Object.fromEntries(
          legs
            .filter((leg) => leg.fact.error !== undefined)
            .map((leg) => [leg.protocol, leg.fact.error?.message ?? null]),
        ),
      },
    );
  }

  const comparison = composeComparison(legs, {
    metric,
    methodologyVersion: env.METHODOLOGY_VERSION,
    timestamp,
  });

  c.header(CACHE_HEADER, comparison.cache);
  c.header(METHODOLOGY_HEADER, env.METHODOLOGY_VERSION);
  return c.json(comparison);
});
