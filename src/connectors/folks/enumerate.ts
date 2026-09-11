import { MainnetLoans } from '@folks-finance/algorand-sdk';

import { transactionsUrl } from '../indexer.js';
import type { SourceRef } from '../../standardize/schema.js';
import type { ConnectorContext } from '../types.js';
import {
  DEPOSITS_APP_ID,
  FOLKS_MARKETS,
  POOL_MANAGER_APP_ID,
  type FolksMarket,
} from './constants.js';
import { decodeMarket, type FolksEntity } from './schema.js';

/**
 * I/O for the Folks connector — DATA_SCHEMA.md §3.5.
 *
 * Two reads, both on chain, both through `ctx.algod` / `ctx.indexer` so they
 * carry the §4.1 retry policy, the concurrency cap and the User-Agent:
 *
 *  1. Each market's application global state, for every KPI but one.
 *  2. The trailing-24h indexer scan, only when `active_users_24h` is requested.
 */

export const ALGOD_SOURCE_NAME = 'nodely-algod';
export const INDEXER_SOURCE_NAME = 'nodely-indexer';

/** The URL one market's global-state read hits, for a `SourceRef` (§1.4). */
export function applicationUrl(baseUrl: string, appId: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/v2/applications/${appId}`;
}

export interface MarketWalk {
  readonly entities: FolksEntity[];
  readonly sources: SourceRef[];
  readonly partial: boolean;
  /** Markets whose state could not be read or decoded (§Step 4). */
  readonly unreadable: number;
}

/**
 * Read every market's global state.
 *
 * There is no pagination and no `next-token` here: the market set is the SDK's
 * pinned list, so "did we see all of it" is answered by counting rather than by
 * trusting a cursor. A market that fails is recorded as an `unreadable` entity
 * and counted, never dropped — an absent market and a market holding nothing
 * are different facts, and only one of them may reduce TVL (§1.5).
 *
 * The reads are issued together; `ctx.http`'s per-host concurrency cap is what
 * paces them, not a hand-rolled batch size here (§4.1).
 */
export async function fetchMarkets(
  ctx: ConnectorContext,
  markets: readonly FolksMarket[] = FOLKS_MARKETS,
): Promise<MarketWalk> {
  const retrievedAt = ctx.now().toISOString();
  const sources: SourceRef[] = [];
  const entities: FolksEntity[] = [];
  let unreadable = 0;

  const results = await Promise.all(
    markets.map(async (market) => {
      try {
        const { round, state } = await ctx.algod.getApplicationGlobalState(market.appId);
        return { market, round, state, error: null as string | null };
      } catch (err) {
        ctx.log.warn({ err, appId: market.appId }, 'folks: market global state read failed');
        return { market, round: 0, state: null, error: String(err) };
      }
    }),
  );

  for (const result of results) {
    if (result.error !== null) {
      entities.push({
        kind: 'unreadable',
        appId: result.market.appId,
        name: result.market.name,
        reason: `algod read failed: ${result.error}`,
      });
      unreadable++;
      continue;
    }

    // One SourceRef per market: §1.4 promises a buyer can re-derive our number,
    // and 25 app ids with their rounds is exactly what that takes.
    sources.push({
      name: ALGOD_SOURCE_NAME,
      url: applicationUrl(ctx.algod.baseUrl, result.market.appId),
      kind: 'onchain',
      retrieved_at: retrievedAt,
      app_id: result.market.appId,
      round: result.round,
    });

    const entity = decodeMarket(result.market, result.state, result.round);
    if (entity.kind === 'unreadable') unreadable++;
    entities.push(entity);
  }

  return {
    entities,
    sources,
    // Partial when ANY market is missing from the aggregate. With a pinned,
    // finite market list there is no ambiguity about what "all" means.
    partial: unreadable > 0,
    unreadable,
  };
}

/**
 * DATA_SCHEMA.md §4.1 — the trailing-24h round range, in rounds.
 *
 * The same convention and the same constant the Tinyman connector uses, for
 * the same reason: neither algod status nor the §1.2 indexer client exposes a
 * block timestamp, so the window is a round count rather than an exact 24h
 * boundary, and every fact says so in its `estimation_method`.
 */
export const ROUNDS_PER_24H = 31_500;

/** Indexer page size for the active-users scan. */
export const INDEXER_PAGE_LIMIT = 1_000;

/**
 * The applications a Folks user touches when they do one of §4.1's core
 * lending interactions.
 *
 * Included: every market application (a deposit or withdraw is a call to the
 * market), the six loan applications (a borrow or repay is a call to a loan),
 * and the deposits application that manages deposit escrows.
 *
 * **Excluded on purpose: the deposit-staking application.** Staking an f-token
 * for rewards is not a deposit, withdraw, borrow or repay — it is a different
 * action, and §4.1 defines the metric by the interaction rather than by the
 * brand. Counting it would quietly widen the definition for one protocol and
 * break the cross-protocol comparison the count exists for.
 */
export function activeUserAppIds(markets: readonly FolksMarket[] = FOLKS_MARKETS): number[] {
  return [...markets.map((m) => m.appId), ...LOAN_APP_IDS, DEPOSITS_APP_ID];
}

/**
 * The loan applications, from the SDK's `MainnetLoans`.
 *
 * Listed through the constants module rather than inline so a loan type added
 * in a future SDK release arrives with the pin bump rather than being missed.
 */
export const LOAN_APP_IDS: readonly number[] = Object.freeze(
  Object.values(MainnetLoans as Record<string, number>),
);

export interface ActiveUsersScan {
  readonly addresses: number;
  readonly transactions: number;
  readonly appIds: readonly number[];
  readonly requestedMinRound: number;
  readonly requestedMaxRound: number;
  readonly observedMinRound: number | null;
  readonly observedMaxRound: number | null;
}

/**
 * Distinct senders across every §4.1 application, over the trailing-24h rounds.
 *
 * Returns null — and the KPI is then omitted entirely — if any page fails.
 * §4.1 is explicit: a distinct count over part of a scan is not a smaller
 * version of the answer, it is a different and unfalsifiable number.
 */
export async function scanActiveUsers(
  ctx: ConnectorContext,
  sources: SourceRef[],
  appIds: readonly number[] = activeUserAppIds(),
): Promise<ActiveUsersScan | null> {
  const status = await ctx.algod.status().catch(() => null);
  if (status === null) {
    ctx.log.warn('folks active_users_24h: algod status unavailable; declining the KPI');
    return null;
  }

  const maxRound = status.lastRound;
  const minRound = Math.max(0, maxRound - ROUNDS_PER_24H);
  const senders = new Set<string>();
  let transactions = 0;
  let observedMin: number | null = null;
  let observedMax: number | null = null;

  for (const applicationId of appIds) {
    let next: string | undefined;
    for (;;) {
      const page = await ctx.indexer
        .searchTransactions({
          applicationId,
          minRound,
          maxRound,
          limit: INDEXER_PAGE_LIMIT,
          ...(next === undefined ? {} : { next }),
        })
        .catch((err: unknown) => {
          ctx.log.warn({ err, applicationId }, 'folks active_users_24h: indexer page failed');
          return null;
        });
      if (page === null) return null;

      if (next === undefined) {
        sources.push({
          name: INDEXER_SOURCE_NAME,
          url: transactionsUrl(ctx.indexer.baseUrl, {
            applicationId,
            minRound,
            maxRound,
            limit: INDEXER_PAGE_LIMIT,
          }),
          kind: 'onchain',
          retrieved_at: ctx.now().toISOString(),
          app_id: applicationId,
          round: maxRound,
        });
      }

      for (const txn of page.transactions) {
        transactions++;
        const sender = (txn as { sender?: unknown }).sender;
        if (typeof sender === 'string' && sender.length > 0) senders.add(sender);
        const round = (txn as { 'confirmed-round'?: unknown })['confirmed-round'];
        if (typeof round === 'number') {
          observedMin = observedMin === null ? round : Math.min(observedMin, round);
          observedMax = observedMax === null ? round : Math.max(observedMax, round);
        }
      }

      if (page.nextToken === undefined) break;
      next = page.nextToken;
    }
  }

  return {
    addresses: senders.size,
    transactions,
    appIds: [...appIds],
    requestedMinRound: minRound,
    requestedMaxRound: maxRound,
    observedMinRound: observedMin,
    observedMaxRound: observedMax,
  };
}

/** The pool-manager application, used by `healthCheck` as a liveness probe. */
export const HEALTH_PROBE_APP_ID = POOL_MANAGER_APP_ID;
