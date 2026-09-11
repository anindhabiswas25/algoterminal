import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '../logger.js';
import { KPI_IDS } from '../standardize/kpis.js';
import { listProtocolIds } from '../connectors/registry.js';
import { anthropic, readUsage, ROUTER_MODEL, type AskModelClient, type CallUsage } from './client.js';
import { capabilityMatrix, type CapabilityMatrix } from './capabilities.js';
import { COMPARISON_TYPES, PlanSchema, type Plan } from './schema.js';

/**
 * Claude call #1 — routing (ARCHITECTURE.md §4.7 step 1).
 *
 * A natural-language question becomes `{protocols[], kpis[], comparison_type}`
 * or a refusal, and nothing else. It is the cheapest call we make and the only
 * one that runs on a question we will not charge for, which is exactly the
 * shape API_SPEC.md §3.3 asks for: "the routing call is cheap and we eat it
 * rather than charging for a non-answer."
 *
 * ## Why forced tool use rather than free text or JSON mode
 *
 * The model is given two tools and `tool_choice: { type: "any" }`, so it must
 * call one of them. It cannot answer the question — it has no data to answer
 * it with — and it cannot return prose we would then have to parse.
 *
 * `plan_query`'s schema carries `enum`s built from the LIVE registry and
 * `strict: true`, which means the API validates the arguments against those
 * enums before we ever see them. That is what makes "it cannot invent a
 * protocol we do not cover" a property of the request rather than a hope about
 * the model. {@link validatePlan} re-checks it anyway; see `capabilities.ts`.
 *
 * `decline` exists as a *tool* rather than as an empty plan because the two
 * refusals are different products. `out_of_scope` is a 422 that tells the
 * caller we will never answer this (a forecast, a price target, advice, a
 * non-Algorand topic); `unroutable` is a 422 that tells it we do not cover
 * this yet, with the list of what we do cover. An agent should retry the
 * second with a different question and never retry the first.
 */

const log = logger.child({ component: 'ask.router' });

/** The router either produced a plan or declined. There is no third outcome. */
export type RouterResult =
  | { readonly kind: 'plan'; readonly plan: Plan; readonly usage: CallUsage }
  | {
      readonly kind: 'decline';
      readonly reason: 'out_of_scope' | 'unroutable';
      readonly explanation: string;
      readonly usage: CallUsage;
    };

export const PLAN_TOOL = 'plan_query';
export const DECLINE_TOOL = 'decline';

/**
 * The two tools, with their schemas built from the live matrix.
 *
 * `additionalProperties: false` and a complete `required` list are required by
 * `strict: true`, and they are what make the tool call's shape guaranteed
 * rather than typical.
 */
export function routerTools(matrix: CapabilityMatrix): Anthropic.Tool[] {
  const protocolIds = matrix.protocols.map((p) => p.id);
  const kpiIds = matrix.kpis.map((k) => k.id);

  return [
    {
      name: PLAN_TOOL,
      description:
        'Map the question onto the protocols and KPIs AlgoTerminal actually publishes. Choose the ' +
        'smallest set that answers it: every protocol x KPI pair is a separate data fetch. Include ' +
        'a protocol even when you believe it declines the requested KPI — the answer must say so ' +
        'rather than silently omit it.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          protocols: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: protocolIds },
            description: 'Protocol ids to fetch. Only these exist.',
          },
          kpis: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: kpiIds },
            description: 'KPI ids to fetch. Only these exist.',
          },
          comparison_type: {
            type: 'string',
            enum: [...COMPARISON_TYPES],
            description:
              'single_metric_lookup: one number. multi_metric_profile: several KPIs about one ' +
              'protocol. cross_protocol_ranking: one KPI across protocols of the same class. ' +
              'cross_class_comparison: one KPI across protocols of DIFFERENT classes (a DEX ' +
              'against a lending market) — the case that needs the comparability caveat.',
          },
        },
        required: ['protocols', 'kpis', 'comparison_type'],
        additionalProperties: false,
      },
    },
    {
      name: DECLINE_TOOL,
      description:
        'Refuse the question. Use this and never plan_query when the question asks for something ' +
        'we do not sell.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['out_of_scope', 'unroutable'],
            description:
              'out_of_scope: the question asks for a forecast, a prediction, a price target, ' +
              'trading or investment advice, a recommendation to buy/sell/enter/exit, or a topic ' +
              'that is not Algorand DeFi protocol accounting. unroutable: the question is about ' +
              'Algorand DeFi but cannot be mapped onto the protocols and KPIs listed above.',
          },
          explanation: {
            type: 'string',
            description: 'One sentence, addressed to the caller, saying what we cannot answer and why.',
          },
        },
        required: ['reason', 'explanation'],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * The router system prompt.
 *
 * The matrix is rendered into it as JSON rather than described in prose,
 * because it is data the model must match exactly and prose invites
 * paraphrase. The scope rules are stated as a closed list of refusal triggers:
 * "descriptive only" is a principle, and a principle is not a decision
 * procedure.
 */
