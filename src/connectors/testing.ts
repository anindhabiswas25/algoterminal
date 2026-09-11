import { pino } from 'pino';

import { DEFAULT_BASIS } from '../standardize/types.js';
import type { KpiFact } from '../standardize/schema.js';
import { computeConfidence } from '../standardize/confidence.js';
import type {
  AlgodClient,
  Connector,
  ConnectorCapabilities,
  ConnectorContext,
  HealthProbe,
  HttpClient,
  IndexerClient,
  PriceEntry,
  PriceService,
  PriceTable,
  RawSnapshot,
} from './types.js';

/**
 * Test doubles for the connector interface.
 *
 * This lives in `src/` rather than `test/` deliberately: steps 4-11 all build
 * on it (fixtures, the cache, the refresher, `/ask`'s capability matrix), and a
 * helper the shipped code can import is a helper that stays typed against the
 * real interface instead of drifting into a parallel almost-`Connector`.
 *
 * Nothing here reaches the network, and nothing reads a real clock.
 */

/** The frozen clock every helper defaults to. Matches API_SPEC.md §3.1's example. */
export const FROZEN_NOW = '2026-09-08T14:30:00.000Z';

const silentLog = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Stubbed I/O clients
// ---------------------------------------------------------------------------

/** An {@link HttpClient} that answers from a fixed table and records every call. */
export interface StubHttpClient extends HttpClient {
  /** Every URL requested, in order. Assert on this to prove pagination. */
  readonly calls: string[];
}

/**
 * Unregistered URLs throw rather than returning `null` or `{}`. A connector
 * that fetches something the test did not anticipate should fail loudly in the
 * test, not quietly produce a snapshot missing half its entities.
 */
export function stubHttp(responses: Readonly<Record<string, unknown>> = {}): StubHttpClient {
  const calls: string[] = [];
  return {
    calls,
    async getJson(url: string): Promise<unknown> {
      calls.push(url);
      if (!Object.hasOwn(responses, url)) {
        throw new Error(`stubHttp: no response registered for ${url}`);
      }
      return responses[url];
    },
  };
}

export function stubAlgod(overrides: Partial<AlgodClient> = {}): AlgodClient {
  return {
    baseUrl: 'https://algod.test',
    status: async () => ({ lastRound: 64_845_976 }),
    getApplication: async () => ({ round: 64_845_976, application: {} }),
    // Not opted in, by default. A stub that returned `{}` would let a connector
    // read zeros out of an account that holds no state at all.
    getApplicationLocalState: async () => ({ round: 64_845_976, state: null }),
    // Likewise an absence rather than an empty state: a connector reading a
    // market's deposits out of `{}` would publish a real-looking zero.
    getApplicationGlobalState: async () => ({ round: 64_845_976, state: null }),
    getApplicationBox: async () => ({ round: 64_845_976, value: new Uint8Array() }),
    ...overrides,
  };
}

export function stubIndexer(overrides: Partial<IndexerClient> = {}): IndexerClient {
  return {
    baseUrl: 'https://indexer.test',
    searchTransactions: async () => ({ transactions: [] }),
    // An EMPTY enumeration, not a partial one: a stub that reported `partial`
    // would make every connector built on it look degraded, and one that
    // invented accounts would hide the fixture that was never wired up.
    listAccountsByApplication: async () => ({
      accounts: [],
      currentRound: 64_845_976,
      pages: 1,
      failedPages: 0,
      skipped: 0,
      partial: false,
      urls: [],
    }),
    ...overrides,
  };
}

/** A `PriceTable` from `{ assetId: usd }`, at DATA_SCHEMA.md §3.7 rank-1 confidence. */
export function makePriceTable(
  prices: Readonly<Record<number, number | PriceEntry>>,
  asOf: string = FROZEN_NOW,
): PriceTable {
  const table: Record<number, PriceEntry> = {};
  for (const [id, value] of Object.entries(prices)) {
    table[Number(id)] =
      typeof value === 'number' ? { usd: value, confidence: 1, source: 'stub' } : value;
  }
  return Object.freeze({ asOf, prices: Object.freeze(table) });
}

export function stubPrices(table: PriceTable = makePriceTable({ 0: 0.18, 31566704: 1 })): PriceService {
  return { resolve: async () => table };
}

// ---------------------------------------------------------------------------
// makeContext
// ---------------------------------------------------------------------------

export interface MakeContextOptions {
  /** Frozen clock. A string or Date; `ctx.now()` returns the same instant always. */
  now?: string | Date;
  http?: HttpClient;
  /** Convenience: `{ url: payload }` for the default {@link stubHttp}. */
  httpResponses?: Readonly<Record<string, unknown>>;
  algod?: AlgodClient;
  indexer?: IndexerClient;
  prices?: PriceService;
  priceTable?: PriceTable;
  log?: ConnectorContext['log'];
}

/**
 * A {@link ConnectorContext} with every I/O path stubbed and a frozen clock.
 *
 * `now` is frozen rather than merely injected: CONNECTOR_GUIDE §1 requires the
 * clock to be injected so tests are deterministic, and a clock that advances
 * between two calls inside one `fetchRaw` would put two different `retrieved_at`
 * values in one snapshot's `sources[]`, which no golden file can match.
 */
