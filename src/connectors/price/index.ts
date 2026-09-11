import type { Logger } from 'pino';
import { z } from 'zod';

import { MIN_PRICE_CONFIDENCE, MIN_PRICE_LIQUIDITY_USD } from '../../standardize/types.js';
import type { HttpClient, PriceEntry, PriceService, PriceTable } from '../types.js';

/**
 * DATA_SCHEMA.md §3.7 — the price service, and the ONLY sanctioned USD price
 * path (CONNECTOR_GUIDE.md §4.3).
 *
 * A five-rank ladder, first hit wins, resolved BEFORE `toFacts` so `toFacts`
 * stays pure. The output is a plain {@link PriceTable} — data, not an object
 * with methods — so a fixture file can *be* one and no supposedly-pure
 * computation can reach the network through it.
 *
 * Rank 5 is "unpriced": an explicit absence. Never a `0`, never a throw. A
 * missing entry is what lets §3.6.1 exclude the pool and count it in
 * `coverage.excluded`, which is a visible, auditable fact; a zero price would
 * quietly shrink every USD aggregate that touched the asset.
 *
 * ## Two corrections to §3.7, both verified live on 2026-09-08
 *
 * 1. **Rank 2 has no price field to read.** `/api/v1/assets/` publishes
 *    `liquidity_in_usd`, `last_day_volume_in_usd` and `last_day_price_change`,
 *    and no price. So the rank-2 price is *derived* from pool reserves —
 *    `current_asset_N_reserves_in_usd / (current_asset_N_reserves / 10^decimals)`
 *    — with the assets endpoint supplying exactly the gate §3.7 specifies:
 *    `liquidity_in_usd >= $50k`. "`liquidity_in_usd`-backed price" is what that
 *    phrase turns out to mean in practice.
 * 2. **Rank 4 is denominated in ALGO, not USD.** Vestige's `price` field is
 *    ALGO per unit: ALGO itself comes back as exactly `1.0` with confidence
 *    `1.0`, and USDC as `10.028` against a spot ALGO of ~$0.0997. Taking it as
 *    USD would have overstated every rank-4 asset by ~10x — the single largest
 *    silent error available in this file. It is converted with the ALGO price
 *    resolved from ranks 1-3, and if the guard below ever stops holding, rank 4
 *    is skipped entirely rather than trusted.
 *
 * ## The rank-5 confidence gate (methodology_version 1.1.0)
 *
 * A price the ladder itself grades below {@link MIN_PRICE_CONFIDENCE} is not a
 * price: the asset falls to rank 5 and every pool touching it is excluded and
 * counted. Vestige returns a `confidence` for assets nobody has traded in
 * years, and it can be 1e-10 — a number that still multiplies perfectly well
 * into a TVL. Until 1.1.0 the ladder's output only decided which pools were
 * *includable*, so a nonsense price cost nothing; now it multiplies on-chain
 * reserves, and two such rows produced $69.2 BILLION of phantom Tinyman TVL on
 * the verification run. The gate is what turns that from a silent corruption
 * into a visible exclusion.
 */

// ---------------------------------------------------------------------------
// Rank constants
// ---------------------------------------------------------------------------

/**
 * §3.7 rank 1. ONLY the stables §3.7 names: USDC and USDt. The list is short
 * on purpose — every id here is a price we have decided never to check, so it
 * is the one place in the ladder where being wrong is undetectable.
 */
export const STABLE_ASSET_IDS: Readonly<Record<number, string>> = Object.freeze({
  31566704: 'USDC',
  312769: 'USDt',
});

/** Algorand's native asset. §3.7 prices it by the same ladder as any ASA. */
export const ALGO_ASSET_ID = 0;

/** §3.7's "Confidence contribution" column, by rank. */
export const RANK_CONFIDENCE = Object.freeze({
  stable: 1.0,
  tinyman: 0.95,
  pact: 0.9,
  vestige: 0.85,
});

/** The `PriceEntry.source` label per rank — the ladder rung, on the record. */
export const RANK_SOURCE = Object.freeze({
  stable: 'stable-hardcode',
  tinyman: 'tinyman-pool-reserves',
  pact: 'pact-asset-price',
  vestige: 'vestige-assets-list',
});

/**
 * ARCHITECTURE.md §6 — prices cache for 60s, the shortest TTL in the system.
 *
 * The cache is per-ASSET, not per-call: `resolve` is asked for a different id
 * set every time, and a whole-table cache would miss on every one of them. A
 * hit costs no request, which is what lets `fetchRaw` consult the ladder to
 * scope its own work (§3.3) without paying for it twice.
 */
export const PRICE_CACHE_TTL_MS = 60_000;

