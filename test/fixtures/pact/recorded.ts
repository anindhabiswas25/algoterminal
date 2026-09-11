import { readFileSync } from 'node:fs';
import path from 'node:path';

import { POOL_PAGE_LIMIT, poolPageUrl } from '../../../src/connectors/pact/enumerate.js';
import { PactPoolSchema, type PactPool } from '../../../src/connectors/pact/schema.js';
import { FROZEN_NOW, makeContext } from '../../../src/connectors/testing.js';
import type { ConnectorContext, HttpClient } from '../../../src/connectors/types.js';

/**
 * The recorded Pact fixtures (CONNECTOR_GUIDE.md §Step 6), and a
 * `ConnectorContext` that replays them at the exact URLs `fetchRaw` requests.
 *
 * Every pool record here came off `https://api.pact.fi/api/pools` on
 * 2026-09-09, verbatim, via `scripts/record-pact-fixtures.ts`. The subset is
 * deliberate — the pools that dominate TVL, the deprecated ones, dust, and the
 * pool the source itself prices at zero on a side — so that every §3.6
 * exclusion branch is exercised rather than merely written.
 *
 * Two things the harness supplies rather than records, both of them envelopes:
 *
 *  1. **`count` / `limit` / `offset`.** The recorded pages carry 40 rows and
 *     echo `limit: 40`, while the connector *requests* `limit=500`. That
 *     mismatch is the fixture's whole point: against the live API the server
 *     caps a requested 1,000 at 500 and says so in the envelope, and a walk
 *     that strides by what it asked for reads half the catalogue in silence.
 *     Here the two differ by an order of magnitude, so a regression to
 *     request-striding fetches offset 500 — a URL this harness does not serve —
 *     and the test fails loudly instead of quietly returning 40 pools.
 *  2. **Nothing else.** There is no second endpoint, no chain read and no price
 *     table: Pact is one paginated GET, which is most of why this connector is
 *     a quarter the size of Tinyman's.
 *
 * An unregistered URL throws. An unanticipated fetch must fail the test, not
 * quietly shrink the snapshot.
 */

const DIR = path.dirname(new URL(import.meta.url).pathname);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as T;
}

export interface RecordedPage {
  count: number;
  limit: number;
  offset: number;
  results: unknown[];
}

/** The three recorded pages, in walk order. */
export const recordedPages = (): RecordedPage[] => [
  readJson<RecordedPage>('pools-page-1.json'),
  readJson<RecordedPage>('pools-page-2.json'),
  readJson<RecordedPage>('pools-page-3.json'),
];

/** Every recorded pool, parsed. */
export function loadRecordedPools(): PactPool[] {
  return recordedPages().flatMap((page) => page.results.map((row) => PactPoolSchema.parse(row)));
}

/**
 * The synthesised `pact_fee_bps` record — the one datum in this fixture set
 * that is not a recording, and which says so in its own file. See
 * `scripts/record-pact-fixtures.ts` §"The synthetic split pool".
 */
export function splitPool(): PactPool {
  return PactPoolSchema.parse(readJson<{ pool: unknown }>('split-pool.json').pool);
}

export interface FixtureContextOptions {
  /** Drop this many rows off the end of page 1, for the degradation test. */
  truncatePage1?: number;
  /** Serve the second page as a hard failure, for the degradation test. */
  failPage2?: boolean;
  /** Replace one row of page 1 with an unparseable object (schema drift). */
  corruptRows?: number;
  /**
   * Echo `limit: 500` on page 1 while still serving 40 rows — the live API's
   * silent page cap, inverted. A walk that strides by the echoed limit then
   * asks for offset 500, finds nothing, and must report a partial snapshot
   * rather than a 40-pool protocol.
   */
  lyingLimit?: boolean;
}

/**
 * A `ConnectorContext` serving the recorded fixtures — frozen clock, no
 * network, and an `http` that throws on any URL the fixtures do not cover.
 */
export function makeFixtureContext(options: FixtureContextOptions = {}): ConnectorContext {
  const pages = recordedPages();
  const count = pages.reduce((n, p) => n + p.results.length, 0);

  if (options.truncatePage1 !== undefined) {
    const p = pages[0] as RecordedPage;
    p.results = p.results.slice(0, Math.max(0, p.results.length - options.truncatePage1));
  }
  if (options.corruptRows !== undefined) {
    const p = pages[0] as RecordedPage;
    for (let i = 0; i < options.corruptRows && i < p.results.length; i++) {
      // Schema drift as it actually arrives: the row is still an object and
      // still has an id, but a field we depend on has changed type.
      p.results[i] = { ...(p.results[i] as object), tvl_usd: 12345 };
    }
  }

  const exact: Record<string, unknown> = {};
  const stride = (pages[0] as RecordedPage).limit;
  pages.forEach((page, i) => {
    if (options.failPage2 === true && i === 1) return;
    exact[poolPageUrl(i * stride)] = {
      count,
      limit: i === 0 && options.lyingLimit === true ? POOL_PAGE_LIMIT : page.limit,
      offset: i * stride,
      results: page.results,
    };
  });
  // The `healthCheck` probe.
  exact[poolPageUrl(0, 1)] = {
    count,
    limit: 1,
    offset: 0,
    results: (pages[0] as RecordedPage).results.slice(0, 1),
  };

  const calls: string[] = [];
  const http: HttpClient & { calls: string[] } = {
    calls,
    async getJson(url: string): Promise<unknown> {
      calls.push(url);
      if (Object.hasOwn(exact, url)) return exact[url];
      throw new Error(`fixture: no response registered for ${url}`);
    },
  };

  return makeContext({ now: FROZEN_NOW, http });
}
