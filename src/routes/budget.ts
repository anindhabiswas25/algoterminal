import type { Context } from 'hono';

import {
  FRESH_FETCH_MAX_REQUESTS,
  FRESH_FETCH_RESERVE_MS,
  withFetchBudget,
  type FetchBudgetLimits,
} from '../connectors/budget.js';
import { paidDeadlineAt, QUOTED_TIMEOUT_SECONDS } from '../gate/deadline.js';

/**
 * The `?fresh=true` fetch budget, tied to the payment that bought the request
 * — LAUNCH_LOG.md §4g items 1 and 2, joined up.
 *
 * The gate now abandons a paid handler at the instant the caller's payment
 * stops being settleable (`gate/deadline.ts`). That makes a runaway fetch
 * harmless, but it makes it harmless by returning a bare 504. This is the
 * better half of the same bound: the fetch is stopped a couple of seconds
 * EARLIER than the gate would stop the handler, so the handler is still alive
 * to notice, fall back to L2, and return the 502 that `?fresh=true`'s
 * no-stale-or-no-charge contract calls for — with a reason in it. Both
 * outcomes are free to the caller; only one of them explains itself.
 */
export function freshFetchLimits(c: Context, nowMs: number = Date.now()): FetchBudgetLimits {
  // No gate deadline means this is not a paid request in the first place — a
  // test, or a future free caller. The quoted ceiling is then the only bound
  // that makes sense, and it is the same one the gate would have applied.
  const deadlineAtMs = paidDeadlineAt(c) ?? nowMs + QUOTED_TIMEOUT_SECONDS * 1_000;
  return {
    maxRequests: FRESH_FETCH_MAX_REQUESTS,
    deadlineAtMs: Math.max(nowMs, deadlineAtMs - FRESH_FETCH_RESERVE_MS),
  };
}

/**
 * Run `fn` under the fresh fetch budget when `fresh` is set, and unchanged
 * otherwise.
 *
 * Deliberately not applied to the cached path: a cache read makes no upstream
 * requests, and wrapping it would put a budget in scope for the background
 * revalidation `getFact` fires behind a stale serve — bounding work that is
 * nobody's request and that no caller is waiting on.
 */
export function underFreshBudget<T>(c: Context, fresh: boolean, fn: () => Promise<T>): Promise<T> {
  return fresh ? withFetchBudget(freshFetchLimits(c), fn) : fn();
}
