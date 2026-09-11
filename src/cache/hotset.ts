import { listConnectors } from '../connectors/registry.js';
import { producibleKpis } from '../facts/compute.js';
import type { KpiId } from '../standardize/kpis.js';
import { DEFAULT_PARAMS, describeKey, type FactKey, type FactParams } from './keys.js';

/**
 * The refresher's hot set (ARCHITECTURE.md §4.6): every `(protocol, kpi)`
 * requested in the last 6 hours, plus the full matrix for registered
 * connectors.
 *
 * ## Why both halves are needed
 *
 * The **full matrix** is what makes the 70% hit rate a floor rather than a
 * hope: it guarantees the first caller of the minute finds a warm entry for
 * anything we advertise on `/catalog`, whether or not anyone asked yesterday.
 * With three launch protocols it is ~40 facts — a handful of upstream calls
 * per cycle, well inside every source's tolerance.
 *
 * The **recency half** is not redundant with it, because a fact's identity
 * includes its parameters. The matrix covers the default basis; a bot that
 * calls `?basis=verified_only` all day is asking for a different number under
 * a different key, and without recency tracking that key is cold on every
 * single call. Tracking what was actually requested is what keeps a caller's
 * chosen basis warm without pre-warming the cross product of every basis with
 * every KPI, most of which nobody ever asks for.
 *
 * Recency lives in memory, not Redis. It is a hint about what to refresh, and
 * the cost of losing it on restart is that the matrix carries the load for six
 * hours — whereas a shared hot set would need its own eviction policy and
 * would let one instance's traffic pattern drive another's refresh budget.
 */

/** §4.6 — "requested in the last 6 hours". */
export const HOT_WINDOW_MS = 6 * 60 * 60 * 1_000;

/** A hot-set entry, keyed by its `describeKey` identity. */
interface Entry {
  readonly key: FactKey;
  lastRequestedAt: number;
}

export class HotSet {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = HOT_WINDOW_MS,
  ) {}

  /** Called on every read-path lookup, hit or miss. */
  record(key: FactKey): void {
    const id = describeKey(key);
    const existing = this.#entries.get(id);
    if (existing !== undefined) {
      existing.lastRequestedAt = this.now();
      return;
    }
    this.#entries.set(id, { key, lastRequestedAt: this.now() });
  }

  /** Recently-requested identities, oldest entries dropped. */
  recent(): FactKey[] {
    const cutoff = this.now() - this.windowMs;
    const live: FactKey[] = [];
    for (const [id, entry] of this.#entries) {
      if (entry.lastRequestedAt < cutoff) this.#entries.delete(id);
      else live.push(entry.key);
    }
    return live;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

export const hotSet = new HotSet();

/**
 * The full matrix: every registered connector × every KPI it can produce, at
 * the default basis.
 *
 * The default basis only. Pre-warming every basis would multiply the refresh
 * cost by `BASES.length` for parameter combinations nobody has asked for —
 * those arrive through the recency half, on their first (cold) call, and are
 * warm from then on.
 */
export function fullMatrix(params: FactParams = DEFAULT_PARAMS): FactKey[] {
  const keys: FactKey[] = [];
  for (const connector of listConnectors()) {
    const protocol = connector.capabilities().id;
    for (const kpi of producibleKpis(connector)) keys.push({ protocol, kpi, params });
  }
  return keys;
}

/**
 * The hot set: the matrix plus recent requests, deduplicated.
 *
 * Deduplication is by `describeKey`, the same identity the cache key is built
 * from, so a recent request for a fact already in the matrix does not cause it
 * to be refreshed twice in one cycle.
 */
export function hotKeys(set: HotSet = hotSet): FactKey[] {
  const byId = new Map<string, FactKey>();
  for (const key of fullMatrix()) byId.set(describeKey(key), key);
  for (const key of set.recent()) byId.set(describeKey(key), key);
  return [...byId.values()];
}

/** Group hot keys by `(protocol, basis)`, which is the unit of one `fetchRaw`. */
export function groupByFetch(keys: readonly FactKey[]): Array<{
  protocol: string;
  params: FactParams;
  kpis: KpiId[];
}> {
  const groups = new Map<string, { protocol: string; params: FactParams; kpis: KpiId[] }>();
  for (const key of keys) {
    const id = `${key.protocol}?basis=${key.params.basis}`;
    const group = groups.get(id) ?? { protocol: key.protocol, params: key.params, kpis: [] };
    if (!group.kpis.includes(key.kpi)) group.kpis.push(key.kpi);
    groups.set(id, group);
  }
  return [...groups.values()];
}
