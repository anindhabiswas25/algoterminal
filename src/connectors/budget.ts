import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A fetch budget the paid path cannot exceed — LAUNCH_LOG.md §4g item 2.
 *
 * ## Why this exists
 *
 * `?fresh=true` forces an upstream fetch, and an upstream fetch is unbounded
 * work: the shared HTTP client retries a `429 Throttled` with backoff, which is
 * the correct thing to do and is also what took one `?fresh=true` handler past
 * two minutes against a payment that lived ~31 s. Lowering Tinyman's per-host
 * concurrency (`http.ts`) makes the throttling rare. This makes the consequence
 * bounded: past the budget, the next upstream request is refused rather than
 * queued behind another backoff.
 *
 * ## Why it is ambient rather than a parameter
 *
 * The budget has to reach `ctx.http.getJson`, which is six or seven frames
 * below the route handler through `getFact` → `computeFacts` → a connector's
 * `fetchRaw` → `enumerate`. Threading a budget object through all of that would
 * put a payment concern into every connector's signature, and CONNECTOR_GUIDE
 * §4.1's whole point is that a connector does not think about transport policy.
 * `AsyncLocalStorage` keeps it where it belongs: the caller that knows about
 * the payment deadline opens the budget, and the one shared HTTP client — the
 * only place a connector is allowed to make a request from — enforces it.
 *
 * A budget applies only inside {@link withFetchBudget}. Code outside one, which
 * is the refresher and every free route, is unaffected.
 */

export interface FetchBudgetLimits {
  /**
   * Upstream requests permitted. Sized from the fetch this path actually needs
   * rather than a round number — see {@link FRESH_FETCH_MAX_REQUESTS}.
   */
  readonly maxRequests: number;
  /** Epoch-ms instant past which no further upstream request may start. */
  readonly deadlineAtMs: number;
}

interface FetchBudgetState extends FetchBudgetLimits {
  spent: number;
}

const storage = new AsyncLocalStorage<FetchBudgetState>();

/**
 * Thrown by the shared HTTP client when the ambient budget is exhausted.
 *
 * A distinct class because the read path treats it as an upstream failure —
 * `getFact` falls back to L2 and the `?fresh=true` contract then turns a stale
 * result into an uncharged 502 — and that behaviour should be reached by type
 * rather than by matching a message.
 */
export class FetchBudgetExceededError extends Error {
  constructor(
    readonly url: string,
    readonly reason: 'requests' | 'deadline',
    readonly spent: number,
    readonly limits: FetchBudgetLimits,
  ) {
    super(
      reason === 'requests'
        ? `fetch budget exhausted after ${spent} upstream requests (limit ${limits.maxRequests}): ${url}`
        : `fetch budget deadline passed after ${spent} upstream requests: ${url}`,
    );
    this.name = 'FetchBudgetExceededError';
  }
}

/**
 * Requests a cold `?fresh=true` fetch is allowed to make.
 *
 * Sized from the real fetch, not guessed: the fast TTL class against Tinyman is
 * the pool pages, the V2 validator account walk and ~48 chunked `/assets/`
 * reads (`connectors/tinyman/index.ts`), which lands in the low hundreds. 600
 * leaves headroom for a wider hot set without leaving room for a retry storm —
 * the failure this bounds spends requests in the thousands, not the hundreds.
 */
export const FRESH_FETCH_MAX_REQUESTS = 600;

/**
 * Milliseconds held back from the payment deadline for the fresh fetch budget.
 *
 * The point of stopping early is that the handler gets to RETURN something. A
 * fetch that is refused at the budget propagates as an upstream failure, the
 * read path falls back to L2, and `?fresh=true` turns that into a 502 naming
 * the reason — a better answer than the gate's bare 504, and equally uncharged.
 */
export const FRESH_FETCH_RESERVE_MS = 2_000;

/**
 * Run `fn` with a fetch budget in scope. Nested budgets are not merged: the
 * innermost wins, which is the one closest to the work being bounded.
 */
export function withFetchBudget<T>(limits: FetchBudgetLimits, fn: () => Promise<T>): Promise<T> {
  return storage.run({ ...limits, spent: 0 }, fn);
}

/**
 * Charge one upstream request against the ambient budget, if there is one.
 *
 * Called by the shared HTTP client before every attempt — including every
 * RETRY, which is the point: the retries are what overran the payment window,
 * so a retry has to cost the same as a first try.
 */
export function chargeFetchBudget(url: string, nowMs: number = Date.now()): void {
  const state = storage.getStore();
  if (state === undefined) return;
  if (nowMs >= state.deadlineAtMs) {
    throw new FetchBudgetExceededError(url, 'deadline', state.spent, state);
  }
  if (state.spent >= state.maxRequests) {
    throw new FetchBudgetExceededError(url, 'requests', state.spent, state);
  }
  state.spent += 1;
}

/** What the ambient budget has spent so far, for logging. Null outside one. */
export function fetchBudgetSpent(): number | null {
  return storage.getStore()?.spent ?? null;
}

/** Milliseconds left on the ambient budget, or null outside one. */
export function fetchBudgetRemainingMs(nowMs: number = Date.now()): number | null {
  const state = storage.getStore();
  return state === undefined ? null : Math.max(0, state.deadlineAtMs - nowMs);
}
