import { env } from '../config/env.js';
import { query as poolQuery } from '../db/pool.js';
import type { Query } from '../gate/ledger.js';
import { logger } from '../logger.js';

/**
 * The weekly volume-integrity review — DEPLOYMENT.md §7.2, PRD.md §7.6, and
 * LAUNCH_LOG.md §4g item 5.
 *
 * ## Why this is a job and not a runbook
 *
 * §7.2 already defines the threshold and both queries, and calls itself "a
 * compliance control, not a metrics ritual". What it did not have was anything
 * that runs it. The rule that disqualifies an entry was the one rule nobody was
 * watching automatically, and a control that depends on somebody remembering to
 * open a database session is a control that gets noticed at submission rather
 * than on day two.
 *
 * ## The two queries are not the same kind of thing
 *
 * §7.2 prints them together, but they have different severities and this job
 * treats them differently:
 *
 *  - **Payer concentration** is a REPORT. A single payer over
 *    {@link CONCENTRATION_THRESHOLD} of settled volume is not misconduct — it
 *    may be one enthusiastic integrator — but §7.2 says to "identify it before
 *    treating the number as a win", so it is surfaced and logged at WARN.
 *  - **Our own addresses in the ledger** is an ALARM. §7.2: "that is the
 *    failure mode that disqualifies an entry." Any row at all, beyond the
 *    single logged §5.1 verification payment, is logged at ERROR and marks the
 *    whole check `alarm`. It is not a number to interpret; it is a stop signal.
 *
 * ## It reads; it never writes and never blocks a request
 *
 * Like `settleStats`, every read degrades to null rather than throwing. A
 * compliance report that takes the service down when Postgres hiccups is a
 * worse outcome than one that says it could not run — and `/health` renders
 * that honestly rather than as a clean bill of health.
 */

const log = logger.child({ component: 'concentration' });

/** §7.2 / PRD.md §7.6 — the share of settled volume that requires explaining. */
export const CONCENTRATION_THRESHOLD = 0.4;

/** §7.2 runs weekly, over a trailing 7 days. */
export const CONCENTRATION_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
export const CONCENTRATION_WINDOW_DAYS = 7;

/** How long after boot the first run fires. */
export const CONCENTRATION_START_DELAY_SECONDS = 60;

/** Payers listed individually on `/health`; the rest are counted, not named. */
export const CONCENTRATION_TOP_N = 5;

export interface PayerShare {
  readonly payer: string;
  readonly calls: number;
  readonly usdc: number;
  /** Share of settled volume in the window, 0..1. */
  readonly share: number;
}

export interface OwnAddressHit {
  readonly payer: string;
  readonly paymentTxid: string;
  readonly settledAt: string;
  readonly route: string;
  readonly amountAtomic: number;
}

export interface ConcentrationReport {
  readonly ran_at: string;
  readonly window_days: number;
  readonly threshold: number;
  /**
   * `ok` — nothing to look at. `review` — a payer is over the threshold.
   * `alarm` — one of our own addresses appears. `unknown` — the ledger could
   * not be read, which is not the same as clean.
   */
  readonly status: 'ok' | 'review' | 'alarm' | 'unknown';
  readonly settled_calls: number;
  readonly settled_usdc: number;
  readonly distinct_payers: number;
  /** The largest single payer's share of settled volume, or null with no volume. */
  readonly top_payer_share: number | null;
  readonly top_payers: readonly PayerShare[];
  /**
   * False when `OWN_PAYER_ADDRESSES` is unset. The §7.2 alarm cannot fire on an
   * empty list, and reporting `ok` for a check that could not run is exactly
   * the kind of quiet green light this job exists to remove.
   */
  readonly own_addresses_configured: boolean;
  readonly own_address_hits: readonly OwnAddressHit[];
}

/**
 * §7.2's first query, verbatim in intent: settled volume per payer over the
 * trailing week, with each payer's percentage of the total.
 *
 * `sum(...) OVER ()` is §7.2's own window function — the share has to be
 * computed in the same pass as the totals, or a payer that settles between two
 * queries changes the denominator underneath the numerator.
 */
export async function payerShares(
  windowDays: number = CONCENTRATION_WINDOW_DAYS,
  query: Query = poolQuery,
): Promise<PayerShare[] | null> {
  try {
    const res = await query<{ payer: string; calls: string; usdc: string; share: string }>(
      `SELECT payer,
              count(*)                 AS calls,
              sum(amount_atomic) / 1e6 AS usdc,
              sum(amount_atomic)::numeric / NULLIF(SUM(sum(amount_atomic)) OVER (), 0) AS share
         FROM payments
        WHERE status = 'settled'
          AND settled_at > now() - make_interval(days => $1)
        GROUP BY payer
        ORDER BY sum(amount_atomic) DESC`,
      [windowDays],
    );
    return res.rows.map((row) => ({
      payer: row.payer,
      calls: Number(row.calls),
      usdc: Number(row.usdc),
      share: Number(row.share ?? 0),
    }));
  } catch (err) {
    log.warn({ err, window_days: windowDays }, 'payer concentration query failed');
    return null;
  }
}

/**
 * §7.2's second query: "our own addresses must never appear."
 *
 * Not windowed to seven days, and that is deliberate — §7.2's rule is about the
 * ledger as a whole ("after the §5.1 verification txn"), so a self-payment made
 * eight days ago must not age out of the alarm the week after it happened.
 *
 * An empty configured list returns an empty result rather than scanning for
 * nothing; the caller reports `own_addresses_configured: false` so the absence
 * of hits cannot be mistaken for the absence of a problem.
 */
