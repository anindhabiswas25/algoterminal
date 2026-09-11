import { env } from '../config/env.js';
import { connectorContext } from '../connectors/context.js';
import { computeFacts, UnknownProtocolError } from '../facts/compute.js';
import { logger } from '../logger.js';
import { applyServePenalty } from '../standardize/confidence.js';
import { ttlSecondsFor, type KpiId } from '../standardize/kpis.js';
import {
  makeErrorFact,
  type CacheState,
  type KpiFact,
  type SuccessFact,
} from '../standardize/schema.js';
import { cycleFor, fetchGroupId, kpisForCycle } from './cycles.js';
import { hotSet, type HotSet } from './hotset.js';
import { cacheMetrics, type CacheMetrics } from './metrics.js';
import { cacheKey, type FactKey, type FactParams } from './keys.js';
import { l0 as sharedL0, type L0Cache } from './lru.js';
import { l1 as sharedL1 } from './redis.js';
import { CACHE_NOTE_PREFIX, l2 as sharedL2 } from './snapshots.js';
import { isExpired, type CachedFact, type L1Store, type L2Store } from './types.js';

/**
 * The read-through cache — ARCHITECTURE.md §4.5.
 *
 * §4.5 opens with the sentence this file is built around: *the cache is not an
 * optimization, it is the business model.* A `/metric` call sells for $0.005.
 * A cold Tinyman fetch measured at ~65 seconds and costs a few hundred
 * upstream requests. There is no price at which the second thing pays for the
 * first, so the paid path must essentially never do it, and when it must, it
 * must still answer — labelled — rather than time out.
 *
 * Four outcomes, and every one of them is labelled on the fact:
 *
 * | Path | `cache` | `stale` | confidence |
 * |---|---|---|---|
 * | L0 or fresh L1 | `hit` | false | as computed |
 * | Expired L1, served while revalidating | `stale` | true | × 0.90 (§5 `stale_l1`) |
 * | Full miss, we fetched | `miss` | false | as computed |
 * | L2 last-known-good | `stale` | true | × 0.70, floored at 0.40 (§5 `l2_snapshot`) |
 *
 * A caller can therefore always tell what it got — DATA_SCHEMA.md §1: a stale
 * number must never masquerade as a fresh one, and freshness is part of the
 * response contract rather than something in our logs.
 */

const log = logger.child({ component: 'cache' });

/** §4.5 — how long a stampede loser waits for the winner's write. */
export const LOCK_WAIT_MS = 2_000;
/** How often a loser re-checks L1 while waiting. */
export const LOCK_POLL_MS = 50;
/**
 * Lock lifetime. Comfortably longer than the ~65s worst-case full fetch, so a
 * winner that is merely slow does not have its lock expire underneath it and
 * let a second fetch start; short enough that a winner which crashed outright
 * does not wedge the key for minutes.
 */
export const LOCK_TTL_MS = 90_000;

export interface CacheDeps {
  readonly l0: L0Cache;
  readonly l1: L1Store;
  readonly l2: L2Store;
  readonly metrics: CacheMetrics;
  readonly hot: HotSet;
  readonly now: () => number;
  /** The upstream pipeline. Injected so tests can count fetches exactly. */
  readonly compute: (req: {
    protocol: string;
    kpis: readonly KpiId[];
    params: FactParams;
  }) => Promise<SuccessFact[]>;
  readonly methodologyVersion: string;
}

/**
 * Production wiring. A function rather than a constant so that nothing is
 * constructed — no Redis socket, no Postgres pool — until a fact is actually
 * requested.
 */
export function defaultDeps(): CacheDeps {
  return {
    l0: sharedL0,
    l1: sharedL1(),
    l2: sharedL2(),
    metrics: cacheMetrics,
    hot: hotSet,
    now: Date.now,
    compute: (req) => computeFacts({ ...req, kpis: [...req.kpis] }, connectorContext()),
    methodologyVersion: env.METHODOLOGY_VERSION,
  };
}

let deps: CacheDeps | null = null;

export function cacheDeps(): CacheDeps {
  return (deps ??= defaultDeps());
}

/**
 * Replace the process-wide deps. Returns a function that restores what was
 * there before.
 *
 * The read path is reached through a module singleton, so a route handler
 * cannot be handed a cache by its caller. Rather than mock the module, a test
 * swaps the tier doubles from `cache/testing.ts` in here — the same objects
 * production wires, typed against the same interfaces — so what the test
 * exercises is the real `getFact`, not a stand-in for it.
 */
