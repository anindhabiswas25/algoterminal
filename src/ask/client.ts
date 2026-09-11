import Anthropic from '@anthropic-ai/sdk';

import { env } from '../config/env.js';

/**
 * The Anthropic client, the two models `/ask` uses, and what a call costs.
 *
 * ARCHITECTURE.md §4.7 splits `/ask` into two model calls on purpose, and the
 * split is a cost decision as much as a correctness one:
 *
 *  1. **Route** with Haiku 4.5 — cheap, fast, constrained by a tool-use schema
 *     built from the live registry. It cannot name a protocol we do not cover.
 *     It is also the cost guard: an unroutable or out-of-scope question stops
 *     here, before the expensive call, and is not charged (API_SPEC.md §3.3).
 *  2. **Synthesize** with Sonnet 5 — reads the fetched `KpiFact`s and writes
 *     prose strictly from them.
 *
 * Using one large model for both would pay synthesis prices to answer "is this
 * question about Algorand DeFi at all", which is the question we most want to
 * answer cheaply because it is the one we do not charge for.
 */

/** §4.7 — the router. */
export const ROUTER_MODEL = 'claude-haiku-4-5';
/** §4.7 — the synthesizer. */
export const SYNTHESIZER_MODEL = 'claude-sonnet-5';

/**
 * Published per-million-token prices, as of 2026-09-09.
 *
 * Here so the margin in `PRD.md` §5.3 is a *measured* number rather than an
 * assumed one: every `/ask` response is logged with the token counts and the
 * dollar cost these produce, so "~80% gross margin" is something `/health` and
 * the logs can be audited against rather than something a planning document
 * asserts. A price change upstream is a one-line edit here and the logged
 * margin moves with it.
 */
export const MODEL_PRICING = {
  [ROUTER_MODEL]: { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  [SYNTHESIZER_MODEL]: { inputPerMTok: 2.0, outputPerMTok: 10.0 },
} as const satisfies Record<string, { inputPerMTok: number; outputPerMTok: number }>;

/** What one model call consumed. The subset of `usage` we bill against. */
export interface CallUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cached-prefix reads, billed at roughly a tenth of the input rate. */
  readonly cacheReadTokens: number;
}

/**
 * USD cost of one call.
 *
 * Cache reads are priced at 0.1x input, per the published caching rates. An
 * unknown model costs `0` rather than throwing: this number exists for margin
 * telemetry, and a pricing table that has not caught up with a model swap must
 * not be able to fail a paid request that has already been answered.
 */
export function callCostUsd(usage: CallUsage): number {
  const pricing = (MODEL_PRICING as Record<string, { inputPerMTok: number; outputPerMTok: number }>)[
    usage.model
  ];
  if (pricing === undefined) return 0;
  const perToken = (perMTok: number) => perMTok / 1_000_000;
  return (
    usage.inputTokens * perToken(pricing.inputPerMTok) +
    usage.cacheReadTokens * perToken(pricing.inputPerMTok) * 0.1 +
    usage.outputTokens * perToken(pricing.outputPerMTok)
  );
}

/** Total cost of every call made while answering one question. */
export function totalCostUsd(calls: readonly CallUsage[]): number {
  return calls.reduce((sum, call) => sum + callCostUsd(call), 0);
}

/**
 * Read the usage off a response, defensively.
 *
 * `usage` is always present on a successful Messages response; the `?? 0`s are
 * for the fields that are only populated when the corresponding feature is in
 * play (`cache_read_input_tokens` is absent when nothing was cached). Missing
 * telemetry must never turn a delivered answer into a 500.
 */
export function readUsage(model: string, usage: Anthropic.Usage | undefined): CallUsage {
  return {
    model,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

/**
 * The surface of the SDK `/ask` uses: `messages.create` for the router's
 * tool call and `messages.parse` for the synthesizer's structured output.
 *
 * Narrowed to those two so a test double is a small object rather than a
 * reimplementation of the client — and so widening what `/ask` depends on is a
 * deliberate edit here rather than something that happens by autocomplete.
 */
export interface AskModelClient {
  readonly messages: Pick<Anthropic['messages'], 'create' | 'parse'>;
}

let shared: Anthropic | null = null;
let override: AskModelClient | null = null;

/**
 * The process-wide client.
 *
 * Lazy, and it throws rather than defaulting when the key is missing. A
 * service that boots without `ANTHROPIC_API_KEY` must still serve `/metric`,
 * `/compare` and every free route — `/ask` is one route, not the product — so
 * the key is not a boot requirement in `src/config/env.ts`. It IS a
 * requirement for this route, and the failure has to be loud at the point of
 * use rather than a confusing 500 from inside the SDK.
 */
export function anthropic(): AskModelClient {
  if (override !== null) return override;
  if (env.ANTHROPIC_API_KEY === undefined) {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured; POST /ask cannot run (DEPLOYMENT.md §3). ' +
        'Every other route is unaffected.',
    );
  }
  return (shared ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
}

/**
 * Swap the client for the process. Returns a restore function.
 *
 * The same pattern as `setCacheDeps`, and for the same reason: the route
 * reaches the models through a module singleton, so a handler cannot be handed
 * a client by its caller. A test swaps a scripted double in here and exercises
 * the REAL route, router, grounding checks and cache — not a stand-in for
 * them. The alternative, mocking the module, would test that we call a
 * function rather than that a fabricated number is rejected.
 */
export function setAskClient(next: AskModelClient | null): () => void {
  const previous = override;
  override = next;
  return () => {
    override = previous;
  };
}

/** Is `/ask` configured on this deployment? Read by the route and by `/health`. */
export function askConfigured(): boolean {
  return override !== null || env.ANTHROPIC_API_KEY !== undefined;
}
