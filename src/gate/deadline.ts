import type { Context } from 'hono';

import { logger } from '../logger.js';
import type { DecodedPayment } from './payload.js';

/**
 * The handler deadline — LAUNCH_LOG.md §4g item 1.
 *
 * ## The bug this closes
 *
 * Settle-after-success means the handler runs BEFORE we take the money. There
 * was no deadline on the handler at all, so a slow request could outlive the
 * payment it was paid with: `/metric/tinyman/tvl?fresh=true` forced an upstream
 * fetch while Tinyman's analytics API was throttling us, the retries took the
 * handler past two minutes, and the settle attempt arrived at round 67140101
 * against a payment that had died at 67140062. We returned 200, delivered the
 * data, and collected nothing.
 *
 * ## The window is the CLIENT's, not ours
 *
 * We advertise `maxTimeoutSeconds`. That is a number we choose, and it is not
 * the number that governs. What governs is `lastValid` on the caller's own
 * signed payment transaction, which the client fixed before it ever reached us:
 * `@x402/avm` builds the group through algokit's composer, whose
 * `defaultValidityWindow` is 10 rounds, so `lastValid = firstValid + 10` and
 * the payment is dead ~31 s after it was built.
 *
 * So the budget is derived from the payment, not from a constant:
 *
 *   budget = (lastValid − currentRound − {@link SETTLE_HEADROOM_ROUNDS})
 *            × {@link SECONDS_PER_ROUND}
 *
 * capped at {@link QUOTED_TIMEOUT_SECONDS}, which is the longest we are willing
 * to hold any request open regardless of how generous a window a client builds.
 *
 * ## On expiry we return 504, and 504 does not settle
 *
 * Failing free is strictly better than serving free. A 504 costs the caller
 * nothing and tells it to retry; a 200 we cannot bill for is a product we are
 * giving away without having decided to, and — since no transaction exists for
 * it — a leaderboard discrepancy as well.
 */

const log = logger.child({ component: 'gate.deadline' });

/**
 * Seconds per Algorand round, deliberately a shade UNDER the measurement.
 *
 * Measured 2026-09-09 against both Nodely endpoints: 22 rounds in 60.5 s on
 * TestNet (2.749 s/round) and 22 in 60.7 s on MainNet (2.757 s/round). 2.7 is
 * used because every error introduced by rounding down points the safe way —
 * it shortens the budget we give the handler and lengthens the round we
 * extrapolate the chain to, and both of those fail toward a free 504 rather
 * than toward a free 200.
 */
export const SECONDS_PER_ROUND = 2.7;

/**
 * Rounds reserved for the settle round-trip itself.
 *
 * The handler finishing is not the end of the work: the facilitator still has
 * to receive `/settle`, sign the fee-payer transaction and get the group
 * accepted into a round at or before `lastValid`. Three rounds is ~8.1 s, which
 * covers the observed settle latency with room for one missed round.
 */
export const SETTLE_HEADROOM_ROUNDS = 3;

/**
 * §2.1 `maxTimeoutSeconds`, and simultaneously our own hard ceiling on how long
 * a paid handler may run.
 *
 * It was 60. Sixty was never the number that governed: a client's default
 * validity window is ~31 s, so a handler finishing comfortably inside our own
 * quoted timeout could still find the payment dead — we were publishing a
 * number twice as long as the one that decided whether we got paid.
 *
 * Thirty is what we actually promise now. It is below the ~31 s window clients
 * really build, so a request that finishes inside the number we advertise
 * finishes inside the window that governs, which is the only property that
 * makes advertising it worth anything. `/llms.txt` additionally explains what a
 * caller's own validity window means for the slow routes, because the two facts
 * answer different questions: this constant is our promise, and the note is the
 * caller's half of the contract, which we cannot promise on its behalf.
 */
export const QUOTED_TIMEOUT_SECONDS = 30;

/** How long the round clock may extrapolate before it must re-read algod. */
export const ROUND_CLOCK_REFRESH_MS = 2_000;
/** Past this age an extrapolated round is not trustworthy and is discarded. */
export const ROUND_CLOCK_MAX_AGE_MS = 60_000;
/** A round read that takes longer than this is not worth the paid path's time. */
export const ROUND_CLOCK_TIMEOUT_MS = 1_500;

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

export interface HandlerBudget {
  /** Milliseconds the handler may run before we give up and return 504. */
  readonly ms: number;
  /**
   * Where the remaining-rounds figure came from.
   *
   *  - `chain_round` — `lastValid` minus the live chain round. The real answer.
   *  - `window_length` — algod was unreachable, so we assumed the group was
   *    built for the round it is being presented in and used its whole window.
   *    Optimistic by however long the caller sat on it, and bounded by the cap.
   *  - `quoted_cap` — we could not read the payment's window at all, so the
   *    only deadline left is the one we advertise.
   */
  readonly basis: 'chain_round' | 'window_length' | 'quoted_cap';
  readonly lastValid: number | null;
  readonly currentRound: number | null;
  readonly remainingRounds: number | null;
}

/** The ceiling, as a budget. Used when the payment tells us nothing. */
export function quotedCapBudget(): HandlerBudget {
  return {
    ms: QUOTED_TIMEOUT_SECONDS * 1_000,
    basis: 'quoted_cap',
    lastValid: null,
    currentRound: null,
    remainingRounds: null,
  };
}

/**
 * How long this request's handler may run, given the payment it arrived with.
 *
 * Never returns more than {@link QUOTED_TIMEOUT_SECONDS}. May return `ms: 0`,
 * which means the payment is already inside its settle headroom and the
 * handler must not run at all — the data would be unbillable before it was
 * computed, so computing it would be pure loss.
 */
