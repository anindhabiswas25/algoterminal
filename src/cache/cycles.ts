import { KPI_IDS, ttlSecondsFor, type KpiId } from '../standardize/kpis.js';
import { paramsHash, type FactParams } from './keys.js';

/**
 * The TTL classes that the refresher's two cycles and the read path's fetch
 * grouping both key off (ARCHITECTURE.md §4.6, §6).
 *
 * It lives here, below both, because the read path and the refresher must
 * agree on it. A cold `/metric/tinyman/tvl` fetches the same group the fast
 * cycle refreshes, so the caller's fetch warms exactly what the refresher
 * would have warmed a moment later — and one lock covers both.
 *
 * Membership is derived from the §6 registry TTLs rather than from a list of
 * KPI names: a KPI added with a 120s TTL joins the fast class by definition,
 * and one whose TTL is later relaxed moves on its own.
 */

export type CycleName = 'fast' | 'slow';

/** A KPI at or under this registry TTL belongs to the fast class. */
export const FAST_TTL_THRESHOLD_SECONDS = 300;

export function cycleFor(kpi: KpiId): CycleName {
  return ttlSecondsFor(kpi) <= FAST_TTL_THRESHOLD_SECONDS ? 'fast' : 'slow';
}

/** The KPIs in a class, in §4 registry order. */
export function kpisForCycle(cycle: CycleName): KpiId[] {
  return KPI_IDS.filter((kpi) => cycleFor(kpi) === cycle);
}

/**
 * The identity of one upstream fetch: a protocol, a basis, and a TTL class.
 *
 * ## Why the stampede lock is held on THIS and not on the fact key
 *
 * §4.5 describes a lock "per key", which closes the stampede for one KPI. It
 * does not close the one that actually hurts. A connector's `fetchRaw` is
 * per-protocol, not per-KPI: fetching `tinyman/tvl` enumerates every V2 pool
 * from the chain, and fetching `tinyman/pool_count` enumerates them again.
 * With a per-key lock, a cold start on 11 Tinyman KPIs is 11 *uncontended*
 * locks and 11 concurrent full enumerations — every one of them paying the
 * same ~26 seconds and the same few thousand upstream requests.
 *
 * That was measured, not theorised: a 5-minute soak against live mainnet with
 * per-key locks never finished a single refresh cycle. The fast cycle, which
 * takes 13-14 seconds alone, took 257 seconds while competing with the read
 * path for the same host-concurrency budget, and the hit rate sat at 0.13.
 *
 * Locking the fetch group instead collapses those 11 fetches to 2 — one per
 * TTL class. Losers still wait on their OWN fact key in L1, so a caller that
 * wanted `pool_count` is released the moment the winner's write lands, without
 * either of them needing to know the other exists.
 */
export function fetchGroupId(
  protocol: string,
  params: FactParams,
  cycle: CycleName,
  methodologyVersion: string,
): string {
  return `fetch:v${methodologyVersion}:${protocol}:${cycle}:${paramsHash(params)}`;
}