const TINYMAN_BASE = 'https://mainnet.analytics.tinyman.org/api/v1';
const PACT_BASE = 'https://api.pact.fi/api';
const VESTIGE_BASE = 'https://api.vestigelabs.org';

const TINYMAN_PAGE_LIMIT = 1_000;
const PACT_PAGE_LIMIT = 1_000;
/** Vestige takes an `asset_ids` CSV; chunked to keep the URL a sane length. */
const VESTIGE_CHUNK = 50;
/** Tinyman's `/assets/?ids=` CSV, chunked for the same reason. */
const TINYMAN_ID_CHUNK = 50;

// ---------------------------------------------------------------------------
// Upstream schemas — validated at the boundary, like any other payload
// ---------------------------------------------------------------------------

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/);

const TinymanAssetSideSchema = z.object({
  id: z.string(),
  decimals: z.number().int().min(0).max(19),
});

const TinymanPoolSchema = z.object({
  asset_1: TinymanAssetSideSchema,
  asset_2: TinymanAssetSideSchema,
  current_asset_1_reserves: decimalString.nullable().default(null),
  current_asset_2_reserves: decimalString.nullable().default(null),
  current_asset_1_reserves_in_usd: decimalString.nullable().default(null),
  current_asset_2_reserves_in_usd: decimalString.nullable().default(null),
});

const TinymanPageSchema = z.object({ count: z.number().int(), results: z.array(z.unknown()) });

const TinymanAssetSchema = z.object({
  id: z.string(),
  liquidity_in_usd: decimalString.nullable().default(null),
});

const PactAssetSchema = z.object({
  id: z.number().int(),
  price: decimalString.nullable().default(null),
});

const PactPoolSchema = z.object({
  tvl_usd: decimalString.nullable().default(null),
  primary_asset: PactAssetSchema,
  secondary_asset: PactAssetSchema,
});

const PactPageSchema = z.object({ count: z.number().int(), results: z.array(z.unknown()) });

const VestigeAssetSchema = z.object({
  id: z.number().int(),
  price: z.number().nullable().default(null),
  confidence: z.number().nullable().default(null),
});

const VestigePageSchema = z.object({ results: z.array(z.unknown()) });

// ---------------------------------------------------------------------------
// Pure derivations — exported so the ladder's arithmetic is testable alone
// ---------------------------------------------------------------------------

/**
 * USD per whole unit from one side of a Tinyman pool.
 *
 * Returns null rather than a number whenever the inputs cannot support one:
 * a null reserve, an empty pool, or a non-finite result. This is the function
 * a `NaN` would enter the system through, so it refuses to emit one.
 */
