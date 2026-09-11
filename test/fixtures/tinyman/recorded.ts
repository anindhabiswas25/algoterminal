import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  TinymanPoolSchema,
  type TinymanPool,
} from '../../../src/connectors/tinyman/schema.js';
import {
  POOL_PAGE_LIMIT,
  poolByAddressUrl,
  poolPageUrl,
} from '../../../src/connectors/tinyman/enumerate.js';
import { V2_VALIDATOR_APP_ID } from '../../../src/connectors/tinyman/index.js';
import { accountsByApplicationUrl } from '../../../src/connectors/indexer.js';
import { decodeAppState } from '../../../src/connectors/algod.js';
import { makeContext, stubPrices, FROZEN_NOW } from '../../../src/connectors/testing.js';
import type {
  AlgodClient,
  ConnectorContext,
  HttpClient,
  IndexerAccountState,
  IndexerClient,
  PriceTable,
} from '../../../src/connectors/types.js';

/**
 * The recorded Tinyman fixtures (CONNECTOR_GUIDE.md §Step 6), and a
 * `ConnectorContext` that replays them at the exact URLs `fetchRaw` requests.
 *
 * Every byte here came off the live API:
 *
 * | file | how |
 * |---|---|
 * | `pools-page-{1,2}.json` | `curl '.../api/v1/pools/?limit=50[&offset=50]'`, verbatim (2026-09-08) |
 * | `v2-accounts.json` | verbatim indexer account records for a representative subset of V2 pool accounts, assembled into pages (2026-09-09) |
 * | `assets.json` | verbatim `/api/v1/assets/?ids=` records — the reserve → whole-unit decimals |
 * | `v2-flows.json` | verbatim `GET /api/v1/pools/{address}/` for the pools clearing §3.6 — the 24h flows |
 * | `prices.json` | a real `PriceTable` from the §3.7 ladder (`scripts/record-tinyman-fixtures.ts`) |
 * | `active-users.json` | a real §4.1 indexer scan, projected onto the two fields the scan reads |
 *
 * Two things the harness synthesises, both of them envelopes rather than data:
 *
 *  1. **The V1.1 paging envelope.** The recorded pages are 50 rows each while
 *     `fetchV11Pools` walks in strides of `POOL_PAGE_LIMIT`, so the two verbatim
 *     row arrays are re-served at offsets 0 and `POOL_PAGE_LIMIT` under a
 *     `count` that makes the walk visit both.
 *  2. **The `/assets/?ids=` chunking.** The connector chunks whichever ids it
 *     does not already know from a V1.1 record, so the exact request URLs are
 *     not knowable when the fixture is recorded. The stub therefore answers
 *     that endpoint by *parsing the ids out of the URL* and returning the
 *     recorded record for each — which is what the live endpoint does, and
 *     keeps the fixture from encoding today's chunk boundaries as a contract.
 *
 * Everything else is served by exact URL, and an unregistered URL throws: an
 * unanticipated fetch must fail the test, not quietly shrink the snapshot.
 */

const DIR = path.dirname(new URL(import.meta.url).pathname);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as T;
}

interface RecordedPage {
  count: number;
  next: string | null;
  results: unknown[];
}

interface RecordedAccountPage {
  accounts: Array<{
    address: string;
    round?: number;
    deleted?: boolean;
    'apps-local-state'?: Array<{
      id: number;
      deleted?: boolean;
      'key-value'?: Array<{ key: string; value: { type: number; bytes?: string; uint?: number } }>;
    }>;
  }>;
  'current-round': number;
  'next-token'?: string;
}

export interface RecordedActiveUsers {
  requested: { minRound: number; maxRound: number };
  pages: Record<string, Array<Array<{ sender: string; 'confirmed-round': number }>>>;
}

export const page1 = (): RecordedPage => readJson<RecordedPage>('pools-page-1.json');
export const page2 = (): RecordedPage => readJson<RecordedPage>('pools-page-2.json');
export const v2Accounts = (): { pages: RecordedAccountPage[] } => readJson('v2-accounts.json');
export const assetRecords = (): Record<string, { id: string; decimals: number }> =>
  readJson('assets.json');
export const v2Flows = (): Record<string, unknown> => readJson('v2-flows.json');
export const activeUsers = (): RecordedActiveUsers => readJson('active-users.json');
export const prices = (): PriceTable => readJson<PriceTable>('prices.json');

/** Every recorded V1.1 pool record, parsed. */
export function loadRecordedPools(): TinymanPool[] {
  return [...page1().results, ...page2().results].map((row) => TinymanPoolSchema.parse(row));
}

/**
 * `count` is set so `fetchV11Pools` visits offset 0 and then one more page and
 * stops. It is the only value in the harness that is not the server's own.
 */
const HARNESS_COUNT = POOL_PAGE_LIMIT + 1;

export interface FixtureContextOptions {
  /** Drop this many rows off the end of page 1, for the degradation test. */
  truncatePage1?: number;
  /** Serve the second V1.1 page as a hard failure, for the degradation test. */
  failPage2?: boolean;
  /** Make the V2 account walk fail on its second page, for the same. */
  failAccountPage2?: boolean;
  /** Serve every per-pool flow lookup as a failure. */
  failFlows?: boolean;
  /** Replay the recorded §4.1 indexer scan. Off by default: it is the slow path. */
  withIndexer?: boolean;
}

