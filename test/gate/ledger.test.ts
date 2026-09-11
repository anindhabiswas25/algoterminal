import { describe, it, expect } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';

import { isReplayed, recordPayment, settleStats, type PaymentRow, type Query } from '../../src/gate/ledger.js';

/**
 * The ledger's one universal contract: **nothing here throws into a request.**
 *
 * A ledger write failing must not retract a response the caller already has
 * (ARCHITECTURE.md §5.2), and a ledger read failing must not turn a valid
 * payment into a 500. The read fails *open* and the write fails *closed*, and
 * that asymmetry is the point of these tests.
 */

const ROW: PaymentRow = {
  paymentTxid: 'PAYMENTTXID',
  txid: 'SETTLETXID',
  payer: 'PAYER',
  amountAtomic: 5_000,
  assetId: 10458941,
  route: '/metric/{protocol}/{kpi}',
  network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
  status: 'settled',
};

/** A query that always fails, the way an unreachable database does. */
const broken: Query = async () => {
  throw new Error('ECONNREFUSED 127.0.0.1:5432');
};

function rows<R extends QueryResultRow>(list: R[]): Query {
  return (async () =>
    ({ rows: list, rowCount: list.length, command: '', oid: 0, fields: [] }) as unknown as QueryResult) as Query;
}

describe('when the database is unreachable', () => {
  it('fails OPEN on the replay read', async () => {
    // A wrong `false` costs us a duplicate the facilitator rejects anyway. A
    // wrong `true` refuses a caller's valid, already-signed payment.
    expect(await isReplayed('X', broken)).toBe(false);
  });

  it('reports that the write did not happen, rather than throwing', async () => {
    // The caller already has its data; the response must stand. What it must
    // not do is believe the money was accounted for.
    expect(await recordPayment(ROW, broken)).toBe(false);
  });

  it('reports settle stats as unmeasured, not as zero failures', async () => {
    // `computeStatus` treats null as non-degrading. Reporting 0 would let an
    // outage look healthy.
    expect(await settleStats(300, broken)).toBeNull();
  });
});

describe('when the database answers', () => {
  it('reports a replay when a row exists', async () => {
    expect(await isReplayed('X', rows([{ exists: true }]))).toBe(true);
    expect(await isReplayed('X', rows([]))).toBe(false);
  });

  it('reports a duplicate write as not inserted', async () => {
    // ON CONFLICT DO NOTHING returns zero rows. That is a bug worth seeing,
    // not a row to silently overwrite — overwriting is how a `settled` row
    // quietly becomes `settle_failed` and the money appears to have vanished.
    expect(await recordPayment(ROW, rows([{ ok: 1 }]))).toBe(true);
    expect(await recordPayment(ROW, rows([]))).toBe(false);
  });

  it('returns failures alongside the attempts they are a rate over', async () => {
    // A count without its denominator cannot express §3.5's rule: three
    // failures out of four is an outage, three out of a thousand is a Tuesday.
    expect(await settleStats(300, rows([{ failed: '3', attempts: '40' }]))).toEqual({
      failed: 3,
      attempts: 40,
    });
  });

  it('treats an empty result as no activity, not as an error', async () => {
    expect(await settleStats(300, rows([]))).toEqual({ failed: 0, attempts: 0 });
  });
});
