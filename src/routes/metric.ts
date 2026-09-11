import { Hono } from 'hono';

import { getFact } from '../cache/index.js';
import { DEFAULT_PARAMS, type FactParams } from '../cache/keys.js';
import { env } from '../config/env.js';
import { getConnector, listProtocolIds } from '../connectors/registry.js';
import { ApiError } from '../errors.js';
import { isApplicable, isKpiId, KPI_IDS, type KpiId } from '../standardize/kpis.js';
import { isErrorFact, type KpiFact } from '../standardize/schema.js';
import type { Basis } from '../standardize/types.js';
import { underFreshBudget } from './budget.js';
import { parseBasis, parseFresh } from './params.js';

/**
 * `GET /metric/{protocol}/{kpi}` — API_SPEC.md §3.1. Paid; the gate runs first.
 *
 * ARCHITECTURE.md §4.2 describes this layer as thin, and it is: it validates
 * params against the connector registry, calls the cache, and shapes the
 * envelope. It contains no protocol knowledge and no arithmetic. There is no
 * `if (protocol === ...)` here and there must never be one — that logic belongs
 * in a connector.
 *
 * Its other job is deciding which outcomes are worth money, because this
 * handler's status code is what the gate settles on. Every non-2xx below is a
 * request the caller is NOT charged for.
 */

/** §2.3 — the cache state and methodology version, as headers as well as fields. */
export const CACHE_HEADER = 'X-AlgoTerminal-Cache';
export const METHODOLOGY_HEADER = 'X-AlgoTerminal-Methodology';

/**
 * The confidence at or below which we will not sell a number.
 *
 * 0.40 is the §5 `l2_snapshot` floor. A fact sitting ON that floor is one whose
 * penalty chain bottomed out: the multipliers took it below the floor and the
 * floor caught it, which means we can no longer say how wrong it might be, only
 * that it was true at some point. Selling a number whose error we cannot bound
 * is the one thing DATA_SCHEMA.md §1 rules out, so it is a 502 —
 * `UPSTREAM_UNAVAILABLE` — and the gate does not settle it.
 *
 * Above the floor the penalty is still meaningful and the fact is still
 * labelled, so it is sold. See the stale-serve policy note below.
 */
export const MIN_BILLABLE_CONFIDENCE = 0.4;

/**
 * ## The cold-key stampede policy (ARCHITECTURE.md §4.5, build step 6)
 *
 * Under a cold-key stampede one caller wins the fetch lock and forty-nine are
 * served the L2 last-known-good snapshot at ×0.70 confidence. Behind a payment
 * gate, those forty-nine are each paying for it. Three options were on the
 * table; this is what we do and why.
 *
 * **We charge for a labelled stale answer.** It is a correct answer to the
 * question asked, it is what the caller can act on, and every part of its
 * degradation is on the response: `cache: "stale"`, `stale: true`, a reduced
 * `confidence`, an `X-AlgoTerminal-Cache: stale` header, and a note saying how
 * old the number is and which penalty was applied. A caller that does not want
 * it can see that it got it.
 *
 * **We do not charge for a non-answer.** An exhausted-tiers `UPSTREAM_UNAVAILABLE`
 * is a 502, and 502 skips settle — that was already true. What is added here is
 * the floor above: at or below 0.40 confidence we return 502 rather than sell a
 * number whose error is unbounded.
 *
 * **`?fresh=true` is a no-stale-or-no-charge contract.** The $0.02 tier exists
 * because the caller is buying recency (API_SPEC.md §1: "we sell recency
 * honestly"). If we cannot produce a non-stale number, that request has not been
 * fulfilled, so it is a 502 and it is free. The caller can retry at $0.005 and
 * decide for itself whether the stale number is worth having.
 *
 * Two options were rejected, both on mechanism rather than taste:
 *
 *  - *Refuse to settle any stale serve.* It would return the data and take no
 *    money, which is a free tier on a paid route reachable by anyone willing to
 *    force a cold key — and forcing one is easy, since `?basis=verified_only`
 *    on an unpopular KPI is cold by construction. "No API-key bypass and no free
 *    tier on a paid route" has to mean no accidental ones either.
 *  - *Price a degraded answer lower.* The `exact` scheme settles the amount
 *    quoted in the 402, and the 402 is emitted before the handler runs, so the
 *    cache state is not known at quoting time. Partial settlement exists in
 *    x402 but is documented as valid only for schemes that support it (`upto`),
 *    not `exact`. This is not a policy we declined; it is one the protocol we
 *    chose cannot express.
 *
 * The refresher (§4.6) is what makes all of this rare rather than routine, and
 * `/health` publishes the hit rate that says whether it is working.
 */
export const STALE_SERVE_POLICY =
  'A labelled stale answer is charged for; a non-answer is not. ?fresh=true is not charged unless ' +
  'the number returned is fresh.';

/**
 * `?basis=` and `?fresh=` (§3.1).
 *
 * Re-exported rather than defined here: they are now declared once in
 * `src/routes/params.ts`, where `/openapi.json` also reads them, so the
 * published parameter schema and the validator are the same object. The
 * re-export keeps `/compare` and the existing tests importing them from the
 * route that first owned them.
 */
export { parseBasis, parseFresh } from './params.js';

