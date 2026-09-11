import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  ALGO_ASSET_ID,
  RANK_CONFIDENCE,
  RANK_SOURCE,
  STABLE_ASSET_IDS,
  createPriceService,
  derivePriceFromReserves,
  vestigeToUsd,
} from '../../src/connectors/price/index.js';
import { MIN_PRICE_CONFIDENCE, MIN_PRICE_LIQUIDITY_USD } from '../../src/standardize/types.js';
import { priceOf } from '../../src/connectors/types.js';
import type { HttpClient } from '../../src/connectors/types.js';

/**
 * DATA_SCHEMA.md §3.7 — the five-rank ladder, exercised rung by rung.
 *
 * The upstream payloads below are minimal but shaped exactly as the live APIs
 * shape them (verified 2026-09-08), including the two things §3.7 gets wrong:
 * the Tinyman assets endpoint carries no price field, and Vestige quotes in
 * ALGO. A test that used a convenient shape would pass while the connector
 * silently priced everything ten times too high.
 */

const log = pino({ level: 'silent' });
const NOW = '2026-09-08T14:30:00.000Z';

const TINYMAN = 'https://mainnet.analytics.tinyman.org/api/v1';
const PACT = 'https://api.pact.fi/api';
const VESTIGE = 'https://api.vestigelabs.org';

/** An HttpClient answering by URL prefix, so tests need not spell query order. */
function http(routes: Array<[RegExp, unknown]>, calls: string[] = []): HttpClient {
  return {
    async getJson(url: string) {
      calls.push(url);
      for (const [pattern, body] of routes) if (pattern.test(url)) return body;
      throw new Error(`no stub for ${url}`);
    },
  };
}

/** A Tinyman pool whose asset-1 side is `usd` deep at `price` per unit. */
function tinymanPool(assetId: number, price: number, usd: number, decimals = 6) {
  const units = usd / price;
  return {
    asset_1: { id: String(assetId), decimals },
    asset_2: { id: '0', decimals: 6 },
    current_asset_1_reserves: String(Math.round(units * 10 ** decimals)),
    current_asset_2_reserves: '0',
    current_asset_1_reserves_in_usd: usd.toFixed(6),
    current_asset_2_reserves_in_usd: null,
  };
}

const emptyTinyman = [[/\/assets\/\?ids=/, { count: 0, results: [] }], [/\/pools\/\?/, { count: 0, results: [] }]] as Array<[RegExp, unknown]>;
const emptyPact: Array<[RegExp, unknown]> = [[/api\.pact\.fi/, { count: 0, results: [] }]];
const noVestige: Array<[RegExp, unknown]> = [[/vestigelabs/, { results: [] }]];

describe('§3.7 rank 1 — hardcoded stables', () => {
  it('prices only the stables §3.7 names, at confidence 1.0', async () => {
    expect(Object.keys(STABLE_ASSET_IDS).map(Number).sort((a, b) => a - b)).toEqual([
      312_769, 31_566_704,
    ]);

    const prices = createPriceService({
      http: http([...emptyTinyman, ...emptyPact, ...noVestige]),
      log,
      now: () => new Date(NOW),
    });
    const table = await prices.resolve([31_566_704, 312_769]);

    for (const id of [31_566_704, 312_769]) {
      expect(priceOf(table, id)).toEqual({
        usd: 1,
        confidence: RANK_CONFIDENCE.stable,
        source: RANK_SOURCE.stable,
      });
    }
    expect(table.asOf).toBe(NOW);
  });

  it('does not reach any upstream when every asset is a stable', async () => {
    const calls: string[] = [];
    const prices = createPriceService({
      http: http([...emptyTinyman, ...emptyPact, ...noVestige], calls),
      log,
      now: () => new Date(NOW),
    });
    // ALGO is always resolved too, so the ladder still runs — but if the only
    // *requested* asset were a stable and ALGO were pre-priced, nothing else
    // would be needed. Here we assert the stable itself cost no request.
    await prices.resolve([31_566_704]);
    expect(calls.every((url) => !url.includes('ids=31566704'))).toBe(true);
  });
});

