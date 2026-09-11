import type { SourceRef } from '../../standardize/schema.js';
import type { AppState, ConnectorContext } from '../types.js';
import {
  TinymanPageSchema,
  TinymanPoolSchema,
  V2_STATE_KEYS,
  type TinymanFeeState,
  type TinymanPool,
  type TinymanV2Flows,
  type TinymanV2PoolEntity,
} from './schema.js';

/**
 * DATA_SCHEMA.md §3.3 — Tinyman's pool enumeration.
 *
 * ## What changed in methodology_version 1.1.0, and why
 *
 * Until 1.1.0 V2 pools were reached through the `v2_address` pointer on V1.1
 * analytics records. That pointer only exists on a pool that HAD a V1.1
 * predecessor, so the walk reached 922 of the 17,119 live V2 pools — 5.4% —
 * and missed every V2-native pair, which is where the liquidity actually is
 * (tALGO/xALGO, tALGO/USDC, Folks/ALGO). The connector reported $2.51M against
 * DefiLlama's $5.80M, a -56.7% divergence, and said so in every `notes[]`.
 *
 * The complete enumeration is {@link enumerateV2Pools}: one indexer walk of
 * `GET /v2/accounts?application-id=1002541853` reaches all 17,119 pool
 * accounts in 19 pages, and each account's LOCAL state under that app already
 * carries `asset_1_id`, `asset_2_id`, `asset_1_reserves`, `asset_2_reserves`,
 * `total_fee_share`, `protocol_fee_ratio` and `issued_pool_tokens`. A V2 pool
 * is therefore fully described on-chain, with no analytics call at all — which
 * is both the correctness fix and, since it replaces 922 per-pool REST fetches
 * AND 922 per-pool algod local-state reads with 19 indexer pages, most of the
 * performance fix.
 *
 * ## What did NOT change
 *
 * **V1.1 stays on the analytics API.** There is no V1.1 equivalent of the V2
 * validator application to enumerate against: a V1.1 pool is an lsig account
 * opted into app 552635992, but its reserves and fee state are not laid out in
 * local state the way V2's are, so the analytics record remains the only
 * complete description. V1.1 is $183k of the venue, so the asymmetry is
 * documented rather than papered over.
 *
 * **The dedupe-by-address guard stays.** Re-verified 2026-09-09: paging the
 * V1.1 list still yields 7,418 rows over 5,493 distinct addresses — offset
 * pagination over a set the server re-orders returns the same pool twice. The
 * guard is load-bearing for the V1.1 list itself.
 *
 * **The endpoint still throttles.** Eight unpaced concurrent requests earn
 * HTTP 429 with `Retry-After: 18`, handled by `ctx.http`'s §4.1 retry policy.
 * It is why the parallel fetches here hand every request to `ctx.http` rather
 * than firing bare `fetch` calls: the per-host semaphore is the throttle guard.
 */

export const TINYMAN_BASE = 'https://mainnet.analytics.tinyman.org/api/v1';
/** The list endpoint honours `limit=1000`; 7,418 rows is 8 pages, not 15. */
export const POOL_PAGE_LIMIT = 1_000;
/** Tinyman's `/assets/?ids=` CSV chunk size — a real filter on that endpoint. */
export const ASSET_ID_CHUNK = 50;
export const SOURCE_NAME = 'tinyman-analytics';
export const INDEXER_SOURCE_NAME = 'nodely-indexer';

export function poolPageUrl(offset: number, limit = POOL_PAGE_LIMIT): string {
  return `${TINYMAN_BASE}/pools/?limit=${limit}&offset=${offset}`;
}

export function poolByAddressUrl(address: string): string {
  return `${TINYMAN_BASE}/pools/${address}/`;
}

export function assetsUrl(ids: readonly number[]): string {
  return `${TINYMAN_BASE}/assets/?ids=${ids.join(',')}&limit=${ids.length}`;
}

/**
 * §3.3's double-counting guard. A V1.1 pool and the V2 pool at the same pair
 * are distinct venues holding distinct liquidity and both are counted; what
 * must never happen is the same record arriving twice under two keys. First
 * occurrence wins, so the result is stable under re-ordering.
 */
export function dedupeByAddress(pools: readonly TinymanPool[]): TinymanPool[] {
  const seen = new Map<string, TinymanPool>();
  for (const pool of pools) {
    if (!seen.has(pool.address)) seen.set(pool.address, pool);
  }
  return [...seen.values()];
}

export interface V11EnumerationResult {
  readonly pools: TinymanPool[];
  readonly sources: SourceRef[];
  readonly partial: boolean;
  /** Records that failed zod validation, or pages that would not fetch. */
  readonly excludedCount: number;
}

