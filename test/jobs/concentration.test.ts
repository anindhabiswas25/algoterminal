import { describe, it, expect } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';

import type { Query } from '../../src/gate/ledger.js';
import {
  CONCENTRATION_THRESHOLD,
  ConcentrationMonitor,
  ownAddressHits,
  payerShares,
  runConcentrationCheck,
} from '../../src/jobs/concentration.js';

/**
 * The weekly volume-integrity review — DEPLOYMENT.md §7.2, LAUNCH_LOG.md §4g
 * item 5.
 *
 * §7.2's own words: "If the second query returns anything beyond the one logged
 * verification payment, stop and investigate — that is the failure mode that
 * disqualifies an entry." These tests are about that sentence being mechanised
 * rather than remembered, and about the two queries having different severities.
 */

/** A query double: routes by which SQL was asked for, and can be made to fail. */
function fakeQuery(rows: { shares?: unknown[]; hits?: unknown[]; fail?: 'shares' | 'hits' | 'both' }): Query {
  return (async (text: string) => {
    const isShares = text.includes('GROUP BY payer');
    if (rows.fail === 'both' || rows.fail === (isShares ? 'shares' : 'hits')) {
      throw new Error('connection terminated');
    }
    const data = (isShares ? rows.shares : rows.hits) ?? [];
    return { rows: data, rowCount: data.length } as unknown as QueryResult<QueryResultRow>;
  }) as Query;
}

const share = (payer: string, calls: number, atomic: number, pct: number) => ({
  payer,
  calls: String(calls),
  usdc: String(atomic / 1e6),
  share: String(pct),
});

const hit = (payer: string) => ({
  payer,
  payment_txid: 'TXID',
  settled_at: new Date('2026-09-01T00:00:00Z'),
  route: '/metric/{protocol}/{kpi}',
  amount_atomic: '5000',
});