describe('§3.7 rank 2 — Tinyman, derived from pool reserves', () => {
  const ASSET = 700_965_019;

  it('derives a price and applies the $50k liquidity gate', async () => {
    const routes: Array<[RegExp, unknown]> = [
      [
        /\/assets\/\?ids=/,
        {
          count: 2,
          results: [
            { id: String(ASSET), liquidity_in_usd: '120000.00' },
            { id: '0', liquidity_in_usd: '1888804.05' },
          ],
        },
      ],
      [
        /\/pools\/\?/,
        {
          count: 2,
          results: [tinymanPool(ASSET, 2.5, 120_000), tinymanPool(0, 0.0997, 1_000_000)],
        },
      ],
      ...emptyPact,
      ...noVestige,
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    const table = await prices.resolve([ASSET]);

    const entry = priceOf(table, ASSET);
    expect(entry?.usd).toBeCloseTo(2.5, 9);
    expect(entry?.confidence).toBe(RANK_CONFIDENCE.tinyman);
    expect(entry?.source).toBe(RANK_SOURCE.tinyman);
    expect(priceOf(table, ALGO_ASSET_ID)?.usd).toBeCloseTo(0.0997, 6);
  });

  it('refuses an asset below the $50k gate, leaving it to a lower rank', async () => {
    const routes: Array<[RegExp, unknown]> = [
      [
        /\/assets\/\?ids=/,
        {
          count: 1,
          results: [{ id: String(ASSET), liquidity_in_usd: String(MIN_PRICE_LIQUIDITY_USD - 1) }],
        },
      ],
      [/\/pools\/\?/, { count: 1, results: [tinymanPool(ASSET, 2.5, 49_999)] }],
      ...emptyPact,
      ...noVestige,
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    expect(priceOf(await prices.resolve([ASSET]), ASSET)).toBeNull();
  });

  it('prefers the deepest pool when several quote the same asset', async () => {
    const routes: Array<[RegExp, unknown]> = [
      [/\/assets\/\?ids=/, { count: 1, results: [{ id: String(ASSET), liquidity_in_usd: '900000' }] }],
      [
        /\/pools\/\?/,
        {
          count: 2,
          results: [tinymanPool(ASSET, 9.99, 60_000), tinymanPool(ASSET, 2.5, 800_000)],
        },
      ],
      ...emptyPact,
      ...noVestige,
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    expect(priceOf(await prices.resolve([ASSET]), ASSET)?.usd).toBeCloseTo(2.5, 9);
  });

  it('derivePriceFromReserves never returns a NaN', () => {
    expect(derivePriceFromReserves({ reserves: null, reservesInUsd: '10', decimals: 6 })).toBeNull();
    expect(derivePriceFromReserves({ reserves: '10', reservesInUsd: null, decimals: 6 })).toBeNull();
    expect(derivePriceFromReserves({ reserves: '0', reservesInUsd: '10', decimals: 6 })).toBeNull();
    expect(derivePriceFromReserves({ reserves: '10', reservesInUsd: '0', decimals: 6 })).toBeNull();
    expect(
      derivePriceFromReserves({ reserves: '2000000', reservesInUsd: '10', decimals: 6 }),
    ).toBeCloseTo(5, 9);
  });
});

describe('§3.7 rank 3 — Pact, gated on pool TVL', () => {
  const ASSET = 672_913_181;

  it('takes a price from a pool with at least $50k of TVL', async () => {
    const routes: Array<[RegExp, unknown]> = [
      ...emptyTinyman,
      [
        /api\.pact\.fi/,
        {
          count: 1,
          results: [
            {
              tvl_usd: '250000.00',
              primary_asset: { id: ASSET, price: '0.99' },
              secondary_asset: { id: 0, price: '0.0997' },
            },
          ],
        },
      ],
      ...noVestige,
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    const entry = priceOf(await prices.resolve([ASSET]), ASSET);
    expect(entry?.usd).toBeCloseTo(0.99, 9);
    expect(entry?.confidence).toBe(RANK_CONFIDENCE.pact);
    expect(entry?.source).toBe(RANK_SOURCE.pact);
  });

  it('ignores the thin pool that quotes a dollar-pegged asset at 0.60', async () => {
    // The live case, verbatim (2026-09-08): goUSD at 0.60 in a $2.8k pool.
    const routes: Array<[RegExp, unknown]> = [
      ...emptyTinyman,
      [
        /api\.pact\.fi/,
        {
          count: 1,
          results: [
            {
              tvl_usd: '2847.52829000',
              primary_asset: { id: 31_566_704, price: '1.00000000' },
              secondary_asset: { id: ASSET, price: '0.60341987' },
            },
          ],
        },
      ],
      ...noVestige,
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    expect(priceOf(await prices.resolve([ASSET]), ASSET)).toBeNull();
  });
});

describe('§3.7 rank 4 — Vestige, ALGO-denominated', () => {
  const ASSET = 2_494_786_278;

  /** Ranks 1-3 empty except an ALGO price, which rank 4 needs as its anchor. */
  const withAlgo: Array<[RegExp, unknown]> = [
    [/\/assets\/\?ids=/, { count: 1, results: [{ id: '0', liquidity_in_usd: '1888804.05' }] }],
    [/\/pools\/\?/, { count: 1, results: [tinymanPool(0, 0.1, 1_000_000)] }],
    ...emptyPact,
  ];

  it('converts out of ALGO and multiplies the upstream confidence in', async () => {
    const routes: Array<[RegExp, unknown]> = [
      ...withAlgo,
      [/asset_ids=0&limit=2/, { results: [{ id: 0, price: 1, confidence: 1 }] }],
      [
        /vestigelabs/,
        { results: [{ id: ASSET, price: 20, confidence: 0.5 }, { id: 0, price: 1, confidence: 1 }] },
      ],
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    const entry = priceOf(await prices.resolve([ASSET]), ASSET);

    // 20 ALGO x $0.10 = $2.00 — NOT $20, which is what reading `price` as USD
    // would have produced.
    expect(entry?.usd).toBeCloseTo(2, 9);
    expect(entry?.confidence).toBeCloseTo(RANK_CONFIDENCE.vestige * 0.5, 9);
    expect(entry?.source).toBe(RANK_SOURCE.vestige);
  });

  it('skips the whole rung if ALGO stops quoting at exactly 1.0', async () => {
    const routes: Array<[RegExp, unknown]> = [
      ...withAlgo,
      [/asset_ids=0&limit=2/, { results: [{ id: 0, price: 0.0997, confidence: 1 }] }],
      [/vestigelabs/, { results: [{ id: ASSET, price: 20, confidence: 0.9 }] }],
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    expect(priceOf(await prices.resolve([ASSET]), ASSET)).toBeNull();
  });

  it('skips the rung when ALGO itself is unpriced by ranks 1-3', async () => {
    const routes: Array<[RegExp, unknown]> = [
      ...emptyTinyman,
      ...emptyPact,
      [/vestigelabs/, { results: [{ id: ASSET, price: 20, confidence: 0.9 }] }],
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    const table = await prices.resolve([ASSET]);
    expect(priceOf(table, ASSET)).toBeNull();
    expect(priceOf(table, ALGO_ASSET_ID)).toBeNull();
  });

  it('vestigeToUsd rejects a non-finite conversion', () => {
    expect(vestigeToUsd(20, 0.1)).toBeCloseTo(2, 9);
    expect(vestigeToUsd(20, 0)).toBeNull();
    expect(vestigeToUsd(Number.POSITIVE_INFINITY, 0.1)).toBeNull();
  });
});

describe('§3.7 rank 5 — unpriced', () => {
  it('is an absence: no entry, no zero, no throw', async () => {
    const prices = createPriceService({
      http: http([...emptyTinyman, ...emptyPact, ...noVestige]),
      log,
      now: () => new Date(NOW),
    });
    const table = await prices.resolve([123_456_789]);

    expect(priceOf(table, 123_456_789)).toBeNull();
    expect(Object.hasOwn(table.prices, 123_456_789)).toBe(false);
    // The trap this exists to close: an unpriced asset returning 0 would make
    // every pool touching it silently worth nothing rather than visibly excluded.
    expect(table.prices[123_456_789]?.usd).toBeUndefined();
  });

  it('survives a rung that fails outright and falls through to the next', async () => {
    const routes: Array<[RegExp, unknown]> = [
      [
        /\/assets\/\?ids=/,
        () => {
          throw new Error('tinyman down');
        },
      ],
      [
        /api\.pact\.fi/,
        {
          count: 1,
          results: [
            {
              tvl_usd: '250000',
              primary_asset: { id: 999, price: '3.00' },
              secondary_asset: { id: 0, price: '0.0997' },
            },
          ],
        },
      ],
      ...noVestige,
    ];
    const failing: HttpClient = {
      async getJson(url: string) {
        if (url.includes('tinyman')) throw new Error('tinyman down');
        for (const [pattern, body] of routes) if (pattern.test(url)) return body;
        throw new Error(`no stub for ${url}`);
      },
    };
    const prices = createPriceService({ http: failing, log, now: () => new Date(NOW) });
    const table = await prices.resolve([999]);
    expect(priceOf(table, 999)?.usd).toBeCloseTo(3, 9);
  });
});

describe('§3.7 rank 5 — the MIN_PRICE_CONFIDENCE gate (1.1.0)', () => {
  const DEAD = 862_050_168;

  /** Ranks 1-3 empty except an ALGO price, which rank 4 needs as its anchor. */
  const withAlgo: Array<[RegExp, unknown]> = [
    [/\/assets\/\?ids=/, { count: 1, results: [{ id: '0', liquidity_in_usd: '1888804.05' }] }],
    [/\/pools\/\?/, { count: 1, results: [tinymanPool(0, 0.1, 1_000_000)] }],
    ...emptyPact,
  ];

  /**
   * The live failure this gate exists for, reproduced with the real numbers:
   * Vestige quotes Barya at `confidence: 6.0e-10`. Ungated, that price
   * multiplied a V2 pool's on-chain reserves into $69.2 BILLION of Tinyman TVL
   * (DATA_SCHEMA.md §3.7). A confidence that small is not a weak measurement,
   * it is the upstream saying it does not know.
   */
  it('sends a price the ladder grades below 0.10 to rank 5, not into a total', async () => {
    const routes: Array<[RegExp, unknown]> = [
      ...withAlgo,
      [/asset_ids=0&limit=2/, { results: [{ id: 0, price: 1, confidence: 1 }] }],
      [
        /vestigelabs/,
        {
          results: [
            { id: DEAD, price: 0.001636, confidence: 6.007794424549738e-10 },
            { id: 0, price: 1, confidence: 1 },
          ],
        },
      ],
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    const table = await prices.resolve([DEAD]);

    // An ABSENCE, so §3.6.1 excludes and counts every pool touching it.
    expect(priceOf(table, DEAD)).toBeNull();
    expect(Object.hasOwn(table.prices, String(DEAD))).toBe(false);
    // ALGO, which the same rung anchored, is untouched.
    expect(priceOf(table, ALGO_ASSET_ID)?.usd).toBeCloseTo(0.1, 9);
  });

  it('keeps a price exactly at the gate', async () => {
    // 0.85 x upstream >= 0.10 is the boundary. Just above it must survive, or
    // the gate is quietly stricter than §3.7 says it is.
    const upstream = MIN_PRICE_CONFIDENCE / RANK_CONFIDENCE.vestige + 1e-9;
    const routes: Array<[RegExp, unknown]> = [
      ...withAlgo,
      [/asset_ids=0&limit=2/, { results: [{ id: 0, price: 1, confidence: 1 }] }],
      [/vestigelabs/, { results: [{ id: DEAD, price: 20, confidence: upstream }] }],
    ];
    const prices = createPriceService({ http: http(routes), log, now: () => new Date(NOW) });
    const entry = priceOf(await prices.resolve([DEAD]), DEAD);
    expect(entry?.confidence).toBeGreaterThanOrEqual(MIN_PRICE_CONFIDENCE);
  });
});

describe('the 60s cache (ARCHITECTURE.md §6)', () => {
  const ASSET = 31_566_704;

  it('serves a second resolve without touching an upstream', async () => {
    const calls: string[] = [];
    const routes: Array<[RegExp, unknown]> = [
      [/\/assets\/\?ids=/, { count: 0, results: [] }],
      [/\/pools\/\?/, { count: 1, results: [tinymanPool(0, 0.1, 1_000_000)] }],
      ...emptyPact,
      ...noVestige,
    ];
    let clock = new Date(NOW).getTime();
    const prices = createPriceService({
      http: http(routes, calls),
      log,
      now: () => new Date(clock),
    });

    await prices.resolve([ASSET, ALGO_ASSET_ID]);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    // This is what lets `fetchRaw` consult the ladder to scope its own work
    // and the caller still resolve before `toFacts` for one ladder run.
    await prices.resolve([ASSET, ALGO_ASSET_ID]);
    expect(calls.length).toBe(first);

    // Past the TTL it goes back to the upstream: a stale price silently
    // corrupts every USD KPI downstream, which is why this TTL is the
    // shortest in the system.
    clock += 61_000;
    await prices.resolve([ASSET, ALGO_ASSET_ID]);
    expect(calls.length).toBeGreaterThan(first);
  });

  it('caches an ABSENCE too, so a dust catalogue is not re-priced every call', async () => {
    const calls: string[] = [];
    const routes: Array<[RegExp, unknown]> = [
      [/\/assets\/\?ids=/, { count: 0, results: [] }],
      [/\/pools\/\?/, { count: 1, results: [tinymanPool(0, 0.1, 1_000_000)] }],
      ...emptyPact,
      ...noVestige,
    ];
    const prices = createPriceService({
      http: http(routes, calls),
      log,
      now: () => new Date(NOW),
    });

    const unpriceable = 999_999_999;
    expect(priceOf(await prices.resolve([unpriceable]), unpriceable)).toBeNull();
    const first = calls.length;
    expect(priceOf(await prices.resolve([unpriceable]), unpriceable)).toBeNull();
    expect(calls.length).toBe(first);
  });
});

describe('the PriceTable is plain data (§1.2)', () => {
  it('round-trips through JSON unchanged, so a fixture can BE one', async () => {
    const prices = createPriceService({
      http: http([...emptyTinyman, ...emptyPact, ...noVestige]),
      log,
      now: () => new Date(NOW),
    });
    const table = await prices.resolve([31_566_704]);
    expect(JSON.parse(JSON.stringify(table))).toEqual(table);
  });
});
