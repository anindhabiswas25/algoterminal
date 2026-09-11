import { z } from 'zod';

import { decodeAppState } from './algod.js';
import type { AppState, HttpClient, IndexerAccountState, IndexerClient } from './types.js';

/**
 * CONNECTOR_GUIDE.md §4.2 — the shared Nodely indexer client.
 *
 * `searchTransactions` is the DATA_SCHEMA.md §4.1 path for `active_users_24h`:
 * filter by application id over a round range, page exhaustively, collect
 * distinct senders. Paging is the caller's job (it is what lets a connector
 * bound its own cost); never truncating silently is the caller's obligation.
 *
 * `listAccountsByApplication` is the DATA_SCHEMA.md §3.3 path for enumerating
 * every account opted into a controller application — for Tinyman V2, every
 * pool. It pages *internally*, which is the opposite of `searchTransactions`
 * and deliberate: a transaction scan is unbounded and a connector must be free
 * to stop, while an account enumeration has a finite, known answer and a
 * caller that stopped early would be reporting a protocol's TVL as whatever
 * fraction it happened to read. Truncating that is the one failure this method
 * exists to make impossible, so the walk is not the caller's to cut short — it
 * either completes or reports `partial` with the failed pages counted.
 */

const PageSchema = z.object({
  transactions: z.array(z.unknown()).default([]),
  'next-token': z.string().optional(),
});

/** algod and the indexer encode application state identically: base64 both sides. */
const KeyValueSchema = z.object({
  key: z.string(),
  value: z.object({
    type: z.number().int(),
    bytes: z.string().default(''),
    uint: z.number().default(0),
  }),
});

const AccountSchema = z.object({
  address: z.string().min(1),
  round: z.number().int().nonnegative().optional(),
  deleted: z.boolean().default(false),
  'apps-local-state': z
    .array(
      z.object({
        id: z.number().int(),
        deleted: z.boolean().default(false),
        'key-value': z.array(KeyValueSchema).default([]),
      }),
    )
    .default([]),
});

const AccountsPageSchema = z.object({
  accounts: z.array(z.unknown()).default([]),
  'current-round': z.number().int().nonnegative(),
  'next-token': z.string().optional(),
});

export interface IndexerOptions {
  readonly baseUrl: string;
  readonly http: HttpClient;
  /** Indexer pages can be multi-megabyte; the §4.1 default 8s is often short. */
  readonly timeoutMs?: number;
}

/** §3.3 — the account walk's page size. 1,000 is the indexer's own maximum. */
export const ACCOUNTS_PAGE_LIMIT = 1_000;

/**
 * Fields the account walk never reads, dropped server-side.
 *
 * Not a micro-optimization: a Tinyman V2 pool account holds three ASA
 * positions, and carrying them across 17,119 accounts is ~4MB of payload that
 * exists only to be discarded. `apps-local-state` — the one thing this method
 * is for — is deliberately NOT excluded, and the schema above fails loudly
 * rather than quietly if that ever changes.
 */
const ACCOUNTS_EXCLUDE = 'assets,created-assets,created-apps';

export function createIndexerClient({
  baseUrl,
  http,
  timeoutMs = 30_000,
}: IndexerOptions): IndexerClient {
  const root = baseUrl.replace(/\/+$/, '');

  return {
    baseUrl: root,

    async searchTransactions(params) {
      const query = new URLSearchParams({ 'application-id': String(params.applicationId) });
      if (params.minRound !== undefined) query.set('min-round', String(params.minRound));
      if (params.maxRound !== undefined) query.set('max-round', String(params.maxRound));
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.next !== undefined) query.set('next', params.next);

      const page = PageSchema.parse(
        await http.getJson(`${root}/v2/transactions?${query.toString()}`, { timeoutMs }),
      );
      const nextToken = page['next-token'];
      return nextToken === undefined
        ? { transactions: page.transactions }
        : { transactions: page.transactions, nextToken };
    },

    async listAccountsByApplication(appId) {
      const accounts: IndexerAccountState[] = [];
      const urls: string[] = [];
      let next: string | undefined;
      let pages = 0;
      let failedPages = 0;
      let skipped = 0;
      let currentRound = 0;

      for (;;) {
        const url = accountsByApplicationUrl(root, appId, next);
        urls.push(url);
        const raw = await http.getJson(url, { timeoutMs }).catch(() => null);
        const page = raw === null ? null : AccountsPageSchema.safeParse(raw);

        if (page === null || !page.success) {
          // A page that will not come back after `ctx.http`'s retries leaves a
          // hole. It is counted and surfaced, never papered over — an
          // enumeration silently missing 1,000 pools understates a protocol's
          // TVL by an amount nothing downstream could detect.
          failedPages++;
          break;
        }

        pages++;
        currentRound = page.data['current-round'];
        for (const row of page.data.accounts) {
          const parsed = AccountSchema.safeParse(row);
          if (!parsed.success || parsed.data.deleted) {
            skipped++;
            continue;
          }
          const local = parsed.data['apps-local-state'].find((s) => s.id === appId && !s.deleted);
          if (local === undefined) {
            // The filter asked for accounts opted into `appId`; one without
            // that state is a contradiction, so it is dropped and counted
            // rather than read as a pool whose every parameter is zero.
            skipped++;
            continue;
          }
          accounts.push({
            address: parsed.data.address,
            round: parsed.data.round ?? page.data['current-round'],
            state: decodeAppState(local['key-value']) as AppState,
          });
        }

        next = page.data['next-token'];
        if (next === undefined || page.data.accounts.length === 0) break;
      }

      return {
        accounts,
        currentRound,
        pages,
        failedPages,
        skipped,
        partial: failedPages > 0,
        urls,
      };
    },
  };
}

/** The exact URL a `searchTransactions` call reads, for a `SourceRef` (§1.4). */
export function transactionsUrl(
  baseUrl: string,
  params: { applicationId: number; minRound?: number; maxRound?: number; limit?: number },
): string {
  const query = new URLSearchParams({ 'application-id': String(params.applicationId) });
  if (params.minRound !== undefined) query.set('min-round', String(params.minRound));
  if (params.maxRound !== undefined) query.set('max-round', String(params.maxRound));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  return `${baseUrl.replace(/\/+$/, '')}/v2/transactions?${query.toString()}`;
}

/** The exact URL one page of the §3.3 account walk reads, for a `SourceRef`. */
export function accountsByApplicationUrl(
  baseUrl: string,
  appId: number,
  next?: string,
): string {
  const query = new URLSearchParams({
    'application-id': String(appId),
    limit: String(ACCOUNTS_PAGE_LIMIT),
    exclude: ACCOUNTS_EXCLUDE,
  });
  if (next !== undefined) query.set('next', next);
  return `${baseUrl.replace(/\/+$/, '')}/v2/accounts?${query.toString()}`;
}
