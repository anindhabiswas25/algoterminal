import { randomUUID } from 'node:crypto';

import { env } from '../config/env.js';
import type { KpiFact, SuccessFact } from '../standardize/schema.js';
import type { FactKey } from './keys.js';
import { paramsHash } from './keys.js';
import type { CachedFact, L1Store, L2Store, SnapshotRow } from './types.js';

/**
 * In-memory doubles for L1 and L2.
 *
 * In `src/` rather than `test/` for the same reason `connectors/testing.ts`
 * is: the refresher, the snapshotter and later the payment gate all need to
 * drive a cache without a server, and a double the shipped code can import is
 * one that stays typed against the real interface.
 *
 * These are not mocks in the "assert it was called" sense — they are working
 * implementations with a clock and a failure switch, so a test can prove
 * behaviour (exactly one upstream fetch, this TTL on this key, Redis down)
 * rather than prove that a method was invoked.
 */

export interface FakeL1 extends L1Store {
  /** Physical store, exposed so a test can inspect or corrupt an entry. */
  readonly store: Map<string, { entry: CachedFact; physicalExpiryMs: number }>;
  /** The `setRaw`/`getRaw` namespace (the `/ask` result cache). */
  readonly raw: Map<string, { value: string; physicalExpiryMs: number }>;
  /** Every `setRaw`, in order, with the TTL it was written under. */
  readonly rawWrites: Array<{ key: string; ttlSeconds: number }>;
  /** Every `set`, in order, with the TTL it was written under. */
  readonly writes: Array<{ key: string; ttlSeconds: number }>;
  /** Flip to simulate an outage: every operation then behaves as "unavailable". */
  down: boolean;
  /** Advance/override the double's clock. Defaults to `Date.now`. */
  now: () => number;
  readonly locks: Map<string, { token: string; expiresAtMs: number }>;
}

export function fakeL1(now: () => number = Date.now): FakeL1 {
  const store = new Map<string, { entry: CachedFact; physicalExpiryMs: number }>();
  const locks = new Map<string, { token: string; expiresAtMs: number }>();
  const writes: Array<{ key: string; ttlSeconds: number }> = [];
  const raw = new Map<string, { value: string; physicalExpiryMs: number }>();
  const rawWrites: Array<{ key: string; ttlSeconds: number }> = [];

  const self: FakeL1 = {
    store,
    locks,
    writes,
    raw,
    rawWrites,
    down: false,
    now,

    async get(key) {
      // Down means "not cached", never an exception — the real client swallows
      // its errors, and a double that threw would let a test pass against
      // behaviour production does not have.
      if (self.down) return null;
      const held = store.get(key);
      if (held === undefined) return null;
      if (self.now() >= held.physicalExpiryMs) {
        store.delete(key);
        return null;
      }
      // Round-tripped through JSON like the real store, so a test cannot rely
      // on object identity that Redis would not preserve.
      return JSON.parse(JSON.stringify(held.entry)) as CachedFact;
    },

    async getRaw(key) {
      if (self.down) return null;
      const held = raw.get(key);
      if (held === undefined) return null;
      if (self.now() >= held.physicalExpiryMs) {
        raw.delete(key);
        return null;
      }
      return held.value;
    },

    async setRaw(key, value, ttlSeconds) {
      if (self.down) return;
      rawWrites.push({ key, ttlSeconds });
      // No stale-grace window here, matching the real client: the /ask cache
      // has no stale-while-revalidate path.
      raw.set(key, { value, physicalExpiryMs: self.now() + ttlSeconds * 1_000 });
    },

    async set(key, entry) {
      if (self.down) return;
      writes.push({ key, ttlSeconds: entry.ttlSeconds });
      // Mirrors STALE_GRACE_SECONDS: the physical key outlives its logical
      // freshness, which is what makes stale-while-revalidate observable.
      store.set(key, {
        entry,
        physicalExpiryMs: entry.expiresAt + 3_600 * 1_000,
      });
    },

    async acquireLock(key, ttlMs) {
      if (self.down) return null;
      const held = locks.get(key);
      if (held !== undefined && self.now() < held.expiresAtMs) return null;
      const token = randomUUID();
      locks.set(key, { token, expiresAtMs: self.now() + ttlMs });
      return token;
    },

    async releaseLock(key, token) {
      if (self.down) return;
      if (locks.get(key)?.token === token) locks.delete(key);
    },

    status: () => (self.down ? 'down' : 'ok'),
    close: async () => void store.clear(),
  };

  return self;
}

export interface FakeL2 extends L2Store {
  /** Every row ever written, newest last, keyed by identity. */
  readonly rows: Map<string, SnapshotRow[]>;
  /** Seed a last-known-good snapshot directly. */
  seed(key: FactKey, fact: SuccessFact, asOf?: string): void;
  down: boolean;
}

export function fakeL2(): FakeL2 {
  const rows = new Map<string, SnapshotRow[]>();
  const id = (key: FactKey): string =>
    `${key.protocol}:${key.kpi}:${paramsHash(key.params)}`;

  const self: FakeL2 = {
    rows,
    down: false,

    seed(key, fact, asOf = fact.as_of) {
      const list = rows.get(id(key)) ?? [];
      list.push({ fact, asOf });
      rows.set(id(key), list);
    },

    async latest(key) {
      if (self.down) return null;
      const list = rows.get(id(key));
      if (list === undefined || list.length === 0) return null;
      return [...list].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)).at(-1) ?? null;
    },

    async write(entries) {
      if (self.down) return 0;
      let written = 0;
      for (const entry of entries) {
        if (entry.fact.value === null) continue;
        const key = entry.key;
        const list = rows.get(id(key)) ?? [];
        const asOf = entry.fact.as_of ?? entry.fact.timestamp;
        // Mirrors ON CONFLICT DO NOTHING on (protocol, metric, params_hash, as_of).
        if (list.some((row) => row.asOf === asOf)) continue;
        list.push({ fact: entry.fact as SuccessFact, asOf });
        rows.set(id(key), list);
        written += 1;
      }
      return written;
    },
  };

  return self;
}

/**
 * A minimal valid `SuccessFact`, for tests that care about cache behaviour
 * rather than about accounting.
 *
 * Built to pass `KpiFactSchema` as-is: every §2 provenance field a fact with a
 * value must carry is present, so a test that accidentally strips one fails in
 * the validator rather than silently caching an invalid fact.
 */
export function testFact(overrides: Partial<KpiFact> = {}): SuccessFact {
  return {
    metric: 'tvl',
    protocol: 'tinyman',
    value: 5_400_000,
    unit: 'USD',
    timestamp: '2026-09-09T12:00:00.000Z',
    as_of: '2026-09-09T12:00:00.000Z',
    confidence: 0.7,
    // The CONFIGURED version, not a literal. L2's read predicate pins
    // `env.METHODOLOGY_VERSION` (`src/cache/snapshots.ts`), so a fixture that
    // stamped a fixed version would write rows the real read path cannot see —
    // and would start doing so silently on the next methodology bump.
    methodology_version: env.METHODOLOGY_VERSION,
    source: [
      {
        name: 'algod',
        url: 'https://mainnet-api.4160.nodely.dev/v2/applications/1002541853',
        kind: 'onchain',
        retrieved_at: '2026-09-09T12:00:00.000Z',
        app_id: 1_002_541_853,
        round: 64_845_976,
      },
    ],
    is_estimated: false,
    estimation_method: null,
    cache: 'miss',
    stale: false,
    coverage: { entities: 6_883, excluded: 12, basis: 'all_pools_usd_priced' },
    notes: [],
    ...overrides,
  } as SuccessFact;
}