export function handlerBudget(
  payment: DecodedPayment | null,
  currentRound: number | null,
): HandlerBudget {
  const lastValid = payment?.lastValid == null ? null : Number(payment.lastValid);
  if (lastValid === null || !Number.isFinite(lastValid)) return quotedCapBudget();

  let remainingRounds: number;
  let basis: HandlerBudget['basis'];

  if (currentRound !== null && currentRound > 0) {
    remainingRounds = lastValid - currentRound;
    basis = 'chain_round';
  } else if (payment?.firstValid != null) {
    // No chain to compare against. The caller is presenting the group now, so
    // the most it can possibly have left is the window it was built with.
    remainingRounds = lastValid - Number(payment.firstValid);
    basis = 'window_length';
  } else {
    return quotedCapBudget();
  }

  const usableRounds = remainingRounds - SETTLE_HEADROOM_ROUNDS;
  const ms = Math.round(usableRounds * SECONDS_PER_ROUND * 1_000);

  return {
    ms: Math.max(0, Math.min(ms, QUOTED_TIMEOUT_SECONDS * 1_000)),
    basis,
    lastValid,
    currentRound,
    remainingRounds,
  };
}

// ---------------------------------------------------------------------------
// The round clock
// ---------------------------------------------------------------------------

export interface RoundClock {
  /** The chain's current round, or null when it cannot be established. */
  current(): Promise<number | null>;
}

export interface RoundClockOptions {
  readonly algodUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/**
 * The payment chain's round, cheap enough to read on every paid request.
 *
 * Reading algod inline would put a network round-trip in front of every paid
 * handler, on the one path where latency is the product. So the round is
 * cached with the instant it was read and EXTRAPOLATED forward at
 * {@link SECONDS_PER_ROUND}; a read older than {@link ROUND_CLOCK_REFRESH_MS}
 * triggers a refresh in the background and the extrapolated value is returned
 * immediately. Only the very first paid request of a process — or one arriving
 * after {@link ROUND_CLOCK_MAX_AGE_MS} of silence — waits for a real read.
 *
 * Extrapolation is safe in one direction only, and this is that direction:
 * rounding `SECONDS_PER_ROUND` down makes the extrapolated round run slightly
 * AHEAD of the chain, which shortens the budget rather than lengthening it.
 *
 * This reads the algod of the PAYMENT network (`config/x402.ts`), not
 * `env.ALGOD_URL` — those are different chains, and DEPLOYMENT.md §3's
 * correction is the record of what happens when the two get confused.
 */
export function createRoundClock(options: RoundClockOptions): RoundClock {
  const url = `${options.algodUrl.replace(/\/+$/, '')}/v2/status`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  let observed: { round: number; atMs: number } | null = null;
  let inFlight: Promise<number | null> | null = null;

  async function read(): Promise<number | null> {
    inFlight ??= (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ROUND_CLOCK_TIMEOUT_MS);
      try {
        const res = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`algod status -> ${res.status}`);
        const body = (await res.json()) as { 'last-round'?: unknown };
        const round = Number(body['last-round']);
        if (!Number.isInteger(round) || round <= 0) throw new Error('algod status had no last-round');
        observed = { round, atMs: now() };
        return round;
      } catch (err) {
        // Not an error for the request: `handlerBudget` falls back to the
        // payment's own window length, which is a worse deadline than the
        // chain gives us but is still a deadline.
        log.warn({ err, url }, 'could not read the payment chain round; deadline falls back to the payment window');
        return null;
      } finally {
        clearTimeout(timer);
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    async current(): Promise<number | null> {
      const seen = observed;
      if (seen !== null) {
        const ageMs = now() - seen.atMs;
        if (ageMs <= ROUND_CLOCK_MAX_AGE_MS) {
          if (ageMs > ROUND_CLOCK_REFRESH_MS) void read();
          return seen.round + Math.floor(ageMs / (SECONDS_PER_ROUND * 1_000));
        }
      }
      return read();
    },
  };
}

// ---------------------------------------------------------------------------
// Sharing the deadline with the handler
// ---------------------------------------------------------------------------

declare module 'hono' {
  interface ContextVariableMap {
    /**
     * Epoch-ms instant at which the gate will abandon this request with a 504.
     *
     * Set by the gate on every paid request and read by the handlers that can
     * spend real time — `?fresh=true` bounds its upstream fetch budget by it
     * (`connectors/budget.ts`). A handler that runs out of upstream budget can
     * return a labelled 502 with a reason, which is a better answer than being
     * guillotined by the deadline, and neither one is charged for.
     */
    paidDeadlineAtMs: number;
  }
}

export function setPaidDeadline(c: Context, atMs: number): void {
  c.set('paidDeadlineAtMs', atMs);
}

/** The gate's deadline for this request, or null on a free/ungated one. */
export function paidDeadlineAt(c: Context): number | null {
  const value = c.get('paidDeadlineAtMs');
  return typeof value === 'number' ? value : null;
}

// ---------------------------------------------------------------------------
// Racing the handler
// ---------------------------------------------------------------------------

/**
 * Run `settled` against a deadline. True means the deadline won.
 *
 * `settled` must be a promise that never rejects — the caller captures the
 * handler's error itself — because a rejection losing this race would be an
 * unhandled rejection on a request we have already answered.
 */
export async function raceDeadline(settled: Promise<void>, budgetMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
  });
  try {
    return (await Promise.race([settled.then(() => 'done' as const), expiry])) === 'expired';
  } finally {
    clearTimeout(timer);
  }
}
