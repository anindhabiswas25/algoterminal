import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import algosdk from 'algosdk';

import { ApiError, envelope } from '../../src/errors.js';
import {
  createRoundClock,
  handlerBudget,
  QUOTED_TIMEOUT_SECONDS,
  raceDeadline,
  SECONDS_PER_ROUND,
  SETTLE_HEADROOM_ROUNDS,
} from '../../src/gate/deadline.js';
import { paymentGate } from '../../src/gate/middleware.js';
import { identifyPayment } from '../../src/gate/payload.js';
import {
  buildPayment,
  decodePaymentRequired,
  fakeFacilitator,
  fakeLedger,
  fixedRoundClock,
  gateDeps,
  FIRST_VALID,
  type FakeFacilitator,
  type FakeLedger,
} from './helpers.js';

/**
 * The handler deadline — LAUNCH_LOG.md §4g item 1.
 *
 * ## Why this file exists at all
 *
 * §4f recorded a real `settle_failed` row: a 200 was delivered on `?fresh=true`
 * and the payment had already expired, so the data went out and $0.02 did not
 * come in. On MainNet that is uncapped silent revenue loss AND a leaderboard
 * discrepancy — data served with no transaction to show for it.
 *
 * That was found by a human noticing one line in a smoke run. The invariant it
 * violated is now the thing this file asserts, because a revenue-integrity
 * property discovered by reading logs is a property that will be violated again
 * the next time nobody reads them.
 *
 * ## The invariant, in one sentence
 *
 * A handler that outruns the payment's validity window produces a 504, no
 * ledger row, and no settle call — never a 200 we cannot bill for.
 */

const METRIC = '/metric/tinyman/tvl';

let facilitator: FakeFacilitator;
let ledger: FakeLedger;

/**
 * An app whose handler takes exactly as long as the test says.
 *
 * `?sleep=` is what makes "outruns its payment" a thing a test can cause
 * deterministically. The real slow path is a cold upstream fetch under
 * throttling, which is neither deterministic nor something to reproduce in a
 * unit test — what matters is the gate's behaviour when a handler is slow, not
 * why it was slow.
 */
function app(roundClock = fixedRoundClock(FIRST_VALID)): Hono {
  const a = new Hono();
  a.use('*', paymentGate(gateDeps(facilitator, ledger, roundClock)));

  a.get('/metric/:protocol/:kpi', async (c) => {
    const sleepMs = Number(c.req.query('sleep') ?? '0');
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    if (c.req.query('fail') === 'throw') throw new Error('handler exploded');
    return c.json({ metric: 'tvl', protocol: 'tinyman', value: 1 });
  });

  a.onError((err, c) =>
    err instanceof ApiError
      ? c.json(envelope(err.code, err.message, err.detail), err.status)
      : c.json(envelope('INTERNAL_ERROR', 'boom', {}), 500),
  );
  return a;
}

/** A 402, then a payment built against it with the given validity window. */
async function payFor(a: Hono, path: string, validity: number) {
  const unpaid = await a.request(path);
  const requirements = decodePaymentRequired(unpaid.headers.get('PAYMENT-REQUIRED')).accepts[0];
  return buildPayment(requirements as never, { validity });
}

