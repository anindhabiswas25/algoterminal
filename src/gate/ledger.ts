import type { QueryResult, QueryResultRow } from 'pg';

import { query as poolQuery } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * The payment ledger — `payments` (DEPLOYMENT.md §3, migration 002).
 *
 * Three jobs, all of them about knowing what we were actually paid:
 *
 * 1. The replay guard (API_SPEC.md §2.4, 409 `payment_replayed`). Read before
 *    verify, so a replayed payment costs us no work and no facilitator call.
 * 2. The settled row, written after a successful settle. This is the record
 *    reconciled against the leaderboard and the input to payer concentration
 *    (PRD.md §7.6).
 * 3. The `settle_failed` row (ARCHITECTURE.md §5.2). We have already returned
 *    the data, so we eat the loss — but an unnoticed settle-failure rate is
 *    silent revenue loss and a leaderboard discrepancy, so it is written with
 *    the payment payload attached and surfaced on `/health`.
 *
 * Nothing here throws into a request. A ledger write failing must not retract a
 * response the caller already has, and a ledger read failing must not turn a
 * valid payment into a 500 — both degrade to a logged ERROR, which is the
 * behaviour §5.2 asks for on the settle path and the safe direction on the read
 * path (we let a possibly-replayed payment through to the facilitator, which
 * has the authoritative double-spend guard, rather than rejecting a good one).
 */

/**
 * The query function these use, injectable at every call site.
 *
 * "Never throws" is the contract of this module, and it is only testable if a
 * test can make the database fail on demand. Pointing the real pool at a dead
 * port would make the test pass or fail depending on whether the machine
 * running it happens to have Postgres up — which is a test of the machine, not
 * of the code.
 */
export type Query = <R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<QueryResult<R>>;

const log = logger.child({ component: 'ledger' });

export type PaymentStatus = 'settled' | 'settle_failed';

export interface PaymentRow {
  /**
   * The caller's own signed payment transaction id, computed locally from the
   * `PAYMENT-SIGNATURE` payload. The primary key: it is the only identifier
   * that exists for BOTH a settled payment and a failed settle, and the only
   * one available before verify, which is when the replay guard has to run.
   */
  readonly paymentTxid: string;
  /** The facilitator's settlement txid. Null on a `settle_failed` row. */
  readonly txid: string | null;
  readonly payer: string;
  readonly amountAtomic: number;
  readonly assetId: number;
  /** The route pattern charged, e.g. `GET /metric/:protocol/:kpi`. */
  readonly route: string;
  /** CAIP-2 network id. */
  readonly network: string;
  readonly status: PaymentStatus;
  /** §5.2 — the payment payload, kept only on a failure, for reconciliation. */
  readonly payload?: unknown;
  readonly errorReason?: string | null;
}

/**
 * Has this payment already been recorded?
 *
 * Read BEFORE verify, so a replay is a 409 that costs one indexed primary-key
 * lookup rather than a facilitator round-trip and a handler execution.
 *
 * This is a guard on OUR accounting, not the authoritative double-spend check:
 * two concurrent replays both pass this read, and it is the facilitator —
 * which sees the group already committed on chain — that rejects the second at
 * verify, with the primary key catching it again at write time. That layering
 * is deliberate and is what ARCHITECTURE.md §4.1 describes; a lock here would
 * add a write to every paid request to close a window the chain already closes.
 *
 * Returns `false` when the ledger is unreadable. Failing open is correct here
 * and only here: the cost of a wrong `false` is a duplicate the facilitator
 * will reject anyway, while the cost of a wrong `true` is refusing a caller's
 * valid, already-signed payment.
 */
export async function isReplayed(paymentTxid: string, query: Query = poolQuery): Promise<boolean> {
  try {
    const res = await query<{ exists: boolean }>(
      'SELECT true AS exists FROM payments WHERE payment_txid = $1',
      [paymentTxid],
    );
    return res.rowCount !== null && res.rowCount > 0;
  } catch (err) {
    log.error({ err, payment_txid: paymentTxid }, 'replay guard read failed; allowing through');
    return false;
  }
}

/**
 * Write one ledger row.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert: a payment recorded twice is a
 * bug we want to see in the returned `false`, not a row we silently overwrite —
 * overwriting is how a `settled` row quietly becomes a `settle_failed` one and
 * the money appears to have vanished.
 *
 * Returns whether a row was inserted. Never throws.
 */
export async function recordPayment(row: PaymentRow, query: Query = poolQuery): Promise<boolean> {
  try {
    const res = await query(
      `INSERT INTO payments
         (payment_txid, txid, payer, amount_atomic, asset_id, route, network, status, payload, error_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (payment_txid) DO NOTHING`,
      [
        row.paymentTxid,
        row.txid,
        row.payer,
        row.amountAtomic,
        row.assetId,
        row.route,
        row.network,
        row.status,
        row.payload === undefined ? null : JSON.stringify(row.payload),
        row.errorReason ?? null,
      ],
    );
    const inserted = res.rowCount !== null && res.rowCount > 0;
    if (!inserted) {
      log.warn({ payment_txid: row.paymentTxid }, 'ledger row already existed; not overwritten');
    }
    return inserted;
  } catch (err) {
    // The caller already has its data. A ledger write failure is an accounting
    // problem to alert on, never a reason to retract a delivered response.
    log.error({ err, row: { ...row, payload: undefined } }, 'ledger write failed');
    return false;
  }
}

export interface SettleStats {
  /** Rows with status `settle_failed` in the window. */
  readonly failed: number;
  /** All settle attempts recorded in the window (settled + failed). */
  readonly attempts: number;
}

/**
 * Settle outcomes over a trailing window, for `/health` (API_SPEC.md §3.5).
 *
 * One query returning both numbers, because the §3.5 degradation rule is a
 * RATE ("settle failures exceed 5% over 5 minutes"), and a count without its
 * denominator cannot express it: three failures out of four is an outage,
 * three out of a thousand is a Tuesday.
 *
 * Returns null when the ledger is unreadable — `/health` renders that as "not
 * measured", which `computeStatus` treats as non-degrading. A health endpoint
 * that reports zero failures because it could not count is worse than one that
 * admits it does not know.
 */
export async function settleStats(
  windowSeconds: number,
  query: Query = poolQuery,
): Promise<SettleStats | null> {
  try {
    const res = await query<{ failed: string; attempts: string }>(
      `SELECT count(*) FILTER (WHERE status = 'settle_failed') AS failed,
              count(*)                                        AS attempts
         FROM payments
        WHERE settled_at > now() - make_interval(secs => $1)`,
      [windowSeconds],
    );
    const row = res.rows[0];
    if (row === undefined) return { failed: 0, attempts: 0 };
    return { failed: Number(row.failed), attempts: Number(row.attempts) };
  } catch (err) {
    log.warn({ err, window_seconds: windowSeconds }, 'settle stats read failed');
    return null;
  }
}