/** The §3.7 rank-5 case: an asset the recorded price table does not carry. */
export function withoutAsset(table: PriceTable, assetId: number): PriceTable {
  const entries = { ...table.prices };
  delete (entries as Record<number, unknown>)[assetId];
  return { asOf: table.asOf, prices: entries };
}

/**
 * A `ConnectorContext` serving the recorded fixtures — frozen clock, no
 * network, and an `http` that throws on any URL the fixtures do not cover.
 */
export function makeFixtureContext(options: FixtureContextOptions = {}): ConnectorContext {
  const p1 = page1();
  const p2 = page2();
  const results1 =
    options.truncatePage1 === undefined
      ? p1.results
      : p1.results.slice(0, Math.max(0, p1.results.length - options.truncatePage1));

  const exact: Record<string, unknown> = {
    [poolPageUrl(0)]: { count: HARNESS_COUNT, next: null, results: results1 },
    [poolPageUrl(0, 1)]: { count: HARNESS_COUNT, next: null, results: results1.slice(0, 1) },
  };
  if (!options.failPage2) {
    exact[poolPageUrl(POOL_PAGE_LIMIT)] = {
      count: HARNESS_COUNT,
      next: null,
      results: p2.results,
    };
  }
  if (!options.failFlows) {
    for (const [address, record] of Object.entries(v2Flows())) {
      exact[poolByAddressUrl(address)] = record;
    }
  }

  const assets = assetRecords();
  const calls: string[] = [];
  const http: HttpClient & { calls: string[] } = {
    calls,
    async getJson(url: string): Promise<unknown> {
      calls.push(url);
      if (Object.hasOwn(exact, url)) return exact[url];
      // See the header, note 2: the assets endpoint is answered by id.
      const ids = /\/assets\/\?ids=([\d,]+)/.exec(url)?.[1];
      if (ids !== undefined) {
        return {
          count: 0,
          next: null,
          results: ids
            .split(',')
            .map((id) => assets[id])
            .filter((record) => record !== undefined),
        };
      }
      throw new Error(`fixture: no response registered for ${url}`);
    },
  };

  const recordedAccounts = v2Accounts();
  const indexer: IndexerClient = {
    baseUrl: 'https://mainnet-idx.4160.nodely.dev',

    async searchTransactions({ applicationId, next }) {
      if (options.withIndexer !== true) throw new Error('fixture: indexer replay not enabled');
      const pages = activeUsers().pages[String(applicationId)] ?? [];
      const index = next === undefined ? 0 : Number(next);
      const page = pages[index] ?? [];
      return index + 1 < pages.length
        ? { transactions: page, nextToken: String(index + 1) }
        : { transactions: page };
    },

    // The real client's paging, decoding and skip-counting run over the
    // recorded pages; only the transport is stubbed. A fixture that returned
    // an already-assembled account list would leave the one method this step
    // added — the walk itself — untested.
    async listAccountsByApplication(appId) {
      const accounts: IndexerAccountState[] = [];
      const urls: string[] = [];
      let skipped = 0;
      let failedPages = 0;
      let pages = 0;
      let currentRound = 0;

      for (const [index, page] of recordedAccounts.pages.entries()) {
        urls.push(accountsByApplicationUrl(this.baseUrl, appId, index === 0 ? undefined : String(index)));
        if (options.failAccountPage2 === true && index === 1) {
          failedPages++;
          break;
        }
        pages++;
        currentRound = page['current-round'];
        for (const account of page.accounts) {
          const local = account['apps-local-state']?.find(
            (s) => s.id === appId && s.deleted !== true,
          );
          if (account.deleted === true || local === undefined) {
            skipped++;
            continue;
          }
          accounts.push({
            address: account.address,
            round: account.round ?? page['current-round'],
            // Re-encoded through the production decoder so the fixture path
            // and the live path agree on how base64 becomes AppState.
            state: decodeAppState(
              (local['key-value'] ?? []).map((kv) => ({
                key: kv.key,
                value: { type: kv.value.type, bytes: kv.value.bytes ?? '', uint: kv.value.uint ?? 0 },
              })),
            ),
          });
        }
      }

      return { accounts, currentRound, pages, failedPages, skipped, partial: failedPages > 0, urls };
    },
  };

  const algod: AlgodClient = {
    baseUrl: 'https://mainnet-api.4160.nodely.dev',
    status: async () => ({ lastRound: activeUsers().requested.maxRound }),
    getApplication: async () => ({ round: 0, application: {} }),
    getApplicationBox: async () => ({ round: 0, value: new Uint8Array() }),
    // No longer on any Tinyman path: since 1.1.0 the V2 fee parameters arrive
    // with the indexer enumeration. It throws so a regression that reintroduces
    // 17,119 per-pool algod reads fails the suite rather than merely slowing it.
    getApplicationLocalState: async () => {
      throw new Error(
        `fixture: the §3.3 enumeration must not read per-pool local state from algod (app ${V2_VALIDATOR_APP_ID})`,
      );
    },
    // Tinyman reads no application GLOBAL state either: a V2 pool's parameters
    // live in the pool ACCOUNT's local state under the validator app, and since
    // 1.1.0 they arrive with the indexer enumeration.
    getApplicationGlobalState: async () => {
      throw new Error('fixture: the §3.3 enumeration reads no application global state');
    },
  };

  return makeContext({
    now: FROZEN_NOW,
    http,
    algod,
    indexer,
    prices: stubPrices(prices()),
  });
}
