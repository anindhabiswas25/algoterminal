import type Anthropic from '@anthropic-ai/sdk';

import type { AskModelClient } from '../../src/ask/client.js';
import { DECLINE_TOOL, PLAN_TOOL } from '../../src/ask/router.js';
import type { Plan, SynthesisOutput } from '../../src/ask/schema.js';

/**
 * A scripted Anthropic client.
 *
 * Not a mock in the "assert it was called" sense: it is a working double that
 * returns exactly what a real response carries — `content` blocks with a
 * `tool_use`, or a `parsed_output` — so the code under test runs its real
 * parsing, its real validation and its real retry loop. Nothing is stubbed
 * except the network.
 *
 * The router and synthesizer scripts are separate queues because the two calls
 * are separate decisions: a test that wants "routes fine, then fabricates a
 * number" should not have to interleave them by hand.
 */
export interface FakeAnthropic extends AskModelClient {
  /** Every router call's user message, in order. */
  readonly routerPrompts: string[];
  /** Every synthesis call's `messages`, in order — the retry loop is visible here. */
  readonly synthesisCalls: Anthropic.MessageParam[][];
  /** Queue one router outcome. */
  plan(plan: Plan): void;
  decline(reason: 'out_of_scope' | 'unroutable', explanation?: string): void;
  /** Queue one synthesis outcome. `null` returns an unparseable response. */
  synthesis(output: SynthesisOutput | null): void;
}

const USAGE = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0 };

function toolUseResponse(name: string, input: unknown): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_test', name, input }],
    usage: USAGE,
  };
}

export function fakeAnthropic(): FakeAnthropic {
  const routerQueue: unknown[] = [];
  const synthesisQueue: Array<SynthesisOutput | null> = [];
  const routerPrompts: string[] = [];
  const synthesisCalls: Anthropic.MessageParam[][] = [];

  const self: FakeAnthropic = {
    routerPrompts,
    synthesisCalls,
    plan(plan) {
      routerQueue.push(toolUseResponse(PLAN_TOOL, plan));
    },
    decline(reason, explanation = 'declined by the test') {
      routerQueue.push(toolUseResponse(DECLINE_TOOL, { reason, explanation }));
    },
    synthesis(output) {
      synthesisQueue.push(output);
    },
    messages: {
      // The router.
      create: (async (params: Anthropic.MessageCreateParams) => {
        const last = params.messages.at(-1);
        routerPrompts.push(typeof last?.content === 'string' ? last.content : '');
        const next = routerQueue.shift();
        if (next === undefined) throw new Error('fakeAnthropic: no router response queued');
        return next;
      }) as AskModelClient['messages']['create'],

      // The synthesizer.
      parse: (async (params: Anthropic.MessageCreateParams) => {
        synthesisCalls.push([...params.messages]);
        const next = synthesisQueue.shift();
        if (next === undefined) throw new Error('fakeAnthropic: no synthesis response queued');
        return {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(next ?? {}) }],
          parsed_output: next,
          usage: { ...USAGE, output_tokens: 480 },
        };
      }) as AskModelClient['messages']['parse'],
    },
  };

  return self;
}

/** A synthesis output with no citations or caveats, for tests about the prose. */
export function prose(answer: string, overrides: Partial<SynthesisOutput> = {}): SynthesisOutput {
  return { answer, citations: [], caveats: [], ...overrides };
}