export function setCacheDeps(next: CacheDeps): () => void {
  const previous = deps;
  deps = next;
  return () => {
    deps = previous;
  };
}

export interface GetFactOptions {
  /**
   * `?fresh=true` (§6): bypass L0 and L1 and fetch, at a higher price. It does
   * NOT bypass the stampede lock — "I want a fresh number" is a request for
   * current data, never a licence for fifty callers to hammer an upstream in
   * parallel, and the lock is what keeps that promise. A `fresh` loser waits
   * for the winner's brand-new write, which is exactly the number it asked for.
   */
  readonly fresh?: boolean;
  /**
   * The KPIs to fetch alongside this one on a miss.
   *
   * Defaults to the whole TTL class this KPI belongs to, NOT to the single
   * KPI asked for. One `fetchRaw` produces the entire family, so fetching one
   * KPI and discarding its siblings means the next caller pays the same 26
   * seconds over again for a number we already had in hand. Filling the class
   * makes a cold `/metric/tinyman/tvl` warm exactly what the fast cycle would
   * have warmed, which is why the two share a lock.
   *
   * The class, not everything: a fast-cycle miss must not drag in the per-pool
   * flow lookups that take a TVL fetch from 13 seconds to 65.
   */
  readonly alsoFetch?: readonly KpiId[];
}

/**
 * Read one fact through the tiers.
 *
 * Never throws. Every failure mode ends in either a labelled stale fact or a
 * §2 error fact, because this sits behind a payment gate: an exception here is
 * a 5xx, and a 5xx means the caller is not charged (§5.2) for a question we
 * could often still have answered from L2.
 */
export async function getFact(
  key: FactKey,
  opts: GetFactOptions = {},
  d: CacheDeps = cacheDeps(),
): Promise<KpiFact> {
  d.hot.record(key);
  const redisKey = cacheKey(key, d.methodologyVersion);
  const nowMs = d.now();

  if (opts.fresh !== true) {
    // ---- L0 ---------------------------------------------------------------
    const local = d.l0.get(redisKey);
    if (local !== undefined && !isExpired(local, nowMs)) {
      d.metrics.record('hit');
      return stampFresh(local.fact, 'hit');
    }

    // ---- L1 ---------------------------------------------------------------
    const remote = await d.l1.get(redisKey);
    if (remote !== null) {
      if (!isExpired(remote, nowMs)) {
        d.l0.set(redisKey, remote);
        d.metrics.record('hit');
        return stampFresh(remote.fact, 'hit');
      }

      // ---- Stale-while-revalidate (§4.5) ----------------------------------
      // Return the expired entry NOW and refresh behind the response. The
      // alternative — making this caller wait out a 65-second fetch for a
      // number that was correct 40 seconds ago — is a timeout dressed up as
      // accuracy, and an agent on a 250ms budget cannot use it.
      void revalidate(key, redisKey, opts, d);
      d.metrics.record('stale');
      return stampStale(remote, nowMs);
    }
  }

  // ---- Full miss: one fetch, many waiters (§4.5) --------------------------
  // The lock is held on the FETCH GROUP, not on this one key: `fetchRaw` is
  // per-protocol, so eleven cold KPIs must be one enumeration and not eleven.
  // See `cycles.ts` for the measurement behind that.
  const kpis = opts.alsoFetch ?? kpisForCycle(cycleFor(key.kpi));
  const group = fetchGroupId(key.protocol, key.params, cycleFor(key.kpi), d.methodologyVersion);
  const token = await d.l1.acquireLock(group, LOCK_TTL_MS);

  if (token === null) {
    // Redis down is not contention: there is no winner to wait for, and no L1
    // for one to write to. Waiting the full 2s would add it to every single
    // request for the duration of the outage — a self-inflicted latency floor
    // on the path the cache exists to keep fast.
    if (d.l1.status() === 'down') {
      return fallbackToL2(key, d, 'redis unavailable');
    }

    // We lost. Someone else is fetching; wait for their write rather than
    // starting a second one. 50 concurrent bots on a cold key must produce ONE
    // upstream fetch, not 50 — the second outcome is a rate-limit ban from a
    // source we depend on (8 unpaced concurrent requests already earn a 429
    // with Retry-After: 18).
    const won = await waitForWrite(redisKey, d);
    if (won !== null) {
      d.l0.set(redisKey, won);
      d.metrics.record('hit');
      return stampFresh(won.fact, 'hit');
    }
    return fallbackToL2(key, d, 'lock wait timed out');
  }

  try {
    const facts = await d.compute({ protocol: key.protocol, kpis, params: key.params });
    await writeFacts(key.protocol, key.params, facts, d);

    const wanted = facts.find((f) => f.metric === key.kpi);
    if (wanted === undefined) {
      // The connector produced nothing for this KPI. That is a real answer —
      // §2 forbids inventing a zero — but it is not a cacheable one, so L2 is
      // consulted before giving up.
      return fallbackToL2(key, d, 'connector produced no fact for this KPI');
    }

    d.metrics.record('miss');
    return stampFresh(wanted, 'miss');
  } catch (err) {
    if (err instanceof UnknownProtocolError) {
      d.metrics.record('miss');
      return errorFact(key, 'PROTOCOL_NOT_FOUND', err.message, d);
    }
    log.warn({ err, key: redisKey }, 'upstream fetch failed; trying L2');
    return fallbackToL2(key, d, 'upstream fetch failed');
  } finally {
    await d.l1.releaseLock(group, token);
  }
}

