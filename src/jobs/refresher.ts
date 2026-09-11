import { cacheDeps, writeFacts, type CacheDeps } from '../cache/index.js';
import type { FactKey } from '../cache/keys.js';
import { cycleFor, kpisForCycle, FAST_TTL_THRESHOLD_SECONDS, type CycleName } from '../cache/cycles.js';
import { CycleMetrics, type CycleStats } from '../cache/metrics.js';
import { groupByFetch, hotKeys } from '../cache/hotset.js';
import { logger } from '../logger.js';
import type { KpiId } from '../standardize/kpis.js';

/**
 * The refresher — ARCHITECTURE.md §4.6.
 *
 * "Why the cache is warm, not lucky." The 70% hit-rate target in PRD.md §5.1
 * is a floor produced by this job, not an average produced by caller luck: it
 * recomputes the hot set on a schedule, so the *first* caller of the minute
 * finds a warm entry too.
 *
 * ## Two cycles, not one
 *
 * §4.6 describes a single 60-second scheduler. Measured against the real
 * Tinyman connector at build step 5, a full refresh floors at ~65 seconds —
 * above its own interval. A single 60s cycle would therefore never complete
 * inside its period: every run would find the previous one still going, and
 * the honest implementations of that are either a queue that grows without
 * bound or a skip that means the cycle actually runs every 130 seconds while
 * the logs claim 60.
 *
 * The measurement that resolves it: a TVL-scoped refresh takes 13-14 seconds
 * and produces a byte-identical TVL. The whole 65 seconds is the per-pool
 * analytics lookups the 24h flow KPIs need — and those flows have a 600s TTL
 * (§6), so refreshing them every 60 seconds was buying nothing in the first
 * place. Splitting by TTL class gives each cycle a period it fits inside:
 *
 * | Cycle | Interval | KPIs | Measured |
 * |---|---|---|---|
 * | fast | 90s | registry TTL <= 300s (`tvl`, `total_borrows`, the rate models) | ~13-14s |
 * | slow | 600s | registry TTL > 300s (the 24h flows, `active_users_24h`, `pool_count`) | ~65s |
 *
 * The split is derived from the §6 TTLs in the registry, not from a hardcoded
 * list of KPI names: a KPI added with a 120s TTL joins the fast cycle by
 * definition, and one whose TTL is later relaxed moves on its own. `opts.kpis`
 * is what makes it cheap — that field exists precisely so a connector can skip
 * fetches a scoped refresh does not need.
 */

const log = logger.child({ component: 'refresher' });

// The TTL classes themselves live in `cache/cycles.ts`, below both this file
// and the read path, because both must agree on them: a cold caller fetches
// the same group this refreshes, and they share a lock.
export { cycleFor, kpisForCycle, FAST_TTL_THRESHOLD_SECONDS };
export type { CycleName };

/**
 * The fast cycle's interval — widened from 60 s to 90 s (LAUNCH_LOG.md §4g
 * item 3).
 *
 * ## What was wrong with 60
 *
 * `/health` showed the fast cycle taking 73.9 s against a 60 s interval, with
 * `overruns` and `skipped` both incrementing. Skipping is the right failure
 * (§4.6), but a cycle that cannot finish inside its interval is not a 60 s
 * cycle, and each skip means the hot set went two periods without a refresh —
 * so the entries are staler than the TTL implies, which is the one thing the
 * §6 policy is not allowed to be wrong about.
 *
 * ## Why 90, decided from §6 rather than from convenience
 *
 * The constraint the interval has to satisfy comes from §6, not from how long
 * the work happens to take. The fast class is the KPIs with a registry TTL at
 * or under {@link FAST_TTL_THRESHOLD_SECONDS}, and the TIGHTEST of those is
 * 120 s — the rate-model outputs (`utilization`, `supply_apr`, `borrow_apr`,
 * `net_apy`) that §6 gives 2 minutes because "risk agents act on these;
 * staleness here has a real cost". For an entry to be replaced before it
 * expires:
 *
 *   interval + cycle duration <= 120 s
 *
 * At the measured steady-state duration of ~13 s that permits anything up to
 * ~107 s. Ninety leaves both margins intact at once: 17 s of headroom against
 * the §6 TTL, and 90 s of room for a cycle that normally takes 13 — so a
 * cold-start run at the observed 73.9 s worst case now completes inside its
 * own interval instead of overrunning it. Sixty had headroom on only one of
 * those two, which is exactly the failure that was observed.
 *
 * ## Why not narrow the fast group instead
 *
 * That was the other option, and it is the wrong one here. The fast group is
 * not incidentally large — it is precisely the set of KPIs §6 assigns a short
 * TTL to, because they move fast enough to matter. Moving any of them to the
 * slow cycle would mean deliberately refreshing a number less often than the
 * policy that exists to describe how fast it changes says we should. Widening
 * the interval keeps every KPI in the class §6 put it in; narrowing the group
 * would have made the TTL table a description of nothing.
 *
 * The invariant is asserted in `test/jobs/refresher.test.ts` rather than left
 * to this comment, so a KPI added later with a 90 s TTL fails a test instead of
 * quietly becoming stale in production.
 */
