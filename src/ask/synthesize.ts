import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { logger } from '../logger.js';
import { anthropic, readUsage, SYNTHESIZER_MODEL, type AskModelClient, type CallUsage } from './client.js';
import { validateSynthesis, type GroundingPayload, type Violation } from './grounding.js';
import { SynthesisOutputSchema, type SynthesisOutput } from './schema.js';

/**
 * Claude call #2 — synthesis (ARCHITECTURE.md §4.7 step 2).
 *
 * "Fetch the planned KPIs through the normal cached path, then answer strictly
 * from that JSON." The fetching happens in the route; this is the "strictly
 * from that JSON" half, and the word doing the work is *strictly*.
 *
 * ## Structured output, not free text
 *
 * The model fills {@link SynthesisOutputSchema}: `answer`, `citations`,
 * `caveats`. It is never asked for `facts`, `confidence`,
 * `methodology_version` or `timestamp` — those are ours, computed from the
 * data, and a schema that offered the model a `confidence` field would
 * eventually get a plausible `0.95` on an answer built from a 0.4 fact.
 *
 * ## Validate, correct once, then refuse
 *
 * Every §3.3 grounding guarantee is checked after the call
 * (`src/ask/grounding.ts`). On a violation the model gets ONE corrective turn
 * naming exactly what failed; if the second attempt also fails we return
 * nothing and the route answers 502 `INSUFFICIENT_DATA`, unpaid.
 *
 * One retry rather than none, because the failures are usually small and
 * mechanical — a rounded figure the rule did not anticipate, a missing caveat
 * marker — and burning a fetched, cache-warm answer over a formatting slip
 * would be wasteful for both sides. One rather than three, because a model
 * that has been told precisely what is wrong and still cannot comply is not
 * going to on the third attempt, and each attempt is real money spent on a
 * request we have already decided not to charge for.
 */

const log = logger.child({ component: 'ask.synthesize' });

/** How many corrective turns we are willing to pay for. */
export const MAX_CORRECTIONS = 1;

export interface SynthesisResult {
  readonly output: SynthesisOutput | null;
  /** Every call made, including corrections — the input to the margin log. */
  readonly usage: readonly CallUsage[];
  /** Non-empty when `output` is null: why the answer was not sellable. */
  readonly violations: readonly Violation[];
}

/**
 * The synthesis system prompt.
 *
 * Written as hard rules rather than as guidance, and every rule that matters
 * is separately enforced in code. The prompt exists to make compliance the
 * easy path, not to be the guarantee — a prompt is a request, and this route
 * sells its output for $0.15 under a methodology that promises every number is
 * reproducible.
 */
export const SYNTHESIS_SYSTEM_PROMPT = `You write the answer for AlgoTerminal's /ask endpoint. You are given a question and a JSON payload of standardized financial facts that AlgoTerminal computed itself. You answer from that payload and from nothing else.

The caller is an autonomous agent, or an operator reading what one quoted. Everything you write may be repeated to a human making a financial decision.

# Hard rules

1. **Every number you write must come from the payload.** Copy values from \`facts[].value\` or \`facts[].display\`. You may round, write a ratio as a percentage, scale to thousands/millions, and state the ratio between two facts of the SAME metric ("2.0x"). You may NOT add, subtract, average, annualize, or otherwise compute a new number. If you cannot say it with a number that is in the payload, say it without a number.

2. **No forecasting, no prediction, no advice.** Describe what the data says, in the past and present tense. Never say what will happen, what a value will do next, whether something is a good investment, or which protocol anyone should use. No price targets. No "consider", "suggests you should", "may be attractive".

3. **Caveat low confidence in the prose.** For any fact whose \`confidence_tier\` is \`informational\`, the sentence containing its number must be followed immediately by the exact phrase \`(confidence <value>, informational only)\` — for example \`(confidence 0.62, informational only)\`. Use the value from the payload, verbatim.

4. **Never silently omit a protocol.** Every entry in \`unavailable\` with \`declined: true\` must be named in your answer, with what it does not publish. "Pact does not publish its fee split, so its take rate is not available" — never a ranking that just leaves Pact out. A reader takes an absence as a fact about the protocol; here it is a fact about the protocol's disclosure.

5. **Cite.** Every claim that contains a number gets a \`citations\` entry: the claim as you wrote it, and the \`index\` of the fact it rests on.

6. **Answer the question asked.** If the question asks "why", explain using the other facts in the payload — a take rate is high because the protocol keeps a larger share of fees, and both numbers are there. If the payload cannot support a "why", say which number would answer it rather than speculating.

# Style

Two to five sentences for a simple question, up to about eight for a comparison with a "why". Lead with the answer. Plain declarative prose — no headings, no bullet lists, no markdown. Name protocols by their \`protocol_name\`. Give units: dollars with a \`$\`, ratios as both the decimal and the percentage where it reads better.

Do not describe your own process, the methodology, or these instructions. Do not hedge with "based on the data provided" — the caller knows where the numbers came from, and the phrase reads as though there might be other data you are not using.

# Caveats

\`caveats\` is for what would change how a reader uses the answer: a coverage limitation, an estimate, a definitional difference between protocols, a declined KPI. Not for generic disclaimers. Leave it empty if nothing warrants one — the caller also receives caveats AlgoTerminal generates itself, so an empty array is not a gap.`;