export function makeContext(options: MakeContextOptions = {}): ConnectorContext {
  const instant = new Date(options.now ?? FROZEN_NOW);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`makeContext: invalid now ${String(options.now)}`);
  }
  return {
    prices: options.prices ?? stubPrices(options.priceTable ?? makePriceTable({ 0: 0.18, 31566704: 1 })),
    algod: options.algod ?? stubAlgod(),
    indexer: options.indexer ?? stubIndexer(),
    http: options.http ?? stubHttp(options.httpResponses ?? {}),
    log: options.log ?? silentLog,
    // A NEW Date each call, so a connector mutating it cannot corrupt the clock,
    // but always the same instant.
    now: () => new Date(instant.getTime()),
  };
}

// ---------------------------------------------------------------------------
// The fake connector
// ---------------------------------------------------------------------------

/** The entity shape the fake connector's snapshots carry. */
export interface FakeEntity {
  readonly id: string;
  readonly tvl_usd: number;
  readonly volume_24h_usd: number;
}

export const FAKE_CAPABILITIES: ConnectorCapabilities = Object.freeze({
  id: 'fake',
  name: 'Fake DEX',
  class: 'dex',
  kpis: Object.freeze(['tvl', 'volume_24h', 'pool_count'] as const),
  sourceHosts: Object.freeze(['api.fake.test']),
  supportsBasis: Object.freeze([DEFAULT_BASIS, 'verified_only'] as const),
});

export const FAKE_ENTITIES: readonly FakeEntity[] = Object.freeze([
  Object.freeze({ id: 'pool-1', tvl_usd: 4_000_000, volume_24h_usd: 1_250_000 }),
  Object.freeze({ id: 'pool-2', tvl_usd: 2_300_000, volume_24h_usd: 410_000 }),
]);

/** A recorded snapshot, suitable as a golden-test input. */
export function makeSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    entities: FAKE_ENTITIES,
    fetchedAt: FROZEN_NOW,
    sources: [
      {
        name: 'fake-api',
        url: 'https://api.fake.test/pools?limit=200&offset=0',
        kind: 'rest',
        retrieved_at: FROZEN_NOW,
      },
    ],
    partial: false,
    excludedCount: 0,
    ...overrides,
  };
}

export interface FakeConnectorOptions {
  /** Shallow-merged over {@link FAKE_CAPABILITIES}. */
  capabilities?: Partial<ConnectorCapabilities>;
  /** Result of `healthCheck`. Defaults to `{ ok: true }`. */
  health?: HealthProbe | (() => Promise<HealthProbe>);
  /** Snapshot `fetchRaw` resolves to. Defaults to {@link makeSnapshot}. */
  snapshot?: RawSnapshot;
}

/**
 * A `Connector` that satisfies the interface without touching the network.
 *
 * `toFacts` is written the way a real one must be: pure, deriving every number
 * from the snapshot alone, taking `timestamp` from `opts.now` and confidence
 * from `computeConfidence` rather than a hardcoded float (§4.4). That makes it
 * a usable subject for the purity and schema-conformance tests, not just a
 * shape that typechecks.
 */
export function makeFakeConnector(options: FakeConnectorOptions = {}): Connector {
  const caps: ConnectorCapabilities = Object.freeze({ ...FAKE_CAPABILITIES, ...options.capabilities });
  const snapshot = options.snapshot ?? makeSnapshot();

  return {
    capabilities: () => caps,

    async fetchRaw(): Promise<RawSnapshot> {
      return snapshot;
    },

    toFacts(snap: RawSnapshot, opts): KpiFact[] {
      const entities = snap.entities as readonly FakeEntity[];
      const requested = new Set(opts.kpis);
      const values: Record<string, { value: number; unit: 'USD' | 'COUNT' }> = {
        tvl: { value: entities.reduce((n, e) => n + e.tvl_usd, 0), unit: 'USD' },
        volume_24h: { value: entities.reduce((n, e) => n + e.volume_24h_usd, 0), unit: 'USD' },
        pool_count: { value: entities.length, unit: 'COUNT' },
      };

      // Declared order, filtered by request — deterministic, so two calls on
      // one snapshot serialize byte-identically.
      return caps.kpis
        .filter((kpi) => requested.has(kpi) && Object.hasOwn(values, kpi))
        .map((kpi): KpiFact => {
          const { value, unit } = values[kpi] as { value: number; unit: 'USD' | 'COUNT' };
          return {
            metric: kpi,
            protocol: caps.id,
            value,
            unit,
            timestamp: opts.now,
            as_of: snap.fetchedAt,
            source: [...snap.sources],
            confidence: computeConfidence({ derivation: { kind: 'reported' }, metric: kpi }),
            is_estimated: false,
            estimation_method: null,
            methodology_version: opts.methodologyVersion,
            cache: 'miss',
            stale: false,
            coverage: { entities: entities.length, excluded: snap.excludedCount, basis: opts.basis },
            notes: [],
          };
        });
    },

    async healthCheck(): Promise<HealthProbe> {
      const health = options.health ?? { ok: true };
      return typeof health === 'function' ? health() : health;
    },
  };
}

/** A one-connector registry, for `/catalog` and `/health` tests. */
export function makeRegistry(...connectors: Connector[]): Map<string, Connector> {
  return new Map(connectors.map((c) => [c.capabilities().id, c]));
}
