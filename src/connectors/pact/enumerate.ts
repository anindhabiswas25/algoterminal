import type { SourceRef } from '../../standardize/schema.js';
import type { ConnectorContext } from '../types.js';
import { PactPageSchema, PactPoolSchema, type PactPool } from './schema.js';

/**
 * DATA_SCHEMA.md §3.4 — the Pact catalogue walk. I/O only.
 *
 * One endpoint, offset-paginated, open and unauthenticated. The whole file
 * exists for a single upstream behaviour that a naive walk gets silently wrong;
 * see {@link fetchPools}.
 */

export const PACT_BASE = 'https://api.pact.fi/api';
export const SOURCE_NAME = 'pact-api';

/**
 * The page size we ASK for.
 *
 * 500 rather than the 1,000 a first reading of §3.4 suggests, because 500 is
 * the largest page the server will actually serve — see {@link fetchPools}.
 * Asking for exactly what we can get keeps the requested and effective page
 * sizes equal in the normal case, so the stride below is a guard rather than a
 * correction that has to fire on every run.
 */
export const POOL_PAGE_LIMIT = 500;

export function poolPageUrl(offset: number, limit = POOL_PAGE_LIMIT): string {
  return `${PACT_BASE}/pools?limit=${limit}&offset=${offset}`;
}

export interface PactEnumerationResult {
  readonly pools: PactPool[];
  readonly sources: SourceRef[];
  readonly partial: boolean;
  /** Rows that failed zod validation, plus pages that would not fetch. */
  readonly excludedCount: number;
  /** The server's own page size, as echoed on page 1. Recorded for the README. */
  readonly effectiveLimit: number;
  /** Total the server claims to hold, from page 1's `count`. */
  readonly reportedCount: number;
  /** Rows that arrived twice under the same `id`. Zero on every live run so far. */
  readonly duplicates: number;
}

/**
 * Page the pool catalogue exhaustively.
 *
 * ## The quirk this function is shaped around
 *
 * `GET /api/pools?limit=N` silently caps N at 500. Ask for 1,000 and the
 * response is 500 rows — with `"limit": 500` echoed in the envelope, which is
 * the server telling us plainly what it did. A walk that strides by the
 * REQUESTED limit therefore reads rows 0-499, then 1000-1499, then 2000-2499:
 * exactly half the catalogue, with no error, no truncation flag, and a `count`
 * that keeps agreeing with itself. Measured 2026-09-09: 2,000 of 3,961 pools,
 * and 3 of the 4 pools over the §3.7 rank-3 liquidity gate fall in the unread
 * half.
 *
 * So the stride comes from `page.limit` — what the server says it served — and
 * never from what we asked for. That is the difference between a walk that
 * adapts to a page-size change and one that starts skipping rows on the day
 * the cap moves.
 *
 * The belt to that braces is the reconciliation below: `count` is compared with
 * the number of distinct rows actually collected, and a shortfall sets
 * `partial`. §Step 4 forbids a silent truncation, and a pagination bug is the
 * one kind of truncation that looks exactly like a small protocol.
 */
export async function fetchPools(ctx: ConnectorContext): Promise<PactEnumerationResult> {
  const sources: SourceRef[] = [];
  let partial = false;
  let excludedCount = 0;

  const readPage = async (
    offset: number,
  ): Promise<{ count: number; limit: number; results: unknown[] } | null> => {
    const url = poolPageUrl(offset);
    const raw = await ctx.http.getJson(url).catch((err: unknown) => {
      ctx.log.warn({ err, url }, 'pact pool page failed after retries');
      return null;
    });
    const page = PactPageSchema.safeParse(raw);
    if (!page.success) {
      ctx.log.warn({ url, issues: page.error.issues }, 'pact page envelope failed validation');
      return null;
    }
    sources.push({ name: SOURCE_NAME, url, kind: 'rest', retrieved_at: ctx.now().toISOString() });
    return page.data;
  };

  const first = await readPage(0);
  if (first === null) {
    return {
      pools: [],
      sources,
      partial: true,
      excludedCount: 1,
      effectiveLimit: 0,
      reportedCount: 0,
      duplicates: 0,
    };
  }

  // The server's page size, cross-checked against the rows it actually sent.
  // `limit` is the authority — a short final page must not shrink the stride —
  // but a page whose row count EXCEEDS its own echoed limit would mean the
  // envelope is lying, and striding by a lie is how rows go missing.
  const effectiveLimit = Math.max(1, Math.min(first.limit, POOL_PAGE_LIMIT));
  if (first.results.length > first.limit) {
    ctx.log.warn(
      { echoed: first.limit, received: first.results.length },
      'pact page returned more rows than its own echoed limit; treating the snapshot as partial',
    );
    partial = true;
  }

  const offsets: number[] = [];
  for (let offset = effectiveLimit; offset < first.count; offset += effectiveLimit) {
    offsets.push(offset);
  }
  // Page 1 alone (it is the only response that reports `count`), then the rest
  // at once — `ctx.http`'s per-host semaphore (§4.1), not a `for` loop, is what
  // keeps that polite. 8 pages concurrently is ~4s against ~11s sequentially.
  const rest = await Promise.all(offsets.map(readPage));

  const byId = new Map<number, PactPool>();
  let duplicates = 0;
  for (const page of [first, ...rest]) {
    if (page === null) {
      partial = true;
      excludedCount++;
      continue;
    }
    for (const row of page.results) {
      const parsed = PactPoolSchema.safeParse(row);
      if (!parsed.success) {
        excludedCount++;
        ctx.log.warn({ issues: parsed.error.issues }, 'pact pool failed schema validation');
        continue;
      }
      // Tinyman's V1.1 list returns 7,418 rows over ~5,500 distinct addresses
      // because offset pagination re-orders under the walk (§3.3). Pact showed
      // no duplicates across all 3,961 rows on 2026-09-09 — but the guard is
      // free, and the failure it prevents is a double-counted TVL that looks
      // entirely plausible. First occurrence wins, so the result is stable
      // under re-ordering.
      if (byId.has(parsed.data.id)) duplicates++;
      else byId.set(parsed.data.id, parsed.data);
    }
  }

  // The reconciliation. `count` is the server's claim; `byId.size +
  // excludedCount` is what we can account for. A shortfall means rows went
  // unread — which is precisely the failure mode the stride above exists to
  // prevent, so it is checked rather than trusted.
  const accountedFor = byId.size + excludedCount + duplicates;
  if (accountedFor < first.count) {
    ctx.log.warn(
      { reported: first.count, accountedFor },
      'pact walk accounted for fewer pools than the catalogue claims to hold',
    );
    partial = true;
  }

  return {
    pools: [...byId.values()],
    sources,
    partial,
    excludedCount,
    effectiveLimit,
    reportedCount: first.count,
    duplicates,
  };
}