export const FAST_INTERVAL_SECONDS = 90;

/**
 * The fast cycle's measured steady-state duration, in seconds.
 *
 * Recorded rather than estimated: 12.7 s on the deployed TestNet service on
 * 2026-09-09 (`/health`, `cache.refresher.fast.last_duration_ms: 12655`),
 * against 13-14 s measured at build step 5. Fourteen is used as the figure the
 * interval is checked against so the invariant is asserted at the slow end of
 * the range rather than the flattering one.
 *
 * It exists as a constant because the §6 invariant in
 * `test/jobs/refresher.test.ts` is stated in terms of it —
 * `interval + duration <= tightest fast-class TTL` — and a measurement that
 * only lives in a comment is one a test cannot hold anyone to.
 */
export const MEASURED_FAST_CYCLE_SECONDS = 14;
/** Matches the §6 TTL of the flow KPIs this cycle exists to keep warm. */
export const SLOW_INTERVAL_SECONDS = 600;
/**
 * How long the slow cycle waits at boot, so the fast one warms TVL first.
 *
 * One whole fast interval, tracked to {@link FAST_INTERVAL_SECONDS} rather
 * than written out, so widening the fast cycle cannot leave the two firing on
 * top of each other again — which is the contention that produced the 73.9 s
 * cold-start run in the first place.
 */
export const SLOW_CYCLE_START_DELAY_SECONDS = FAST_INTERVAL_SECONDS;

export interface RefreshResult {
  readonly cycle: CycleName;
  readonly durationMs: number;
  /** Fetch groups — one per (protocol, basis) — that succeeded. */
  readonly ok: number;
  readonly failed: number;
  readonly factsWritten: number;
  /** True when a previous run was still going and this one was skipped. */
  readonly skipped: boolean;
}

