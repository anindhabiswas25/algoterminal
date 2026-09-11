import { Hono } from 'hono';

import { cacheDeps, getFact } from '../cache/index.js';
import { DEFAULT_PARAMS } from '../cache/keys.js';
import { env } from '../config/env.js';
import { getConnector } from '../connectors/registry.js';
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';
import { priceUsdc } from '../pricing.js';
import { combineConfidence } from '../standardize/confidence.js';
import { isSuccessFact, type KpiFact, type SuccessFact } from '../standardize/schema.js';
import {
  askCacheKey,
  cacheableTtlSeconds,
  readAskCache,
  writeAskCache,
} from '../ask/cache.js';
import { coverageSummary, validatePlan, type UnavailablePair } from '../ask/capabilities.js';
import { askConfigured, totalCostUsd, type CallUsage } from '../ask/client.js';
import {
  buildGroundingPayload,
  generatedCaveats,
  toGroundedFact,
  type GroundedFact,
  type UnavailableEntry,
} from '../ask/grounding.js';
import { routeQuestion, type RouterResult } from '../ask/router.js';
import { synthesize } from '../ask/synthesize.js';
import {
  AskResponseSchema,
  ROUTER_NOT_CONFIGURED,
  type AskResponse,
  type Plan,
} from '../ask/schema.js';
import {
  AskRequestSchema,
  DEFAULT_MAX_FACTS,
  DepthSchema,
  MAX_QUESTION_CHARS,
  type AskFormat,
  type Depth,
} from './params.js';
import { CACHE_HEADER, METHODOLOGY_HEADER, unsellable } from './metric.js';

/**
 * `POST /ask` — API_SPEC.md §3.3. Paid, $0.15 / $0.20.
 *
 * The route is an orchestrator, not a brain. It parses, routes, fetches through
 * the ordinary cached path, synthesizes, and decides which outcomes are worth
 * money. Every rule it enforces lives in a module it calls:
 * `src/ask/capabilities.ts` decides what is answerable, `src/ask/grounding.ts`
 * decides what is sellable, `src/ask/cache.ts` decides what is storable.
 *
 * ## What is and is not charged
 *
 * This handler's status code is the gate's entire settle input, so each of
 * these is a pricing decision:
 *
 *  - **200** — an answer grounded in at least one fact. Charged.
 *  - **422 `OUT_OF_SCOPE`** — a forecast, a price target, advice, or a topic
 *    that is not Algorand DeFi. **Not charged.**
 *  - **422 `UNROUTABLE_QUESTION`** — could not be mapped onto the registry.
 *    Body lists what we do cover. **Not charged.**
 *  - **502 `INSUFFICIENT_DATA`** — routed, but nothing resolved, or the
 *    synthesis could not be grounded after a correction. **Not charged.**
 *  - **400** — malformed body, over-long question, or a `depth` that
 *    disagrees with what the payment quoted. **Not charged.**
 *
 * The first two are the trust rule from steps 7 and 11, published in
 * `/llms.txt`: an agent that learns it can probe `/ask` safely will integrate
 * it; one billed $0.15 for "we don't cover that" will not call twice. Both cost
 * us one Haiku call, which is worth less than the integration.
 */

const log = logger.child({ component: 'ask' });

/**
 * Anthropic usage, logged per request.
 *
 * Emitted on every answered call so `PRD.md` §5.3's "~80% gross margin" is a
 * measured claim. `revenue_usd` is read from the price table rather than
 * written here, so the logged margin follows a price change automatically.
 */