export function derivePriceFromReserves(args: {
  reserves: string | null;
  reservesInUsd: string | null;
  decimals: number;
}): number | null {
  if (args.reserves === null || args.reservesInUsd === null) return null;
  const units = Number(args.reserves) / 10 ** args.decimals;
  const usd = Number(args.reservesInUsd);
  if (!Number.isFinite(units) || !Number.isFinite(usd) || units <= 0 || usd <= 0) return null;
  const price = usd / units;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Split ids into CSV-sized chunks.
 *
 * The chunks are then requested CONCURRENTLY, not in a `for` loop. That is a
 * one-word change worth ~45 seconds: 2,354 assets is 48 chunks, and at ~1s of
 * round-trip each a sequential walk spends 48s doing nothing but waiting.
 * `ctx.http` already caps per-host concurrency at 8 (§4.1), so firing all 48 is
 * polite — the semaphore, not the loop, is what protects the upstream.
 */
function chunk(ids: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push([...ids.slice(i, i + size)]);
  return out;
}

/**
 * Walk an offset-paginated `{ count, results }` catalogue, concurrently.
 *
 * Page 1 is fetched alone because it is the only thing that reports `count`;
 * every remaining page is then fetched at once. Both catalogues this walks are
 * 4-8 pages, so the difference is one round trip instead of eight — the same
 * ~10s the old sequential loop spent per ladder run, on every refresh.
 *
 * A page that fails after retries is skipped, not fatal: §3.7's rungs already
 * fall through to the next rank, and a dead page there costs coverage (visible,
 * counted) rather than the whole ladder.
 */
async function pagesOf<T extends { count: number; results: unknown[] }>(
  http: HttpClient,
  schema: z.ZodType<T>,
  urlFor: (offset: number) => string,
  limit: number,
): Promise<T[]> {
  const first = schema.safeParse(await http.getJson(urlFor(0)).catch(() => null));
  if (!first.success) return [];
  const offsets: number[] = [];
  for (let offset = limit; offset < first.data.count; offset += limit) offsets.push(offset);
  const rest = await Promise.all(
    offsets.map(async (offset) => schema.safeParse(await http.getJson(urlFor(offset)).catch(() => null))),
  );
  return [first.data, ...rest.flatMap((r) => (r.success ? [r.data] : []))];
}

/** A rank-4 Vestige quote converted out of its ALGO denomination (see header). */
export function vestigeToUsd(priceInAlgo: number, algoUsd: number): number | null {
  const usd = priceInAlgo * algoUsd;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface PriceServiceDeps {
  readonly http: HttpClient;
  readonly log: Logger;
  readonly now: () => Date;
}

/** A price candidate before it becomes a {@link PriceEntry}. */
interface Candidate {
  usd: number;
  /** USD depth backing this quote — used to pick between competing pools. */
  depth: number;
}

/** One cached rung result. `entry` is null for "the ladder found nothing". */
interface CacheSlot {
  readonly entry: PriceEntry | null;
  readonly at: number;
}

export function createPriceService(deps: PriceServiceDeps): PriceService {
  const { http, log, now } = deps;
  const cache = new Map<number, CacheSlot>();

  return {
    async resolve(assetIds: readonly number[]): Promise<PriceTable> {
      // ALGO is always resolved, whether or not it was asked for: rank 4 is
      // denominated in it, so without an ALGO price the whole rung is dead.
      const wanted = new Set<number>([...assetIds, ALGO_ASSET_ID]);
      const prices: Record<number, PriceEntry> = {};
      const nowMs = now().getTime();
      /** Assets a live cache slot already answered — including "unpriced". */
      const cached = new Set<number>();

      for (const id of wanted) {
        const slot = cache.get(id);
        if (slot === undefined || nowMs - slot.at >= PRICE_CACHE_TTL_MS) continue;
        cached.add(id);
        // A cached *absence* is as load-bearing as a cached price: it is what
        // stops a re-resolve from paying for the whole ladder again to
        // rediscover that 2,000 dust assets are still unpriced.
        if (slot.entry !== null) prices[id] = slot.entry;
      }

      const pending = (): number[] =>
        [...wanted].filter((id) => prices[id] === undefined && !cached.has(id));

      // ---- Rank 1: hardcoded stables ------------------------------------
      for (const id of pending()) {
        if (Object.hasOwn(STABLE_ASSET_IDS, id)) {
          prices[id] = { usd: 1, confidence: RANK_CONFIDENCE.stable, source: RANK_SOURCE.stable };
        }
      }

      // ---- Rank 2: Tinyman -----------------------------------------------
      if (pending().length > 0) {
        try {
          const eligible = await tinymanEligibleAssets(http, pending());
          if (eligible.size > 0) {
            const derived = await tinymanDerivedPrices(http, eligible);
            for (const [id, candidate] of derived) {
              prices[id] = {
                usd: candidate.usd,
                confidence: RANK_CONFIDENCE.tinyman,
                source: RANK_SOURCE.tinyman,
              };
            }
          }
        } catch (err) {
          // A dead rung is not a dead ladder: fall through to rank 3. Throwing
          // here would turn one slow upstream into an unpriced catalogue.
          log.warn({ err }, 'price ladder rank 2 (tinyman) failed; falling through');
        }
      }

      // ---- Rank 3: Pact ---------------------------------------------------
      if (pending().length > 0) {
        try {
          const derived = await pactPrices(http, new Set(pending()));
          for (const [id, candidate] of derived) {
            prices[id] = {
              usd: candidate.usd,
              confidence: RANK_CONFIDENCE.pact,
              source: RANK_SOURCE.pact,
            };
          }
        } catch (err) {
          log.warn({ err }, 'price ladder rank 3 (pact) failed; falling through');
        }
      }

      // ---- Rank 4: Vestige, ALGO-denominated ------------------------------
      const algo = prices[ALGO_ASSET_ID];
      const stillPending = pending();
      if (stillPending.length > 0) {
        if (algo === undefined) {
          log.warn(
            'price ladder rank 4 (vestige) skipped: its quotes are ALGO-denominated and ALGO is unpriced by ranks 1-3',
          );
        } else {
          try {
            const quotes = await vestigeQuotes(http, stillPending, log);
            for (const [id, quote] of quotes) {
              const usd = vestigeToUsd(quote.price, algo.usd);
              if (usd === null) continue;
              prices[id] = {
                usd,
                // §3.7: "carries its own `confidence` field, which we MULTIPLY
                // into ours". The upstream's own doubt is not ours to discard.
                confidence: RANK_CONFIDENCE.vestige * quote.confidence,
                source: RANK_SOURCE.vestige,
              };
            }
          } catch (err) {
            log.warn({ err }, 'price ladder rank 4 (vestige) failed');
          }
        }
      }

      // ---- The rank-5 confidence gate --------------------------------------
      // Applied to every rung, not only to Vestige: a rung that ever starts
      // handing back near-zero confidence should fall out of the ladder by the
      // same rule, rather than by a patch written after it corrupts a total.
      let gated = 0;
      for (const [id, entry] of Object.entries(prices)) {
        if (entry.confidence >= MIN_PRICE_CONFIDENCE) continue;
        delete prices[Number(id)];
        gated++;
        log.debug(
          { assetId: Number(id), confidence: entry.confidence, source: entry.source },
          'price rejected below MIN_PRICE_CONFIDENCE; asset falls to §3.7 rank 5',
        );
      }

      // ---- Rank 5: unpriced ------------------------------------------------
      // Nothing to do, and that is the point. An asset with no entry is
      // absent, not zero (§3.6.1).
      const unpriced = pending();
      if (unpriced.length > 0 || gated > 0) {
        log.debug(
          { unpriced: unpriced.length, gated },
          'assets unpriced after the §3.7 ladder (rank 5)',
        );
      }

      const at = now().getTime();
      for (const id of wanted) {
        if (cached.has(id)) continue;
        cache.set(id, { entry: prices[id] ?? null, at });
      }

      return Object.freeze({ asOf: now().toISOString(), prices: Object.freeze(prices) });
    },
  };
}

// ---------------------------------------------------------------------------
// Rank 2 — Tinyman
// ---------------------------------------------------------------------------

/**
 * The §3.7 rank-2 gate: assets with at least `MIN_PRICE_LIQUIDITY_USD` of
 * liquidity, per the Tinyman assets endpoint.
 *
 * Applied *before* any price is derived, so a thin asset never reaches the
 * arithmetic at all. `?ids=` is a real filter on this endpoint (verified
 * 2026-09-08) — without it the gate would cost 36 pages of the 35,250-asset
 * catalogue to answer a question about a dozen assets.
 */
async function tinymanEligibleAssets(
  http: HttpClient,
  assetIds: readonly number[],
): Promise<Set<number>> {
  const eligible = new Set<number>();
  const pages = await Promise.all(
    chunk(assetIds, TINYMAN_ID_CHUNK).map(async (ids) => {
      const url = `${TINYMAN_BASE}/assets/?ids=${ids.join(',')}&limit=${ids.length}`;
      return TinymanPageSchema.safeParse(await http.getJson(url).catch(() => null));
    }),
  );
  for (const page of pages) {
    if (!page.success) continue;
    for (const row of page.data.results) {
      const asset = TinymanAssetSchema.safeParse(row);
      if (!asset.success || asset.data.liquidity_in_usd === null) continue;
      if (Number(asset.data.liquidity_in_usd) >= MIN_PRICE_LIQUIDITY_USD) {
        eligible.add(Number(asset.data.id));
      }
    }
  }
  return eligible;
}

/**
 * Derive a USD price for each eligible asset from the deepest pool side that
 * holds it. Depth breaks ties because a quote from a $2M reserve is simply a
 * better measurement of the same quantity than one from a $60k reserve.
 */
async function tinymanDerivedPrices(
  http: HttpClient,
  eligible: ReadonlySet<number>,
): Promise<Map<number, Candidate>> {
  const best = new Map<number, Candidate>();
  const consider = (id: number, candidate: Candidate | null): void => {
    if (candidate === null || !eligible.has(id)) return;
    const current = best.get(id);
    if (current === undefined || candidate.depth > current.depth) best.set(id, candidate);
  };

  for (const page of await pagesOf(http, TinymanPageSchema, (offset) =>
    `${TINYMAN_BASE}/pools/?limit=${TINYMAN_PAGE_LIMIT}&offset=${offset}`, TINYMAN_PAGE_LIMIT)) {
    for (const row of page.results) {
      const parsed = TinymanPoolSchema.safeParse(row);
      if (!parsed.success) continue;
      const pool = parsed.data;
      for (const side of [1, 2] as const) {
        const asset = side === 1 ? pool.asset_1 : pool.asset_2;
        const reserves = side === 1 ? pool.current_asset_1_reserves : pool.current_asset_2_reserves;
        const reservesInUsd =
          side === 1 ? pool.current_asset_1_reserves_in_usd : pool.current_asset_2_reserves_in_usd;
        const usd = derivePriceFromReserves({ reserves, reservesInUsd, decimals: asset.decimals });
        consider(
          Number(asset.id),
          usd === null ? null : { usd, depth: Number(reservesInUsd ?? 0) },
        );
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rank 3 — Pact
// ---------------------------------------------------------------------------

/**
 * §3.7 rank 3: `primary_asset.price` / `secondary_asset.price`, for assets in a
 * pool with at least `MIN_PRICE_LIQUIDITY_USD` of `tvl_usd`.
 *
 * The gate is doing real work: Pact quotes goUSD at `0.60` inside a pool with
 * $2.8k of TVL (verified 2026-09-08), which is a dollar-pegged asset priced 40%
 * off by a pool too thin to mean anything.
 */
async function pactPrices(
  http: HttpClient,
  wanted: ReadonlySet<number>,
): Promise<Map<number, Candidate>> {
  const best = new Map<number, Candidate>();
  const consider = (id: number, price: string | null, depth: number): void => {
    if (price === null || !wanted.has(id)) return;
    const usd = Number(price);
    if (!Number.isFinite(usd) || usd <= 0) return;
    const current = best.get(id);
    if (current === undefined || depth > current.depth) best.set(id, { usd, depth });
  };

  for (const page of await pagesOf(http, PactPageSchema, (offset) =>
    `${PACT_BASE}/pools?limit=${PACT_PAGE_LIMIT}&offset=${offset}`, PACT_PAGE_LIMIT)) {
    for (const row of page.results) {
      const parsed = PactPoolSchema.safeParse(row);
      if (!parsed.success || parsed.data.tvl_usd === null) continue;
      const tvl = Number(parsed.data.tvl_usd);
      if (!Number.isFinite(tvl) || tvl < MIN_PRICE_LIQUIDITY_USD) continue;
      consider(parsed.data.primary_asset.id, parsed.data.primary_asset.price, tvl);
      consider(parsed.data.secondary_asset.id, parsed.data.secondary_asset.price, tvl);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rank 4 — Vestige
// ---------------------------------------------------------------------------

interface VestigeQuote {
  /** ALGO per whole unit — see the file header. */
  price: number;
  /** The upstream's own confidence, multiplied into ours per §3.7. */
  confidence: number;
}

/**
 * Confirm rank 4 is still ALGO-denominated, with one request for one asset.
 *
 * Done separately, and once, rather than by looking for ALGO inside each
 * chunk's response: `assets/list` applies a default page limit, so on a large
 * `asset_ids` request the ALGO row can simply fall off the end — which would
 * read as "the denomination changed" and silently disable the whole rung. The
 * guard has to be a question we ask on its own.
 */
async function vestigeAlgoDenominated(http: HttpClient, log: Logger): Promise<boolean> {
  const page = VestigePageSchema.safeParse(
    await http.getJson(`${VESTIGE_BASE}/assets/list?asset_ids=${ALGO_ASSET_ID}&limit=2`),
  );
  if (!page.success) return false;
  const algo = page.data.results
    .map((row) => VestigeAssetSchema.safeParse(row))
    .find((r) => r.success && r.data.id === ALGO_ASSET_ID);
  if (algo?.success !== true || algo.data.price !== 1) {
    log.warn(
      { algoPrice: algo?.success === true ? algo.data.price : null },
      'vestige ALGO quote is not 1.0; its prices may no longer be ALGO-denominated — skipping rank 4',
    );
    return false;
  }
  return true;
}

async function vestigeQuotes(
  http: HttpClient,
  assetIds: readonly number[],
  log: Logger,
): Promise<Map<number, VestigeQuote>> {
  const quotes = new Map<number, VestigeQuote>();
  if (!(await vestigeAlgoDenominated(http, log))) return quotes;

  const pages = await Promise.all(
    chunk(assetIds, VESTIGE_CHUNK).map(async (ids) => {
      // An explicit limit: without one the endpoint truncates to its own
      // default page size and the tail of the chunk comes back silently
      // unpriced.
      const url = `${VESTIGE_BASE}/assets/list?asset_ids=${ids.join(',')}&limit=${ids.length}`;
      return VestigePageSchema.safeParse(await http.getJson(url).catch(() => null));
    }),
  );
  for (const page of pages) {
    if (!page.success) continue;

    for (const row of page.data.results) {
      const parsed = VestigeAssetSchema.safeParse(row);
      if (!parsed.success) continue;
      const asset = parsed.data;
      if (asset.id === ALGO_ASSET_ID) continue;
      if (asset.price === null || asset.price <= 0) continue;
      if (asset.confidence === null || asset.confidence <= 0) continue;
      quotes.set(asset.id, { price: asset.price, confidence: Math.min(asset.confidence, 1) });
    }
  }
  return quotes;
}