/**
 * Page the V1.1 list exhaustively.
 *
 * Page 1 is fetched alone because it is the only response that reports
 * `count`; the remaining 7 go out at once, capped by `ctx.http`'s per-host
 * semaphore. A page that fails after retries sets `partial` and is counted,
 * rather than discarding the pages already collected (§Step 4): a snapshot
 * missing part of its tail, labelled as missing it, is worth strictly more
 * than no snapshot.
 */
export async function fetchV11Pools(ctx: ConnectorContext): Promise<V11EnumerationResult> {
  const sources: SourceRef[] = [];
  let partial = false;
  let excludedCount = 0;

  const readPage = async (offset: number): Promise<{ count: number; results: unknown[] } | null> => {
    const url = poolPageUrl(offset);
    const raw = await ctx.http.getJson(url).catch((err: unknown) => {
      ctx.log.warn({ err, url }, 'tinyman pool page failed after retries');
      return null;
    });
    const page = TinymanPageSchema.safeParse(raw);
    if (!page.success) return null;
    sources.push({ name: SOURCE_NAME, url, kind: 'rest', retrieved_at: ctx.now().toISOString() });
    return page.data;
  };

  const first = await readPage(0);
  if (first === null) {
    return { pools: [], sources, partial: true, excludedCount: 1 };
  }

  const offsets: number[] = [];
  for (let offset = POOL_PAGE_LIMIT; offset < first.count; offset += POOL_PAGE_LIMIT) {
    offsets.push(offset);
  }
  const rest = await Promise.all(offsets.map(readPage));

  const pools: TinymanPool[] = [];
  for (const page of [first, ...rest]) {
    if (page === null) {
      partial = true;
      excludedCount++;
      continue;
    }
    for (const row of page.results) {
      const parsed = TinymanPoolSchema.safeParse(row);
      if (parsed.success) pools.push(parsed.data);
      else {
        excludedCount++;
        ctx.log.warn({ issues: parsed.error.issues }, 'tinyman pool failed schema validation');
      }
    }
  }

  // `count` overcounts, so the walk's result is deduped regardless.
  return { pools: dedupeByAddress(pools), sources, partial, excludedCount };
}

export interface V2EnumerationResult {
  readonly pools: TinymanV2PoolEntity[];
  readonly sources: SourceRef[];
  readonly partial: boolean;
  readonly excludedCount: number;
  /** Total accounts the indexer returned, before any validation. */
  readonly enumerated: number;
  readonly pages: number;
}

/** Read a required uint out of decoded local state, or null if it is not one. */
function uintOf(state: AppState, key: string): number | null {
  const value = state[key];
  return value?.type === 'uint' ? value.uint : null;
}

/**
 * The complete §3.3 V2 enumeration: every account opted into the validator
 * application, with its pool parameters read straight out of local state.
 *
 * An account whose state is missing one of {@link V2_STATE_KEYS} is EXCLUDED
 * and counted, never defaulted. A pool with `asset_1_id` defaulted to 0 would
 * be a pool that silently claims to hold ALGO.
 */
export async function enumerateV2Pools(
  ctx: ConnectorContext,
  appId: number,
): Promise<V2EnumerationResult> {
  const walk = await ctx.indexer.listAccountsByApplication(appId).catch((err: unknown) => {
    ctx.log.error({ err, appId }, 'tinyman V2 account enumeration failed');
    return null;
  });

  if (walk === null) {
    return { pools: [], sources: [], partial: true, excludedCount: 0, enumerated: 0, pages: 0 };
  }

  const retrievedAt = ctx.now().toISOString();
  const sources: SourceRef[] = walk.urls.map((url) => ({
    name: INDEXER_SOURCE_NAME,
    url,
    kind: 'onchain',
    retrieved_at: retrievedAt,
    app_id: appId,
    round: walk.currentRound,
  }));

  const pools: TinymanV2PoolEntity[] = [];
  let excludedCount = walk.skipped;

  for (const account of walk.accounts) {
    const values = V2_STATE_KEYS.map((key) => uintOf(account.state, key));
    if (values.some((v) => v === null)) {
      excludedCount++;
      ctx.log.warn(
        { address: account.address, missing: V2_STATE_KEYS.filter((k, i) => values[i] === null) },
        'tinyman V2 pool local state missing a required uint; excluded',
      );
      continue;
    }
    const [asset1Id, asset2Id, r1, r2, totalFeeShare, protocolFeeRatio, issued] = values as number[];
    const fee: TinymanFeeState = {
      kind: 'v2_onchain',
      totalFeeShare: totalFeeShare as number,
      protocolFeeRatio: protocolFeeRatio as number,
      appId,
      round: account.round,
    };
    pools.push({
      kind: 'v2_pool',
      address: account.address,
      asset1Id: asset1Id as number,
      asset2Id: asset2Id as number,
      asset1Decimals: null,
      asset2Decimals: null,
      asset1Reserves: r1 as number,
      asset2Reserves: r2 as number,
      issuedPoolTokens: issued as number,
      fee,
      round: account.round,
      flows: null,
    });
  }

  return {
    pools,
    sources,
    partial: walk.partial,
    excludedCount,
    enumerated: walk.accounts.length + walk.skipped,
    pages: walk.pages,
  };
}