/**
 * Write a batch of freshly computed facts, each under its OWN registry TTL.
 *
 * This is the reason the §6 TTL table can be per-KPI at all. One `fetchRaw`
 * produces `tvl` (300s), `volume_24h` (600s) and `active_users_24h` (900s) in
 * the same breath; storing them under one entry would force one TTL on all
 * three, and whichever was chosen would be wrong for the other two — either
 * paying upstream every 5 minutes for a number that moves every 15, or serving
 * a 15-minute-old TVL to a rebalancing agent.
 */
export async function writeFacts(
  protocol: string,
  params: FactParams,
  facts: readonly SuccessFact[],
  d: CacheDeps = cacheDeps(),
): Promise<void> {
  const storedAt = d.now();
  await Promise.all(
    facts.map(async (fact) => {
      const ttlSeconds = ttlSecondsFor(fact.metric);
      const entry: CachedFact = {
        fact,
        storedAt,
        expiresAt: storedAt + ttlSeconds * 1_000,
        ttlSeconds,
      };
      const redisKey = cacheKey({ protocol, kpi: fact.metric, params }, d.methodologyVersion);
      d.l0.set(redisKey, entry);
      await d.l1.set(redisKey, entry);
    }),
  );
}

// ---------------------------------------------------------------------------
// Serve-time labelling
// ---------------------------------------------------------------------------

/** A fresh serve: the stored fact, with only its `cache` state changed. */
function stampFresh(fact: SuccessFact, state: CacheState): KpiFact {
  return { ...fact, cache: state, stale: false };
}

/**
 * A stale-from-L1 serve (§4.5, §5 `stale_l1`).
 *
 * `as_of` is left as the stored fact's: it already says what moment the DATA
 * describes, which is the whole question a caller asks of a stale number. The
 * age goes in `notes`, where it is precise and unambiguous, rather than being
 * folded into a timestamp field that means something else.
 */
function stampStale(entry: CachedFact, nowMs: number): KpiFact {
  const ageSeconds = Math.round((nowMs - entry.storedAt) / 1_000);
  return {
    ...entry.fact,
    cache: 'stale',
    stale: true,
    confidence: applyServePenalty(entry.fact.confidence, 'stale_l1', entry.fact.metric),
    notes: [
      ...(entry.fact.notes ?? []),
      `${CACHE_NOTE_PREFIX} served from L1 ${ageSeconds}s after computation, past this KPI's ` +
        `${entry.ttlSeconds}s TTL (ARCHITECTURE.md §6). A refresh was triggered; confidence ` +
        `carries the §5 stale_l1 penalty (x0.90).`,
    ],
  };
}

/**
 * An L2 last-known-good serve (§4.5).
 *
 * `as_of` IS overwritten here, unlike the stale-L1 case: the row's `as_of` is
 * the snapshot time, which is the only honest answer to "when was this true?"
 * for a number that may be hours old. §4.5 requires exactly this — "`as_of`
 * set to the snapshot time" — and it is what stops an outage from being
 * invisible to a caller reading only the envelope.
 */