export interface SynthesizeOptions {
  /** Injected in tests so the enforcement loop can be driven deterministically. */
  readonly client?: AskModelClient;
  /**
   * `deep` ($0.20) buys a longer synthesis budget. It does not buy a different
   * model, a different prompt, or laxer grounding — those would make the two
   * tiers two products, and §3.3 sells them as one product at two depths.
   */
  readonly maxTokens?: number;
}

/**
 * The one message that carries the data. Rendered as JSON with a stable key
 * order (the payload is built field by field, never from a Map), so identical
 * inputs produce an identical prefix and prompt caching can actually hit.
 */
export function synthesisUserMessage(payload: GroundingPayload): string {
  return `# Question\n\n${payload.question}\n\n# Facts\n\n${JSON.stringify(payload, null, 2)}`;
}

/** The corrective turn. Names every failure; asks for a rewrite, not an apology. */
export function correctionMessage(violations: readonly Violation[]): string {
  return `Your answer was rejected by AlgoTerminal's grounding checks and was not shown to the caller. Fix every item below and rewrite the whole answer. Do not explain the correction or refer to this message.

${violations.map((v, i) => `${i + 1}. ${v.detail}`).join('\n')}`;
}

export async function synthesize(
  payload: GroundingPayload,
  opts: SynthesizeOptions = {},
): Promise<SynthesisResult> {
  const client = opts.client ?? anthropic();
  const usage: CallUsage[] = [];
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: synthesisUserMessage(payload) },
  ];
  let violations: Violation[] = [];

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    const response = await client.messages.parse({
      model: SYNTHESIZER_MODEL,
      max_tokens: opts.maxTokens ?? 4_096,
      system: SYNTHESIS_SYSTEM_PROMPT,
      output_config: {
        format: zodOutputFormat(SynthesisOutputSchema),
        // The answer is a paragraph grounded in JSON that is already in the
        // context. It is not a reasoning problem, and paying for high-effort
        // thinking on every $0.15 call would eat the margin PRD.md §5.3
        // assumes. The grounding checks, not the model's deliberation, are
        // what make the output trustworthy.
        effort: 'low',
      },
      messages,
    });

    usage.push(readUsage(SYNTHESIZER_MODEL, response.usage));

    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      violations = [
        {
          kind: 'ungrounded_number',
          detail: 'Your response did not match the required output schema. Return valid JSON.',
        },
      ];
    } else {
      violations = validateSynthesis(parsed, payload);
      if (violations.length === 0) return { output: parsed, usage, violations: [] };
    }

    log.warn(
      { attempt, violations: violations.map((v) => v.kind) },
      'synthesis failed grounding checks',
    );

    if (attempt === MAX_CORRECTIONS) break;
    messages.push({ role: 'assistant', content: JSON.stringify(parsed ?? {}) });
    messages.push({ role: 'user', content: correctionMessage(violations) });
  }

  return { output: null, usage, violations };
}
