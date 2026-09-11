import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  ACCOUNTS_PAGE_LIMIT,
  accountsByApplicationUrl,
  createIndexerClient,
  transactionsUrl,
} from '../../src/connectors/indexer.js';
import type { HttpClient } from '../../src/connectors/types.js';

/**
 * CONNECTOR_GUIDE.md §4.2 — the shared indexer client.
 *
 * `listAccountsByApplication` is the DATA_SCHEMA.md §3.3 enumeration path, and
 * the one failure it exists to make impossible is a silent truncation: an
 * account walk that stops early reports a protocol's TVL as whatever fraction
 * it happened to read, and nothing downstream can tell. Every test here is
 * about that, or about the base64 decoding that turns a page into pool state.
 */

const log = pino({ level: 'silent' });
const BASE = 'https://mainnet-idx.4160.nodely.dev';
const APP = 1_002_541_853;

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** One account, shaped exactly as the live indexer shapes it (verified 2026-09-09). */
function account(address: string, state: Record<string, number>, overrides: object = {}) {
  return {
    address,
    round: 64_855_030,
    deleted: false,
    'apps-local-state': [
      {
        id: APP,
        deleted: false,
        'key-value': Object.entries(state).map(([key, uint]) => ({
          key: b64(key),
          value: { type: 2, bytes: '', uint },
        })),
      },
    ],
    ...overrides,
  };
}

function stubHttp(pages: Array<unknown | null>, calls: string[] = []): HttpClient {
  return {
    async getJson(url: string) {
      calls.push(url);
      const next = new URL(url).searchParams.get('next');
      const index = next === null ? 0 : Number(next);
      const page = pages[index];
      if (page === null || page === undefined) throw new Error(`page ${index} failed`);
      return page;
    },
  };
}

const page = (accounts: unknown[], next?: string) => ({
  accounts,
  'current-round': 64_855_030,
  ...(next === undefined ? {} : { 'next-token': next }),
});

describe('listAccountsByApplication (DATA_SCHEMA.md §3.3)', () => {
  it('pages exhaustively through next-token and decodes local state', async () => {
    const calls: string[] = [];
    const client = createIndexerClient({
      baseUrl: BASE,
      http: stubHttp(
        [
          page([account('AAA', { asset_1_id: 0, asset_1_reserves: 100 })], '1'),
          page([account('BBB', { asset_1_id: 31_566_704, asset_1_reserves: 200 })], '2'),
          page([account('CCC', { asset_1_id: 999, asset_1_reserves: 300 })]),
        ],
        calls,
      ),
    });

    const walk = await client.listAccountsByApplication(APP);

    expect(walk.accounts.map((a) => a.address)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(walk.pages).toBe(3);
    expect(walk.partial).toBe(false);
    expect(walk.failedPages).toBe(0);
    expect(walk.currentRound).toBe(64_855_030);
    // Base64 keys become UTF-8, and a uint stays a discriminated uint — a
    // caller reading `.uint` off a byte slice is what §1.2 exists to prevent.
    expect(walk.accounts[0]?.state['asset_1_reserves']).toEqual({ type: 'uint', uint: 100 });
    expect(walk.accounts[1]?.state['asset_1_id']).toEqual({ type: 'uint', uint: 31_566_704 });
    // Every page URL is recorded, so provenance can name what it read (§1.4).
    expect(walk.urls).toHaveLength(3);
    expect(calls[0]).toContain(`application-id=${APP}`);
    expect(calls[1]).toContain('next=1');
  });

  it('a page that fails after retries sets partial and is COUNTED', async () => {
    // The whole point. The walk keeps what it read and says it is incomplete;
    // it never returns a short list that looks like a complete one.
    const client = createIndexerClient({
      baseUrl: BASE,
      http: stubHttp([page([account('AAA', { a: 1 })], '1'), null]),
    });

    const walk = await client.listAccountsByApplication(APP);

    expect(walk.accounts).toHaveLength(1);
    expect(walk.pages).toBe(1);
    expect(walk.failedPages).toBe(1);
    expect(walk.partial).toBe(true);
  });

  it('drops and counts an account with no live local state under the app', async () => {
    // The filter asked for accounts opted into `appId`; one without that state
    // is a contradiction, and reading it as a pool whose every parameter is
    // zero would put a real address behind a fabricated zero.
    const client = createIndexerClient({
      baseUrl: BASE,
      http: stubHttp([
        page([
          account('GOOD', { asset_1_id: 5 }),
          { address: 'NOSTATE', round: 1, deleted: false, 'apps-local-state': [] },
          account('CLOSED', { asset_1_id: 5 }, { deleted: true }),
          {
            address: 'OPTEDOUT',
            round: 1,
            deleted: false,
            'apps-local-state': [{ id: APP, deleted: true, 'key-value': [] }],
          },
          { address: 42 },
        ]),
      ]),
    });

    const walk = await client.listAccountsByApplication(APP);

    expect(walk.accounts.map((a) => a.address)).toEqual(['GOOD']);
    expect(walk.skipped).toBe(4);
    // A skip is a coverage hole, not a broken walk: `partial` stays false and
    // the connector counts these in `coverage.excluded` instead.
    expect(walk.partial).toBe(false);
  });

  it('stops on an empty page rather than looping on a stale next-token', async () => {
    const client = createIndexerClient({
      baseUrl: BASE,
      http: stubHttp([page([account('AAA', { a: 1 })], '1'), page([], '2')]),
    });
    const walk = await client.listAccountsByApplication(APP);
    expect(walk.accounts).toHaveLength(1);
    expect(walk.pages).toBe(2);
    expect(walk.partial).toBe(false);
  });

  it('falls back to the page round when an account carries none', async () => {
    const client = createIndexerClient({
      baseUrl: BASE,
      http: stubHttp([
        page([{ address: 'AAA', 'apps-local-state': [{ id: APP, 'key-value': [] }] }]),
      ]),
    });
    const walk = await client.listAccountsByApplication(APP);
    // §4.2: an on-chain number without a round is not reproducible, so there
    // is always a round — the walk's own, when the account omits one.
    expect(walk.accounts[0]?.round).toBe(64_855_030);
  });
});

describe('SourceRef URLs (§1.4)', () => {
  it('accountsByApplicationUrl is the URL the walk actually reads', () => {
    const url = accountsByApplicationUrl(`${BASE}/`, APP);
    expect(url).toBe(
      `${BASE}/v2/accounts?application-id=${APP}&limit=${ACCOUNTS_PAGE_LIMIT}` +
        '&exclude=assets%2Ccreated-assets%2Ccreated-apps',
    );
    expect(accountsByApplicationUrl(BASE, APP, 'TOKEN')).toContain('&next=TOKEN');
  });

  it('transactionsUrl still names its round window', () => {
    expect(transactionsUrl(BASE, { applicationId: APP, minRound: 1, maxRound: 2, limit: 3 })).toBe(
      `${BASE}/v2/transactions?application-id=${APP}&min-round=1&max-round=2&limit=3`,
    );
  });
});