async function fallbackToL2(key: FactKey, d: CacheDeps, reason: string): Promise<KpiFact> {
  const row = await d.l2.latest(key);
  if (row === null) {
    d.metrics.record('miss');
    return errorFact(
      key,
      'UPSTREAM_UNAVAILABLE',
      `Could not compute ${key.protocol}/${key.kpi} (${reason}) and no last-known-good snapshot exists.`,
      d,
    );
  }

  d.metrics.record('stale');
  const ageSeconds = Math.max(0, Math.round((d.now() - Date.parse(row.asOf)) / 1_000));
  return {
    ...row.fact,
    as_of: row.asOf,
    cache: 'stale',
    stale: true,
    confidence: applyServePenalty(row.fact.confidence, 'l2_snapshot', row.fact.metric),
    notes: [
      ...(row.fact.notes ?? []),
      `${CACHE_NOTE_PREFIX} served from the L2 last-known-good snapshot taken ${ageSeconds}s ago ` +
        `(${reason}). as_of is the snapshot time, not now; confidence carries the §5 l2_snapshot ` +
        `penalty (x0.70) and its 0.40 floor.`,
    ],
  };
}

function errorFact(key: FactKey, code: string, message: string, d: CacheDeps): KpiFact {
  return makeErrorFact({
    metric: key.kpi,
    protocol: key.protocol,
    code,
    message,
    methodologyVersion: d.methodologyVersion,
    timestamp: new Date(d.now()).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Stampede protection
// ---------------------------------------------------------------------------

/**
 * Poll L1 for up to {@link LOCK_WAIT_MS} waiting for the lock winner's write.
 *
 * Polling rather than pub/sub deliberately: the wait is bounded at 2 seconds
 * and the poll costs one Redis GET every 50ms, which is nothing next to the
 * upstream fetch being avoided. A subscription would add a second connection
 * per instance and a delivery-guarantee question, to save ~40 GETs.
 *
 * The returned entry is checked for freshness. A winner whose fetch failed
 * leaves the old expired entry in place; treating that as "the write arrived"
 * would serve a stale number as a fresh one.
 */
async function waitForWrite(redisKey: string, d: CacheDeps): Promise<CachedFact | null> {
  const deadline = d.now() + LOCK_WAIT_MS;
  while (d.now() < deadline) {
    await sleep(LOCK_POLL_MS);
    const entry = await d.l1.get(redisKey);
    if (entry !== null && !isExpired(entry, d.now())) return entry;
  }
  return null;
}

/**
 * Refresh an expired entry behind an already-sent response.
 *
 * Lock-guarded like any other fetch: stale-while-revalidate on a hot key would
 * otherwise mean every request during the refresh window starts its own
 * revalidation, which is the stampede again with an extra step. Only the lock
 * winner refreshes; everyone else keeps being served the stale entry, which is
 * the correct outcome.
 *
 * Failures are logged and swallowed. The caller already has its answer; a
 * rejected background promise would be an unhandled rejection over a request
 * that succeeded.
 */
async function revalidate(
  key: FactKey,
  redisKey: string,
  opts: GetFactOptions,
  d: CacheDeps,
): Promise<void> {
  const group = fetchGroupId(key.protocol, key.params, cycleFor(key.kpi), d.methodologyVersion);
  const token = await d.l1.acquireLock(group, LOCK_TTL_MS);
  if (token === null) return;
  try {
    const facts = await d.compute({
      protocol: key.protocol,
      kpis: opts.alsoFetch ?? kpisForCycle(cycleFor(key.kpi)),
      params: key.params,
    });
    await writeFacts(key.protocol, key.params, facts, d);
  } catch (err) {
    log.warn({ err, key: redisKey }, 'background revalidation failed; the stale entry stands');
  } finally {
    await d.l1.releaseLock(group, token);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** The `cache` block of `/health` (API_SPEC.md §3.5). */
export function cacheHealth(d: CacheDeps = cacheDeps()) {
  const stats = d.metrics.stats(d.l0.size);
  return {
    hit_rate_1h: stats.hitRate1h,
    lookups_1h: stats.lookups1h,
    redis: d.l1.status(),
    l0_entries: stats.l0Size,
  };
}

export type { FactKey, FactParams };