const OURS = ['SELF7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];

// ---------------------------------------------------------------------------

describe('the concentration report (§7.2 query 1)', () => {
  it('is ok when volume is spread across payers', async () => {
    const report = await runConcentrationCheck(
      OURS,
      fakeQuery({ shares: [share('A', 10, 50_000, 0.3), share('B', 9, 45_000, 0.27)] }),
    );

    expect(report.status).toBe('ok');
    expect(report.distinct_payers).toBe(2);
    expect(report.settled_calls).toBe(19);
    expect(report.top_payer_share).toBe(0.3);
  });

  it('flags review — not alarm — when one payer is over the threshold', async () => {
    // §7.2 says to "identify it before treating the number as a win", which is
    // a thing to look into, not a thing that is wrong. Keeping this distinct
    // from `alarm` is what stops the real alarm from being tuned out.
    const report = await runConcentrationCheck(
      OURS,
      fakeQuery({ shares: [share('WHALE', 90, 450_000, 0.9), share('B', 5, 25_000, 0.05)] }),
    );

    expect(report.status).toBe('review');
    expect(report.top_payer_share).toBe(0.9);
    expect(report.threshold).toBe(CONCENTRATION_THRESHOLD);
  });

  it('treats the threshold as an inclusive bound', async () => {
    // Exactly 40% does not "exceed" 40%, matching how §3.5's thresholds are
    // read everywhere else in this service.
    const report = await runConcentrationCheck(OURS, fakeQuery({ shares: [share('A', 4, 20_000, 0.4)] }));
    expect(report.status).toBe('ok');
  });

  it('reports no payers rather than dividing by zero on an empty ledger', async () => {
    const report = await runConcentrationCheck(OURS, fakeQuery({ shares: [] }));
    expect(report.status).toBe('ok');
    expect(report.top_payer_share).toBeNull();
    expect(report.settled_usdc).toBe(0);
  });
});

describe('the own-address alarm (§7.2 query 2)', () => {
  it('is an alarm, and it outranks the concentration finding', async () => {
    // Both conditions at once. If our own address paid us, the concentration
    // percentage is not the headline and must not be what an operator reads
    // first — this is the failure mode that disqualifies an entry.
    const report = await runConcentrationCheck(
      OURS,
      fakeQuery({ shares: [share('WHALE', 90, 450_000, 0.95)], hits: [hit(OURS[0] as string)] }),
    );

    expect(report.status).toBe('alarm');
    expect(report.own_address_hits).toHaveLength(1);
    expect(report.own_address_hits[0]?.payer).toBe(OURS[0]);
    // Serialised, because a `Date` from pg is not something a JSON health
    // endpoint should be shipping raw.
    expect(report.own_address_hits[0]?.settledAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('says so when no addresses are configured, instead of reporting a clean bill', async () => {
    // The trap this avoids: an unset `OWN_PAYER_ADDRESSES` finds nothing, and
    // "found nothing" would read identically to "checked and it was clean".
    // §4g item 5 requires the check to keep working when the mainnet payTo is
    // added, and the first step is admitting when it is not watching anything.
    const report = await runConcentrationCheck([], fakeQuery({ shares: [share('A', 1, 5_000, 1)] }));

    expect(report.own_addresses_configured).toBe(false);
    expect(report.own_address_hits).toHaveLength(0);
    expect(report.status).toBe('review');
  });

  it('watches whatever list it is given, so a new address is one config change', async () => {
    const added = [...OURS, 'NEW57AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'];
    const hits = await ownAddressHits(added, fakeQuery({ hits: [hit(added[1] as string)] }));
    expect(hits).toHaveLength(1);
  });

  it('does not window the alarm to seven days', async () => {
    // §7.2's rule is about the ledger as a whole ("after the §5.1 verification
    // txn"). A self-payment made eight days ago must not age out of the alarm
    // the week after it happened.
    let sql = '';
    const q = (async (text: string) => {
      sql = text;
      return { rows: [], rowCount: 0 } as unknown as QueryResult<QueryResultRow>;
    }) as Query;

    await ownAddressHits(OURS, q);
    expect(sql).not.toContain('make_interval');
  });
});

describe('when the ledger cannot be read', () => {
  it('reports unknown rather than ok', async () => {
    // The same rule `settleStats` follows: a control that could not run must
    // not look like a control that passed.
    const report = await runConcentrationCheck(OURS, fakeQuery({ fail: 'both' }));
    expect(report.status).toBe('unknown');
    expect(report.top_payer_share).toBeNull();
  });

  it('reports unknown when only the alarm query fails', async () => {
    const report = await runConcentrationCheck(
      OURS,
      fakeQuery({ shares: [share('A', 1, 5_000, 1)], fail: 'hits' }),
    );
    expect(report.status).toBe('unknown');
  });

  it('never throws into whatever called it', async () => {
    await expect(payerShares(7, fakeQuery({ fail: 'shares' }))).resolves.toBeNull();
    await expect(ownAddressHits(OURS, fakeQuery({ fail: 'hits' }))).resolves.toBeNull();
  });
});

describe('ConcentrationMonitor', () => {
  it('publishes nothing until it has actually run', async () => {
    // `/health` renders this straight through, and a monitor that reported a
    // clean result before running would be worse than no monitor at all.
    const monitor = new ConcentrationMonitor(() => OURS, fakeQuery({ shares: [] }));
    expect(monitor.stats()).toBeNull();

    await monitor.run();
    expect(monitor.stats()?.status).toBe('ok');
  });

  it('holds the last report so /health needs no database session', async () => {
    const monitor = new ConcentrationMonitor(
      () => OURS,
      fakeQuery({ shares: [share('WHALE', 9, 45_000, 0.8)] }),
    );
    await monitor.run();

    // Read twice, no second query: the whole point of §4g item 5's "visible
    // without a database session" is that reading it is free.
    expect(monitor.stats()).toBe(monitor.stats());
    expect(monitor.stats()?.status).toBe('review');
  });
});