export class Refresher {
  readonly #metrics: Record<CycleName, CycleMetrics> = {
    fast: new CycleMetrics(FAST_INTERVAL_SECONDS),
    slow: new CycleMetrics(SLOW_INTERVAL_SECONDS),
  };
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #delays: NodeJS.Timeout[] = [];

  constructor(private readonly deps: () => CacheDeps = cacheDeps) {}

  /**
   * Run one cycle.
   *
   * ## Never overlaps itself
   *
   * If the previous run of this cycle is still going, this one is SKIPPED and
   * logged — not queued. Queueing is the failure mode that hurts: a cycle
   * running slightly long builds a backlog that never drains, and the work
   * that finally runs is stale by however long the queue has grown. Skipping
   * loses one refresh and stays honest about the period, and `skipped` on
   * `/health` is what makes the loss visible rather than silent.
   *
   * The guard is per-cycle, so a slow flow refresh never blocks the fast TVL
   * one — the whole reason there are two.
   */
  async runCycle(cycle: CycleName): Promise<RefreshResult> {
    const metrics = this.#metrics[cycle];
    if (metrics.running) {
      metrics.skip();
      log.warn(
        { cycle, interval_s: metrics.intervalSeconds },
        'previous cycle still running; skipping this run rather than queueing it',
      );
      return { cycle, durationMs: 0, ok: 0, failed: 0, factsWritten: 0, skipped: true };
    }

    metrics.start();
    const startedAt = performance.now();
    const d = this.deps();
    const wanted = new Set<KpiId>(kpisForCycle(cycle));

    // The hot set, narrowed to this cycle's KPIs. A group with nothing left
    // after the filter is not fetched at all — that is what stops the fast
    // cycle from paying for the flow lookups.
    const keys: FactKey[] = hotKeys(d.hot).filter((key) => wanted.has(key.kpi));
    const groups = groupByFetch(keys);

    let ok = 0;
    let failed = 0;
    let factsWritten = 0;

    // Groups run in sequence, not in parallel. Every group is a burst of
    // upstream requests against the same handful of hosts, and 8 unpaced
    // concurrent requests already earn a 429 with Retry-After: 18 — the
    // refresher must never be the thing that gets us rate-limited, because a
    // ban takes the paid path down with it.
    for (const group of groups) {
      try {
        const facts = await d.compute({
          protocol: group.protocol,
          kpis: group.kpis,
          params: group.params,
        });
        await writeFacts(group.protocol, group.params, facts, d);
        factsWritten += facts.length;
        ok += 1;
      } catch (err) {
        failed += 1;
        log.warn({ err, cycle, protocol: group.protocol }, 'refresh group failed');
      }
    }

    const durationMs = performance.now() - startedAt;
    metrics.finish({ durationMs, ok, failed, at: new Date().toISOString() });

    const drifting = durationMs > metrics.intervalSeconds * 1_000;
    log[drifting ? 'warn' : 'info'](
      {
        cycle,
        duration_ms: Math.round(durationMs),
        interval_s: metrics.intervalSeconds,
        groups: groups.length,
        keys: keys.length,
        facts_written: factsWritten,
        ok,
        failed,
        ...(drifting ? { drift: 'cycle exceeded its interval' } : {}),
      },
      'refresh cycle complete',
    );

    return { cycle, durationMs, ok, failed, factsWritten, skipped: false };
  }

  /**
   * Start both cycles.
   *
   * The fast cycle fires immediately; the slow one waits
   * {@link SLOW_CYCLE_START_DELAY_SECONDS}. They are not staggered for
   * tidiness — both firing at boot makes them fight for the same per-host
   * concurrency budget, and a cold start measured on live mainnet took the
   * fast cycle from its usual 13-38s to 72s, past its own interval (60s at the time; see
   * {@link FAST_INTERVAL_SECONDS}), with
   * a skipped run behind it. Letting TVL finish first costs the flow KPIs one
   * minute of their 600s TTL and buys a fast cycle that is warm a minute
   * sooner, which is the tier a rebalancing agent actually reads.
   */
  start(): void {
    this.#schedule('fast', 0);
    this.#schedule('slow', SLOW_CYCLE_START_DELAY_SECONDS * 1_000);
    log.info(
      {
        fast_s: FAST_INTERVAL_SECONDS,
        slow_s: SLOW_INTERVAL_SECONDS,
        slow_delay_s: SLOW_CYCLE_START_DELAY_SECONDS,
      },
      'refresher started',
    );
  }

  #schedule(cycle: CycleName, delayMs: number): void {
    const intervalMs = this.#metrics[cycle].intervalSeconds * 1_000;
    const begin = (): void => {
      void this.runCycle(cycle);
      const timer = setInterval(() => void this.runCycle(cycle), intervalMs);
      // Unref'd: the refresher must never be the reason the process refuses to
      // exit on SIGTERM.
      timer.unref();
      this.#timers.push(timer);
    };

    if (delayMs === 0) {
      begin();
      return;
    }
    const delay = setTimeout(begin, delayMs);
    delay.unref();
    this.#delays.push(delay);
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
    for (const delay of this.#delays) clearTimeout(delay);
    this.#timers.length = 0;
    this.#delays.length = 0;
  }

  stats(): Record<CycleName, CycleStats> {
    return { fast: this.#metrics.fast.stats(), slow: this.#metrics.slow.stats() };
  }
}

/** The process-wide refresher. */
export const refresher = new Refresher();