/**
 * Asset decimals for the §3.3 reserve → whole-unit conversion.
 *
 * On-chain local state carries asset *ids*, not their decimals, so this is the
 * one piece of a V2 pool that is not on-chain. It comes from Tinyman's
 * `/assets/?ids=` — the same endpoint the §3.7 rank-2 gate already uses, so it
 * costs one extra chunked read of a field that is immutable ASA metadata, not
 * a flow. Ids already known from a V1.1 record are not re-fetched.
 *
 * Chunks go out concurrently: 2,354 assets is 48 requests, and sequentially
 * that is ~45 seconds of pure latency.
 */
export async function fetchAssetDecimals(
  ctx: ConnectorContext,
  assetIds: readonly number[],
  known: ReadonlyMap<number, number> = new Map(),
): Promise<{ decimals: Map<number, number>; sources: SourceRef[]; missing: number }> {
  const decimals = new Map<number, number>(known);
  const sources: SourceRef[] = [];
  const wanted = [...new Set(assetIds)].filter((id) => !decimals.has(id));

  const chunks: number[][] = [];
  for (let i = 0; i < wanted.length; i += ASSET_ID_CHUNK) {
    chunks.push(wanted.slice(i, i + ASSET_ID_CHUNK));
  }

  const pages = await Promise.all(
    chunks.map(async (ids) => {
      const url = assetsUrl(ids);
      const raw = await ctx.http.getJson(url).catch((err: unknown) => {
        ctx.log.warn({ err, url }, 'tinyman assets chunk failed after retries');
        return null;
      });
      const page = TinymanPageSchema.safeParse(raw);
      return page.success ? { url, results: page.data.results } : null;
    }),
  );

  for (const page of pages) {
    if (page === null) continue;
    sources.push({
      name: SOURCE_NAME,
      url: page.url,
      kind: 'rest',
      retrieved_at: ctx.now().toISOString(),
    });
    for (const row of page.results) {
      const asset = row as { id?: unknown; decimals?: unknown };
      if (typeof asset.id !== 'string' || typeof asset.decimals !== 'number') continue;
      decimals.set(Number(asset.id), asset.decimals);
    }
  }

  const missing = wanted.filter((id) => !decimals.has(id)).length;
  return { decimals, sources, missing };
}

/**
 * The 24h flows for a set of V2 pools, one analytics lookup each.
 *
 * This is the one place a V2 pool still needs the analytics API, and the
 * reason is stated in §3.3: on-chain local state has no notion of a 24h
 * window, so `volume_24h` and `gross_fees_24h` cannot be read from it. The
 * lookups are scoped to the pools that pass §3.6 — a few hundred rather than
 * 17,119 — because a pool excluded from every aggregate has no flow worth
 * spending a request on.
 *
 * A pool whose lookup fails keeps `flows: null`. It still contributes TVL and
 * is still counted in `coverage.entities`; what it does not do is contribute a
 * zero to `volume_24h`, which would be indistinguishable from a real quiet
 * pool (§1.5).
 */
export async function fetchV2Flows(
  ctx: ConnectorContext,
  addresses: readonly string[],
): Promise<{ flows: Map<string, TinymanV2Flows>; sources: SourceRef[]; failed: number }> {
  const flows = new Map<string, TinymanV2Flows>();
  const sources: SourceRef[] = [];
  let failed = 0;

  const results = await Promise.all(
    addresses.map(async (address) => {
      const url = poolByAddressUrl(address);
      const raw = await ctx.http.getJson(url).catch((err: unknown) => {
        ctx.log.warn({ err, address }, 'tinyman V2 flow lookup failed after retries');
        return null;
      });
      return { address, url, raw };
    }),
  );

  for (const { address, url, raw } of results) {
    if (raw === null) {
      failed++;
      continue;
    }
    const parsed = TinymanPoolSchema.safeParse(raw);
    if (!parsed.success) {
      failed++;
      ctx.log.warn({ address, issues: parsed.error.issues }, 'tinyman V2 flow record invalid');
      continue;
    }
    const pool = parsed.data;
    if (pool.last_day_volume_in_usd === null || pool.last_day_fees_in_usd === null) {
      // Present but null is still an absence. §3.3 forbids coercing it to 0.
      failed++;
      continue;
    }
    sources.push({ name: SOURCE_NAME, url, kind: 'rest', retrieved_at: ctx.now().toISOString() });
    flows.set(address, {
      volumeUsd: Number(pool.last_day_volume_in_usd),
      grossFeesUsd: Number(pool.last_day_fees_in_usd),
      liquidityUsd: pool.liquidity_in_usd === null ? null : Number(pool.liquidity_in_usd),
      isVerified: pool.is_verified,
    });
  }

  return { flows, sources, failed };
}