export function routerSystemPrompt(matrix: CapabilityMatrix): string {
  return `You route questions for AlgoTerminal, a paid API that publishes standardized, historical-to-present financial KPIs for Algorand DeFi protocols. You do not answer questions. You produce a data-fetch plan, or you decline.

You have exactly two tools and you MUST call one of them.

# What AlgoTerminal covers

${JSON.stringify(matrix, null, 2)}

# Rules

1. Call \`plan_query\` only with ids from the lists above. There are no others.
2. Pick the SMALLEST set of protocols and KPIs that answers the question. Each pair is a separate paid data fetch. Do not add KPIs "for context".
3. A question that names a ratio should plan that ratio, not its parts — "fee revenue per dollar of TVL" is \`capital_efficiency\`, not \`gross_fees_24h\` plus \`tvl\`. Add the parts only when the question asks why.
4. If the question compares protocols without naming them ("which protocol..."), plan ALL protocols that the KPI applies to.
5. If a protocol \`declines\` the requested KPI, still include that protocol. The answer must state that the protocol does not publish it. Omitting it would read as though the protocol has no such value, which is false and is the exact failure our methodology forbids.
6. \`comparison_type\` must be \`cross_class_comparison\` whenever the planned protocols span more than one \`class\`.

# When to decline

Call \`decline\` with \`out_of_scope\` if the question asks for ANY of:
- a forecast or prediction about the future ("will X go up", "what will Y be next week", "is now a good time")
- a price target, a valuation, or anything about a token's price or market cap
- trading, investment or allocation advice, or a recommendation to buy, sell, enter or exit
- a judgement about which protocol is "best", "safest" or "worth using" — we publish numbers and state what they mean; we do not rank protocols by desirability
- anything that is not Algorand DeFi protocol accounting

Call \`decline\` with \`unroutable\` if the question is about Algorand DeFi but names a protocol or a quantity that is not in the lists above.

Declining is free for the caller and costs us almost nothing. Answering a forecast would be worse than useless: it would be a confident number with no data behind it, sold under a methodology that says every number is reproducible. When in doubt between \`out_of_scope\` and a plan, decline.`;
}

export interface RouteOptions {
  /** Injected in tests so the router can be driven without the network. */
  readonly client?: AskModelClient;
  readonly matrix?: CapabilityMatrix;
}

/**
 * Route one question.
 *
 * Never throws for a model-shaped failure. A response with no tool call, or a
 * tool call whose arguments do not parse, is returned as `unroutable` — the
 * caller is not charged either way, and a 500 here would be indistinguishable
 * to an agent from us being broken.
 */
export async function routeQuestion(
  question: string,
  opts: RouteOptions = {},
): Promise<RouterResult> {
  const matrix = opts.matrix ?? capabilityMatrix();
  const client = opts.client ?? anthropic();

  const response = await client.messages.create({
    model: ROUTER_MODEL,
    // A plan is a few dozen tokens. This is a ceiling against a pathological
    // response, not a budget: the router is not asked to reason at length.
    max_tokens: 1_024,
    system: routerSystemPrompt(matrix),
    tools: routerTools(matrix),
    // It must call a tool. It has no data to answer with, and free text here
    // would be a paragraph we then have to parse — the failure mode this
    // design exists to remove.
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: question }],
  });

  const usage = readUsage(ROUTER_MODEL, response.usage);
  const call = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (call === undefined) {
    log.warn({ stop_reason: response.stop_reason }, 'router returned no tool call');
    return {
      kind: 'decline',
      reason: 'unroutable',
      explanation: 'The question could not be mapped onto the protocols and KPIs we publish.',
      usage,
    };
  }

  if (call.name === DECLINE_TOOL) {
    const input = call.input as { reason?: string; explanation?: string };
    return {
      kind: 'decline',
      // An unrecognised reason is treated as `unroutable`, the softer of the
      // two: it tells the caller to try a different question rather than
      // asserting we will never answer this one.
      reason: input.reason === 'out_of_scope' ? 'out_of_scope' : 'unroutable',
      explanation:
        typeof input.explanation === 'string' && input.explanation.length > 0
          ? input.explanation
          : 'The question is outside what AlgoTerminal publishes.',
      usage,
    };
  }

  const parsed = PlanSchema.safeParse(call.input);
  if (!parsed.success) {
    // `strict: true` plus the enums should make this unreachable. It is here
    // because "should be unreachable" is not a guarantee when the enforcement
    // happens in another company's service.
    log.warn({ issues: parsed.error.issues, input: call.input }, 'router produced an invalid plan');
    return {
      kind: 'decline',
      reason: 'unroutable',
      explanation: 'The question could not be mapped onto a valid plan.',
      usage,
    };
  }

  // Deduplicated and ordered by the registries rather than by the model, so
  // the same question produces the same plan, the same cache keys and the same
  // fetch order regardless of what order the model happened to list things in.
  const plan: Plan = {
    protocols: listProtocolIds().filter((id) => parsed.data.protocols.includes(id)),
    kpis: KPI_IDS.filter((id) => parsed.data.kpis.includes(id)),
    comparison_type: parsed.data.comparison_type,
  };

  if (plan.protocols.length === 0 || plan.kpis.length === 0) {
    return {
      kind: 'decline',
      reason: 'unroutable',
      explanation: 'The question named no protocol or no KPI that we publish.',
      usage,
    };
  }

  return { kind: 'plan', plan, usage };
}