beforeEach(() => {
  facilitator = fakeFacilitator();
  ledger = fakeLedger();
});

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe('a handler that outruns its payment window (§4g item 1)', () => {
  /**
   * The regression test for the §4f row, end to end through the real gate.
   *
   * The window is 4 rounds. Three of those are {@link SETTLE_HEADROOM_ROUNDS},
   * so the handler's budget is one round — ~2.7s — and a handler told to take
   * 4s cannot possibly make it. Every one of the three assertions below is a
   * separate way the old code lost money, and all three have to hold at once:
   * a 504 without a ledger row would still be wrong if we had settled, and a
   * missing settle would still be wrong if we had returned the data.
   */
  it('returns 504, writes no payments row, and never calls settle', async () => {
    const a = app();
    const payment = await payFor(a, METRIC, 4);

    const res = await a.request(`${METRIC}?sleep=4000`, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    expect(res.status).toBe(504);

    // No USDC moved, because we never asked for any to move. This is the
    // assertion the §4f failure would have failed: there, settle WAS called,
    // and it was the chain that refused.
    expect(facilitator.settleCalls).toHaveLength(0);

    // No ledger row of any status. Not a `settle_failed` row either — nothing
    // was attempted, so there is nothing to reconcile.
    expect(ledger.rows).toHaveLength(0);

    // And no settlement receipt was fabricated on the way out.
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
    expect(res.headers.get('X-AlgoTerminal-Settlement')).toBeNull();
  });

  it('tells the caller it was not charged, in the documented envelope', async () => {
    const a = app();
    const payment = await payFor(a, METRIC, 4);

    const res = await a.request(`${METRIC}?sleep=4000`, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });
    const body = (await res.json()) as {
      error: { code: string; message: string; detail: Record<string, unknown> };
    };

    expect(body.error.code).toBe('PAYMENT_WINDOW_EXPIRED');
    // Stated as data, not only in prose: an agent decides whether to retry off
    // these two fields, and "you were not charged" is the fact that makes an
    // immediate retry the right move rather than a gamble.
    expect(body.error.detail['charged']).toBe(false);
    expect(body.error.detail['settled']).toBe(false);
    expect(body.error.detail['budget_basis']).toBe('chain_round');
  });

  it('refuses before running the handler at all when the window is already gone', async () => {
    // The chain has advanced to one round before `lastValid`, which is inside
    // the settle headroom. There is no budget, so the handler must not run:
    // the data would be unbillable before it was computed, and computing it
    // would be a pure upstream cost with no revenue attached.
    const a = app(fixedRoundClock(FIRST_VALID + 9));
    const payment = await payFor(a, METRIC, 10);

    const res = await a.request(METRIC, { headers: { 'PAYMENT-SIGNATURE': payment.header } });

    expect(res.status).toBe(504);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it('still settles normally when the handler finishes inside the window', async () => {
    // The other half of the invariant, and the one that keeps it honest: a
    // deadline that 504s everything would pass every assertion above. A slow
    // handler inside a generous window is the ordinary paid request.
    const a = app();
    const payment = await payFor(a, METRIC, 1000);

    const res = await a.request(`${METRIC}?sleep=50`, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    expect(res.status).toBe(200);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.status).toBe('settled');
  });

  it('does not turn a handler error into a 504, or settle it', async () => {
    // A handler that throws inside its budget is the §5.2 case, not this one,
    // and it must still reach app.onError as a 500 rather than being reported
    // as a timeout. Both are uncharged; they are not the same diagnosis.
    const a = app();
    const payment = await payFor(a, METRIC, 1000);

    const res = await a.request(`${METRIC}?fail=throw`, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    expect(res.status).toBe(500);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The budget arithmetic
// ---------------------------------------------------------------------------

describe('handlerBudget', () => {
  // A real receiving address: `makeAssetTransferTxn` verifies the checksum, and
  // these tests are about the window on a genuinely signed transaction rather
  // than about a hand-written payload.
  const PAY_TO = String(algosdk.generateAccount().addr);

  const payment = (firstValid: number, lastValid: number) =>
    identifyPayment(
      buildPayment({ payTo: PAY_TO, amount: '5000', asset: '10458941' } as never, {
        validity: lastValid - firstValid,
      }).header,
    );

  it('derives the budget from the payment, not from the quoted timeout', () => {
    // The whole point of §4g item 1. An 11-round window — what an x402 AVM
    // client actually builds, algokit's `defaultValidityWindow` being 10 —
    // yields ~21s, not the 30 we advertise and certainly not the 60 we used to.
    const budget = handlerBudget(payment(FIRST_VALID, FIRST_VALID + 10), FIRST_VALID);

    expect(budget.basis).toBe('chain_round');
    expect(budget.remainingRounds).toBe(10);
    expect(budget.ms).toBe(Math.round((10 - SETTLE_HEADROOM_ROUNDS) * SECONDS_PER_ROUND * 1_000));
    expect(budget.ms).toBeLessThan(QUOTED_TIMEOUT_SECONDS * 1_000);
  });

  it('shrinks the budget as the chain advances through the window', () => {
    const early = handlerBudget(payment(FIRST_VALID, FIRST_VALID + 10), FIRST_VALID);
    const late = handlerBudget(payment(FIRST_VALID, FIRST_VALID + 10), FIRST_VALID + 5);

    // A payment presented five rounds into its own life has five rounds less to
    // give. Reading `firstValid` alone would have missed this entirely, and it
    // is exactly the case that bit us: the §4f settle arrived 110s after the
    // window closed on a group that was already partly spent when it arrived.
    expect(late.ms).toBeLessThan(early.ms);
    expect(late.remainingRounds).toBe(5);
  });

  it('never exceeds the timeout we advertise, however generous the window', () => {
    // A client is free to sign a payment valid for an hour. We are not free to
    // hold a request open for an hour: `maxTimeoutSeconds` is a promise, and
    // this is the line that keeps it one.
    const budget = handlerBudget(payment(FIRST_VALID, FIRST_VALID + 1000), FIRST_VALID);
    expect(budget.ms).toBe(QUOTED_TIMEOUT_SECONDS * 1_000);
  });

  it('falls back to the window length when the chain round is unknown', () => {
    // An algod blip must not restore the old behaviour of no deadline at all.
    // The fallback is optimistic — it assumes the group was built for right
    // now — but optimistic-and-bounded beats unbounded.
    const budget = handlerBudget(payment(FIRST_VALID, FIRST_VALID + 10), null);

    expect(budget.basis).toBe('window_length');
    expect(budget.ms).toBe(Math.round((10 - SETTLE_HEADROOM_ROUNDS) * SECONDS_PER_ROUND * 1_000));
  });

  it('falls back to the quoted cap when the payment cannot be read', () => {
    const budget = handlerBudget(null, 100);
    expect(budget.basis).toBe('quoted_cap');
    expect(budget.ms).toBe(QUOTED_TIMEOUT_SECONDS * 1_000);
  });

  it('gives no budget at all once the window is inside the settle headroom', () => {
    // Not a negative budget, and not a small one: zero, which the gate reads
    // as "do not run the handler".
    const budget = handlerBudget(
      payment(FIRST_VALID, FIRST_VALID + 10),
      FIRST_VALID + 10 - SETTLE_HEADROOM_ROUNDS,
    );
    expect(budget.ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The round clock
// ---------------------------------------------------------------------------

describe('createRoundClock', () => {
  function stubAlgod(rounds: number[]) {
    let calls = 0;
    const fetchImpl = (async () => {
      const round = rounds[Math.min(calls, rounds.length - 1)];
      calls += 1;
      return new Response(JSON.stringify({ 'last-round': round }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, callCount: () => calls };
  }

  it('reads algod once and then extrapolates, rather than blocking every request', async () => {
    // The paid path is latency-sensitive and this runs on all of it. One read
    // per couple of seconds is the difference between a deadline that costs
    // nothing and one that costs a network round-trip per request.
    const { fetchImpl, callCount } = stubAlgod([100]);
    let nowMs = 0;
    const clock = createRoundClock({ algodUrl: 'http://algod', fetch: fetchImpl, now: () => nowMs });

    expect(await clock.current()).toBe(100);
    expect(callCount()).toBe(1);

    // 1s later: still inside the refresh window, no second read, same round.
    nowMs = 1_000;
    expect(await clock.current()).toBe(100);
    expect(callCount()).toBe(1);
  });

  it('extrapolates forward, so the budget errs short rather than long', async () => {
    const { fetchImpl } = stubAlgod([100, 100]);
    let nowMs = 0;
    const clock = createRoundClock({ algodUrl: 'http://algod', fetch: fetchImpl, now: () => nowMs });
    await clock.current();

    // 27s later is ten rounds at 2.7s. Extrapolating rather than reporting the
    // stale 100 is what stops a quiet minute from handing out a budget the
    // chain has already spent.
    nowMs = 27_000;
    expect(await clock.current()).toBe(110);
  });

  it('reports null rather than a guess when algod cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;
    const clock = createRoundClock({ algodUrl: 'http://algod', fetch: fetchImpl });

    // Null, not zero and not a stale round: `handlerBudget` has a documented
    // fallback for "unknown", and none for "wrong".
    expect(await clock.current()).toBeNull();
  });
});

describe('raceDeadline', () => {
  it('reports the deadline winning without letting the loser reject', async () => {
    // The dangerous shape: a handler that fails AFTER we have answered. If its
    // rejection escaped the race it would be an unhandled rejection on a
    // request that already got its 504.
    const slowFailure = new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('too late')), 50),
    ).catch(() => undefined);

    expect(await raceDeadline(slowFailure, 5)).toBe(true);
    await slowFailure;
  });

  it('reports the handler winning when it finishes first', async () => {
    expect(await raceDeadline(Promise.resolve(), 1_000)).toBe(false);
  });
});