/**
 * Resolve `{protocol}/{kpi}` against the connector registry.
 *
 * The three 404s of §3.1 are three genuinely different statements, and each
 * carries the list that lets a caller fix its request without a second round
 * trip:
 *
 *  - `PROTOCOL_NOT_FOUND` — we do not cover this protocol at all.
 *  - `KPI_NOT_APPLICABLE` — the KPI exists, but not for this kind of protocol.
 *    `utilization` on a DEX is not a gap in our coverage, it is a category
 *    error, and DATA_SCHEMA.md §1.5 forbids answering it with a zero.
 *  - `KPI_NOT_FOUND` — we do not publish this KPI for this protocol.
 */
export function resolveTarget(protocol: string, kpi: string, basis: Basis): { kpi: KpiId } {
  const connector = getConnector(protocol);
  if (connector === undefined) {
    throw new ApiError(404, 'PROTOCOL_NOT_FOUND', `No connector for protocol "${protocol}".`, {
      protocol,
      available_protocols: listProtocolIds(),
    });
  }

  const caps = connector.capabilities();

  if (isKpiId(kpi) && !isApplicable(kpi, caps.class)) {
    throw new ApiError(
      404,
      'KPI_NOT_APPLICABLE',
      `"${kpi}" is not defined for a ${caps.class} protocol.`,
      {
        protocol,
        kpi,
        protocol_class: caps.class,
        available_kpis: KPI_IDS.filter((id) => isApplicable(id, caps.class)),
      },
    );
  }

  // A KPI this connector deliberately declined (CONNECTOR_GUIDE §Step 3). It is
  // applicable to the class and a buyer will expect it, so the answer names the
  // reason rather than reading as a hole in our coverage (DATA_SCHEMA.md §1.5).
  const declineReason = isKpiId(kpi) ? caps.declined?.[kpi] : undefined;
  if (declineReason !== undefined) {
    throw new ApiError(
      404,
      'KPI_NOT_APPLICABLE',
      `"${protocol}" declines "${kpi}": ${declineReason}`,
      {
        protocol,
        kpi,
        protocol_class: caps.class,
        declined: true,
        available_kpis: [...caps.kpis],
      },
    );
  }

  if (!isKpiId(kpi) || !caps.kpis.includes(kpi)) {
    throw new ApiError(404, 'KPI_NOT_FOUND', `"${protocol}" does not publish "${kpi}".`, {
      protocol,
      kpi,
      available_kpis: [...caps.kpis],
    });
  }

  // A basis this connector does not implement is a bad request, not a missing
  // KPI: `?basis=verified_only` is a real basis (DATA_SCHEMA.md §3.6) that this
  // protocol cannot express, and answering it with the default would silently
  // return a different number than the one asked for.
  if (!caps.supportsBasis.includes(basis)) {
    throw new ApiError(400, 'INVALID_PARAM', `"${protocol}" does not support basis "${basis}".`, {
      param: 'basis',
      provided: basis,
      allowed: [...caps.supportsBasis],
    });
  }

  return { kpi };
}

/** A fact that is not worth money — the gate must not settle these. */
export function unsellable(fact: KpiFact): { code: string; message: string } | null {
  if (isErrorFact(fact)) return { code: fact.error.code, message: fact.error.message };
  if (fact.confidence <= MIN_BILLABLE_CONFIDENCE) {
    return {
      code: 'UPSTREAM_UNAVAILABLE',
      message:
        `The best available answer has confidence ${fact.confidence}, at or below the ${MIN_BILLABLE_CONFIDENCE} ` +
        'floor. Rather than sell a number whose error we cannot bound, we decline and do not charge.',
    };
  }
  return null;
}

export const metric = new Hono();

metric.get('/metric/:protocol/:kpi', async (c) => {
  const protocol = c.req.param('protocol');
  const fresh = parseFresh(c.req.query('fresh'));
  const params: FactParams = { ...DEFAULT_PARAMS, basis: parseBasis(c.req.query('basis')) };
  const { kpi } = resolveTarget(protocol, c.req.param('kpi'), params.basis);

  // The fresh path's upstream fetch is bounded by the payment that bought it
  // (§4g items 1-2). A budget refusal surfaces here as any other upstream
  // failure would: L2 fallback, `stale: true`, and the 502 below.
  const fact = await underFreshBudget(c, fresh, () => getFact({ protocol, kpi, params }, { fresh }));

  const problem = unsellable(fact);
  if (problem !== null) {
    // 502, so the gate skips settle. §3.1: "All tiers exhausted including L2.
    // Not settled — caller not charged."
    throw new ApiError(502, problem.code, problem.message, { protocol, kpi, basis: params.basis });
  }

  // The `?fresh=true` contract: recency is what the higher price buys, so a
  // stale answer has not fulfilled the request and is not charged for.
  if (fresh && fact.stale === true) {
    throw new ApiError(
      502,
      'UPSTREAM_UNAVAILABLE',
      'Could not produce a fresh value, and ?fresh=true is not fulfilled by a stale one. Not charged. ' +
        'Retry without ?fresh=true to buy the labelled stale number at the base price.',
      { protocol, kpi, basis: params.basis, cache: fact.cache },
    );
  }

  c.header(CACHE_HEADER, fact.cache ?? 'miss');
  c.header(METHODOLOGY_HEADER, env.METHODOLOGY_VERSION);
  return c.json(fact);
});
