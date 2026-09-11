import { createHash } from 'node:crypto';

import { logger } from '../logger.js';
import type { L1Store } from '../cache/types.js';
import { ttlSecondsFor } from '../standardize/kpis.js';
import type { SuccessFact } from '../standardize/schema.js';
import { AskResponseSchema, type AskResponse } from './schema.js';

/**
 * The `/ask` result cache — ARCHITECTURE.md §6.
 *
 * > `/ask` results: **300 s on a normalized question hash**. Many agents ask
 * > near-identical questions. Only cached when every underlying fact was itself
 * > a cache hit, so we never serve a synthesized narrative built on data older
 * > than the narrative claims.
 *
 * Both halves of that sentence are implemented here, and the second one needed
 * a stricter reading than "every fact was a hit".
 *
 * ## Why a flat 300 s would violate the rule it is written to enforce
 *
 * A fact is a cache "hit" anywhere inside its own TTL — including one second
 * before it expires. `supply_apr` has a 120 s TTL (§6: rate-model outputs that
 * step on every borrow/repay, and "staleness here has a real cost"). An answer
 * synthesized from a 119-second-old `supply_apr` and then held for 300 s would
 * be served, as a `hit`, describing a rate that expired six minutes earlier —
 * which is exactly the narrative-older-than-it-claims case the rule forbids.
 *
 * So the entry's TTL is the SHORTER of 300 s and the time until the
 * first underlying fact expires. An answer therefore never outlives the
 * freshest claim it makes, and one built from a fact that is already at the end
 * of its TTL is simply not cached ({@link cacheableTtlSeconds} returns null).
 */

const log = logger.child({ component: 'ask.cache' });

/** §6's ceiling. The floor is whatever the shortest-lived fact allows. */
export const ASK_CACHE_TTL_SECONDS = 300;

/**
 * The normalized form two "near-identical questions" share.
 *
 * Case, surrounding whitespace, internal whitespace runs, and trailing
 * punctuation are all noise: "Which protocol has the highest take rate?" and
 * "which protocol has the highest take rate" are one question and should be one
 * cache entry. Nothing else is normalized — no stemming, no stop-word removal,
 * no synonym folding. Those would collapse questions that are genuinely
 * different ("highest take rate" vs "lowest take rate" differ by one word), and
 * a cache that answers a question the caller did not ask is worse than a cache
 * that misses.
 */
export function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.\s]+$/, '');
}

export interface AskCacheIdentity {
  readonly question: string;
  readonly depth: string;
  readonly maxFacts: number;
  readonly format: string;
  readonly methodologyVersion: string;
}

/**
 * The key.
 *
 * `depth`, `max_facts` and `format` are in it because each changes the answer:
 * a `deep` sweep is a different plan, `max_facts` truncates it, and `facts`
 * format has no prose at all. Serving a standard answer to a caller that paid
 * $0.20 for a deep one would be charging the higher price for the cheaper work.
 *
 * `methodologyVersion` is in it for the same reason it is in the fact keys
 * (`src/cache/keys.ts`): a bump means the numbers inside the narrative now mean
 * something different, and the old entries must become unreachable rather than
 * merely stale.
 */
export function askCacheKey(id: AskCacheIdentity): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([normalizeQuestion(id.question), id.depth, id.maxFacts, id.format]),
    )
    .digest('hex')
    .slice(0, 32);
  return `ask:v${id.methodologyVersion}:${digest}`;
}

/**
 * How long this answer may be cached, or null if it may not be.
 *
 * Null when any underlying fact was not a cache hit (§6's own condition), when
 * there are no facts, or when the shortest-lived fact has less than a second of
 * TTL left — at which point the entry would expire before it could serve
 * anyone, and writing it is pure Redis traffic.
 */
export function cacheableTtlSeconds(facts: readonly SuccessFact[], nowMs: number): number | null {
  if (facts.length === 0) return null;
  if (!facts.every((fact) => fact.cache === 'hit')) return null;

  let ttl = ASK_CACHE_TTL_SECONDS;
  for (const fact of facts) {
    // `timestamp` is when WE computed the number (DATA_SCHEMA.md §2), and a
    // cache hit returns the stored fact with its original timestamp intact
    // (`stampFresh` in src/cache/index.ts) — so this is genuinely the age of
    // the number, not the age of this request.
    const computedAtMs = Date.parse(fact.timestamp);
    if (!Number.isFinite(computedAtMs)) return null;
    const remaining = Math.floor(
      (computedAtMs + ttlSecondsFor(fact.metric) * 1_000 - nowMs) / 1_000,
    );
    ttl = Math.min(ttl, remaining);
  }

  return ttl >= 1 ? ttl : null;
}

/**
 * Read a cached answer.
 *
 * Re-validated against `AskResponseSchema` on the way out. An entry written by
 * a previous deploy whose shape has since changed is treated as a miss rather
 * than served: a malformed paid response is worse than a second synthesis.
 */
export async function readAskCache(l1: L1Store, key: string): Promise<AskResponse | null> {
  const raw = await l1.getRaw(key);
  if (raw === null) return null;
  try {
    const parsed = AskResponseSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log.warn({ key, issues: parsed.error.issues }, 'cached /ask entry no longer valid; ignoring');
  } catch (err) {
    log.warn({ err, key }, 'cached /ask entry did not parse; ignoring');
  }
  return null;
}

export async function writeAskCache(
  l1: L1Store,
  key: string,
  response: AskResponse,
  ttlSeconds: number,
): Promise<void> {
  await l1.setRaw(key, JSON.stringify(response), ttlSeconds);
}