function logMargin(args: {
  question: string;
  depth: Depth;
  calls: readonly CallUsage[];
  factCount: number;
  cache: string;
  corrections: number;
}): void {
  const costUsd = totalCostUsd(args.calls);
  const revenueUsd = Number(priceUsdc('/ask', args.depth === 'deep' ? 'deep' : 'base'));
  log.info(
    {
      depth: args.depth,
      cache: args.cache,
      facts: args.factCount,
      corrections: args.corrections,
      calls: args.calls.map((c) => ({
        model: c.model,
        input: c.inputTokens,
        output: c.outputTokens,
        cache_read: c.cacheReadTokens,
      })),
      cost_usd: Number(costUsd.toFixed(6)),
      revenue_usd: revenueUsd,
      margin: revenueUsd === 0 ? null : Number(((revenueUsd - costUsd) / revenueUsd).toFixed(4)),
      question_chars: args.question.length,
    },
    'ask.margin',
  );
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

export interface AskParams {
  readonly question: string;
  readonly depth: Depth;
  readonly maxFacts: number;
  readonly format: AskFormat;
}

/**
 * Parse the body, and reconcile `depth` with what the payment was quoted on.
 *
 * §3.3 puts `depth` in the request body; §1 and `src/pricing.ts` make it a
 * price variant. Those cannot both be the last word, because the 402 is emitted
 * before the handler runs and therefore before the body exists — the gate can
 * only see the query string (`src/gate/routes.ts`).
 *
 * So the QUERY parameter is authoritative for price, the body field is accepted
 * for schema compatibility, and a disagreement is a free 400 rather than either
 * of the two silent failures available: doing deep work at the standard price,
 * or charging the deep price for a standard answer. §1 is explicit that "we
 * never quote low and charge high", and the converse is just as much a bug.
 */
export function parseAskRequest(body: unknown, depthQuery: string | undefined): AskParams {
  const quoted = depthQuery === undefined ? 'standard' : DepthSchema.safeParse(depthQuery);
  if (quoted !== 'standard' && !quoted.success) {
    throw new ApiError(400, 'INVALID_PARAM', `Unknown depth "${depthQuery}".`, {
      param: 'depth',
      provided: depthQuery,
      allowed: ['standard', 'deep'],
    });
  }
  const quotedDepth: Depth = quoted === 'standard' ? 'standard' : quoted.data;

  const parsed = AskRequestSchema.safeParse(body);
  if (!parsed.success) {
    // The length rule gets its own code because §3.3 names one, and because
    // "your question is 900 characters" is a different fix from "your JSON is
    // malformed".
    const tooLong = parsed.error.issues.some(
      (issue) => issue.path[0] === 'question' && issue.code === 'too_big',
    );
    if (tooLong) {
      throw new ApiError(
        400,
        'QUESTION_TOO_LONG',
        `A question may be at most ${MAX_QUESTION_CHARS} characters.`,
        { max_chars: MAX_QUESTION_CHARS },
      );
    }
    throw new ApiError(400, 'INVALID_BODY', 'The request body does not match the /ask schema.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const bodyDepth = parsed.data.depth;
  if (bodyDepth !== undefined && bodyDepth !== quotedDepth) {
    throw new ApiError(
      400,
      'DEPTH_MISMATCH',
      `The body asks for depth "${bodyDepth}" but the payment was quoted for "${quotedDepth}". ` +
        'depth is priced, and the price is quoted before the body is read, so it must be set as ' +
        `the query parameter ?depth=${bodyDepth}. Not charged.`,
      { body_depth: bodyDepth, quoted_depth: quotedDepth, param: 'depth' },
    );
  }

  return {
    question: parsed.data.question,
    depth: quotedDepth,
    maxFacts: parsed.data.max_facts ?? DEFAULT_MAX_FACTS,
    format: parsed.data.format ?? 'both',
  };
}

// ---------------------------------------------------------------------------
// Routing outcomes -> HTTP
// ---------------------------------------------------------------------------

/** A router decline, as the §3.3 error it corresponds to. Neither is charged. */
function declineToError(result: Extract<RouterResult, { kind: 'decline' }>): ApiError {
  if (result.reason === 'out_of_scope') {
    return new ApiError(422, 'OUT_OF_SCOPE', result.explanation, {
      policy:
        'AlgoTerminal is descriptive only: it publishes what protocols did and what the numbers ' +
        'mean. It does not forecast, set price targets, or give trading or investment advice. ' +
        'Not charged.',
      methodology_url: `${env.PUBLIC_BASE_URL}/methodology`,
    });
  }
  return new ApiError(422, 'UNROUTABLE_QUESTION', result.explanation, {
    ...coverageSummary(),
    note_not_charged:
      'Not charged. The routing call is cheap and we eat it rather than charging for a ' +
      'non-answer — probe freely.',
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

interface FetchedFacts {
  readonly facts: readonly SuccessFact[];
  readonly grounded: readonly GroundedFact[];
  readonly unavailable: readonly UnavailableEntry[];
}

function unavailableEntry(pair: UnavailablePair): UnavailableEntry {
  const caps = getConnector(pair.protocol)?.capabilities();
  return {
    protocol: pair.protocol,
    protocol_name: caps?.name ?? pair.protocol,
    metric: pair.kpi,
    reason: pair.reason,
    declined: pair.declined,
  };
}

/**
 * Fetch every planned pair through the ordinary cached path.
 *
 * `getFact` — the same function `/metric` and `/compare` call — so `/ask`
 * shares the cache, the TTLs, the stampede lock and the L2 fallback with them.
 * An `/ask` that warmed its own cache would double our upstream cost and make
 * two routes disagree about the same number at the same instant.
 *
 * In parallel: the pairs are independent keys, and a five-fact answer on a cold
 * cache would otherwise cost the sum of five upstream latencies.
 *
 * A fact that comes back unsellable (`unsellable`, shared with `/metric`) is
 * moved to `unavailable` rather than dropped. A number we would not sell alone
 * is not one we will hide inside a paragraph, where it would be harder to
 * notice.
 */
async function fetchPlanned(
  plan: Plan,
  validated: ReturnType<typeof validatePlan>,
  maxFacts: number,
): Promise<FetchedFacts> {
  const wanted = validated.fetch.slice(0, maxFacts);
  const overflow = validated.fetch.slice(maxFacts);

  const results = await Promise.all(
    wanted.map(async (pair) => ({
      pair,
      fact: await getFact({ protocol: pair.protocol, kpi: pair.kpi, params: DEFAULT_PARAMS }),
    })),
  );

  const facts: SuccessFact[] = [];
  const grounded: GroundedFact[] = [];
  const unavailable: UnavailableEntry[] = [
    ...validated.unavailable.map(unavailableEntry),
    // `max_facts` is the caller's own budget, so a pair dropped by it is not a
    // failure — but it is still an absence the answer must not present as data.
    ...overflow.map((pair) =>
      unavailableEntry({
        ...pair,
        reason: `Not fetched: the plan exceeded max_facts (${maxFacts}).`,
        declined: false,
      }),
    ),
  ];

  for (const { pair, fact } of results) {
    const problem = unsellable(fact);
    if (problem !== null || !isSuccessFact(fact)) {
      unavailable.push(
        unavailableEntry({
          ...pair,
          reason: problem?.message ?? 'No value could be computed.',
          declined: false,
        }),
      );
      continue;
    }
    const caps = getConnector(pair.protocol)?.capabilities();
    grounded.push(toGroundedFact(fact, grounded.length, caps?.name ?? pair.protocol, caps?.class ?? 'dex'));
    facts.push(fact);
  }

  return { facts, grounded, unavailable };
}

/** The worst cache state across the facts — the same rule `/compare` uses. */
function worstCache(facts: readonly SuccessFact[]): 'hit' | 'miss' | 'stale' {
  if (facts.some((f) => f.cache === 'stale')) return 'stale';
  if (facts.some((f) => f.cache === 'miss')) return 'miss';
  return 'hit';
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

export const ask = new Hono();

ask.post('/ask', async (c) => {
  if (!askConfigured()) {
    // A deployment without a key must not sell this route. 503 rather than
    // 500: it is a configuration state, it is not the caller's fault, and it
    // is not charged.
    throw new ApiError(503, ROUTER_NOT_CONFIGURED, 'POST /ask is not configured on this deployment.', {
      other_routes: 'Every other route is unaffected; see /catalog.',
    });
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'INVALID_BODY', 'The request body is not valid JSON.', {});
  }

  const params = parseAskRequest(body, c.req.query('depth'));
  const calls: CallUsage[] = [];

  // ---- the cache, before either model call ------------------------------
  // §6: many agents ask near-identical questions, and the whole point of the
  // entry is to skip BOTH calls. Checking it after routing would pay for the
  // router on every hit.
  const deps = cacheDeps();
  const cacheKey = askCacheKey({
    question: params.question,
    depth: params.depth,
    maxFacts: params.maxFacts,
    format: params.format,
    methodologyVersion: env.METHODOLOGY_VERSION,
  });
  const cached = await readAskCache(deps.l1, cacheKey);
  if (cached !== null) {
    logMargin({ ...params, calls: [], factCount: cached.facts.length, cache: 'hit', corrections: 0 });
    c.header(CACHE_HEADER, 'hit');
    c.header(METHODOLOGY_HEADER, env.METHODOLOGY_VERSION);
    return c.json(cached);
  }

  // ---- route (cheap; a decline stops here, unpaid) -----------------------
  const routed = await routeQuestion(params.question);
  calls.push(routed.usage);
  if (routed.kind === 'decline') {
    log.info(
      { reason: routed.reason, cost_usd: Number(totalCostUsd(calls).toFixed(6)) },
      'ask.declined',
    );
    throw declineToError(routed);
  }

  const validated = validatePlan(routed.plan);
  if (validated.unknownProtocols.length > 0) {
    // The tool schema's enum should have made this impossible. If it happens,
    // the plan is not one we can honour, and answering a narrower question than
    // the caller asked is worse than declining.
    throw new ApiError(
      422,
      'UNROUTABLE_QUESTION',
      `The plan named ${validated.unknownProtocols.join(', ')}, which we do not cover.`,
      { ...coverageSummary(), note_not_charged: 'Not charged.' },
    );
  }

  // ---- fetch through the ordinary cached path ---------------------------
  const fetched = await fetchPlanned(routed.plan, validated, params.maxFacts);

  if (fetched.facts.length < 1) {
    // §3.3: "Routed successfully but < 1 fact resolved. Not settled."
    throw new ApiError(
      502,
      'INSUFFICIENT_DATA',
      'The question routed, but no fact could be resolved for it. Not charged.',
      {
        plan: routed.plan,
        reasons: fetched.unavailable.map((u) => ({
          protocol: u.protocol,
          metric: u.metric,
          reason: u.reason,
        })),
      },
    );
  }

  const payload = buildGroundingPayload({
    question: params.question,
    plan: routed.plan,
    facts: fetched.grounded,
    unavailable: fetched.unavailable,
  });

  // ---- synthesize -------------------------------------------------------
  // `format: "facts"` asks for the data without the narrative, so there is no
  // narrative to buy: the synthesis call is skipped entirely. The caveats a
  // caller needs are generated from the facts either way (see below), so the
  // response is complete rather than merely cheaper.
  let answer = '';
  let citations: AskResponse['citations'] = [];
  let modelCaveats: string[] = [];
  let corrections = 0;

  if (params.format !== 'facts') {
    const result = await synthesize(payload, {
      // §3.3: `deep` buys "a longer synthesis budget". Same model, same prompt,
      // same grounding rules — two depths of one product, not two products.
      maxTokens: params.depth === 'deep' ? 8_192 : 4_096,
    });
    calls.push(...result.usage);
    corrections = Math.max(0, result.usage.length - 1);

    if (result.output === null) {
      // We fetched real data and could not turn it into prose we are willing
      // to stand behind. Returning the facts with a hollow paragraph would be
      // the worse outcome: the caller would have no way to know the narrative
      // failed its own checks.
      log.error(
        { violations: result.violations, cost_usd: Number(totalCostUsd(calls).toFixed(6)) },
        'ask.ungrounded',
      );
      throw new ApiError(
        502,
        'INSUFFICIENT_DATA',
        'The answer could not be grounded in the facts we fetched, so it was not returned. ' +
          'Not charged.',
        {
          violations: result.violations.map((v) => v.kind),
          facts_available: fetched.facts.length,
          retry:
            'The underlying facts are available individually at /metric and comparatively at ' +
            '/compare.',
        },
      );
    }

    answer = result.output.answer;
    citations = result.output.citations;
    modelCaveats = result.output.caveats;
  }

  // Ours first: the low-confidence, staleness, estimate and declined-KPI
  // entries are the ones an operator would want to have seen, and they must
  // not depend on a model having remembered to write them.
  const caveats = [...new Set([...generatedCaveats(payload), ...modelCaveats])];

  const response: AskResponse = AskResponseSchema.parse({
    question: params.question,
    answer: params.format === 'facts' ? '' : answer,
    // ALWAYS, including under `format: "prose"` (§3.3). The prose is a
    // convenience over the data, never a substitute for it.
    facts: fetched.facts as KpiFact[],
    plan: routed.plan,
    citations,
    // §5's composite rule: the MINIMUM across the facts, never the mean.
    confidence: combineConfidence(fetched.facts),
    caveats,
    methodology_version: env.METHODOLOGY_VERSION,
    model: { router: routed.usage.model, synthesizer: calls.at(-1)?.model ?? routed.usage.model },
    timestamp: new Date().toISOString(),
    depth: params.depth,
    format: params.format,
    cache: worstCache(fetched.facts),
  });

  // ---- cache, only when every fact was itself a hit (§6) -----------------
  const ttl = cacheableTtlSeconds(fetched.facts, Date.now());
  if (ttl !== null) await writeAskCache(deps.l1, cacheKey, response, ttl);

  logMargin({
    ...params,
    calls,
    factCount: fetched.facts.length,
    cache: response.cache,
    corrections,
  });

  c.header(CACHE_HEADER, response.cache);
  c.header(METHODOLOGY_HEADER, env.METHODOLOGY_VERSION);
  return c.json(response);
});