export async function ownAddressHits(
  addresses: readonly string[] = env.OWN_PAYER_ADDRESSES,
  query: Query = poolQuery,
): Promise<OwnAddressHit[] | null> {
  if (addresses.length === 0) return [];
  try {
    const res = await query<{
      payer: string;
      payment_txid: string;
      settled_at: Date | string;
      route: string;
      amount_atomic: string;
    }>(
      `SELECT payer, payment_txid, settled_at, route, amount_atomic
         FROM payments
        WHERE payer = ANY($1::text[])
        ORDER BY settled_at DESC`,
      [[...addresses]],
    );
    return res.rows.map((row) => ({
      payer: row.payer,
      paymentTxid: row.payment_txid,
      settledAt: row.settled_at instanceof Date ? row.settled_at.toISOString() : String(row.settled_at),
      route: row.route,
      amountAtomic: Number(row.amount_atomic),
    }));
  } catch (err) {
    log.warn({ err }, 'own-address sanity query failed');
    return null;
  }
}

/** Both queries, folded into the report `/health` publishes. */
export async function runConcentrationCheck(
  addresses: readonly string[] = env.OWN_PAYER_ADDRESSES,
  query: Query = poolQuery,
  now: () => Date = () => new Date(),
): Promise<ConcentrationReport> {
  const [shares, hits] = await Promise.all([
    payerShares(CONCENTRATION_WINDOW_DAYS, query),
    ownAddressHits(addresses, query),
  ]);

  const ranAt = now().toISOString();
  const base = {
    ran_at: ranAt,
    window_days: CONCENTRATION_WINDOW_DAYS,
    threshold: CONCENTRATION_THRESHOLD,
    own_addresses_configured: addresses.length > 0,
  } as const;

  if (shares === null || hits === null) {
    return {
      ...base,
      status: 'unknown',
      settled_calls: 0,
      settled_usdc: 0,
      distinct_payers: 0,
      top_payer_share: null,
      top_payers: [],
      own_address_hits: hits ?? [],
    };
  }

  const settledCalls = shares.reduce((total, row) => total + row.calls, 0);
  const settledUsdc = shares.reduce((total, row) => total + row.usdc, 0);
  const topShare = shares[0]?.share ?? null;

  // Alarm beats review: if one of our own addresses paid us, the concentration
  // number is not the finding and must not be what an operator reads first.
  const status: ConcentrationReport['status'] =
    hits.length > 0 ? 'alarm' : topShare !== null && topShare > CONCENTRATION_THRESHOLD ? 'review' : 'ok';

  const report: ConcentrationReport = {
    ...base,
    status,
    settled_calls: settledCalls,
    settled_usdc: Number(settledUsdc.toFixed(6)),
    distinct_payers: shares.length,
    top_payer_share: topShare === null ? null : Number(topShare.toFixed(4)),
    top_payers: shares.slice(0, CONCENTRATION_TOP_N),
    own_address_hits: hits,
  };

  if (status === 'alarm') {
    log.error(
      { hits, own_addresses: addresses.length },
      'DEPLOYMENT.md §7.2 ALARM: one of our own addresses appears in the payments ledger. ' +
        'Beyond the single logged §5.1 verification payment this is the failure mode that ' +
        'disqualifies an entry — stop and investigate.',
    );
  } else if (status === 'review') {
    log.warn(
      { top_payer_share: report.top_payer_share, distinct_payers: shares.length, threshold: CONCENTRATION_THRESHOLD },
      'DEPLOYMENT.md §7.2: a single payer is over the concentration threshold; identify it before ' +
        'treating the volume as a win',
    );
  } else {
    log.info(
      {
        settled_calls: settledCalls,
        distinct_payers: shares.length,
        top_payer_share: report.top_payer_share,
        own_addresses_configured: report.own_addresses_configured,
      },
      'weekly volume integrity review complete',
    );
  }

  return report;
}

/**
 * The scheduler.
 *
 * Weekly, and it holds the last report so `/health` can publish concentration
 * without a database session — §4g item 5's other half. The first run is 60 s
 * after boot rather than a week later, because a monitor whose first data point
 * is seven days away is a monitor that does not exist for the week that matters
 * most.
 */
export class ConcentrationMonitor {
  #timer: NodeJS.Timeout | null = null;
  #delay: NodeJS.Timeout | null = null;
  #last: ConcentrationReport | null = null;
  #running = false;

  constructor(
    private readonly addresses: () => readonly string[] = () => env.OWN_PAYER_ADDRESSES,
    private readonly query: Query = poolQuery,
  ) {}

  async run(): Promise<ConcentrationReport | null> {
    if (this.#running) {
      log.warn('previous concentration check still running; skipping this run');
      return this.#last;
    }
    this.#running = true;
    try {
      this.#last = await runConcentrationCheck(this.addresses(), this.query);
      return this.#last;
    } finally {
      this.#running = false;
    }
  }

  start(): void {
    this.#delay = setTimeout(() => {
      void this.run();
      this.#timer = setInterval(() => void this.run(), CONCENTRATION_INTERVAL_SECONDS * 1_000);
      this.#timer.unref();
    }, CONCENTRATION_START_DELAY_SECONDS * 1_000);
    this.#delay.unref();
    log.info(
      {
        interval_s: CONCENTRATION_INTERVAL_SECONDS,
        window_days: CONCENTRATION_WINDOW_DAYS,
        threshold: CONCENTRATION_THRESHOLD,
        own_addresses_configured: this.addresses().length,
      },
      'volume integrity monitor started',
    );
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    if (this.#delay !== null) clearTimeout(this.#delay);
    this.#timer = null;
    this.#delay = null;
  }

  /** The last report, or null before the first run. Never faked. */
  stats(): ConcentrationReport | null {
    return this.#last;
  }
}

export const concentrationMonitor = new ConcentrationMonitor();
