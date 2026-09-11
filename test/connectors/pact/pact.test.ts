import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  assertCashFlowIdentity,
  includePool,
  pactConnector,
  protocolShareOf,
  splitFees,
  valuePool,
} from '../../../src/connectors/pact/index.js';
import type { PoolValue } from '../../../src/connectors/pact/index.js';
import { POOL_PAGE_LIMIT, poolPageUrl } from '../../../src/connectors/pact/enumerate.js';
import { isPoolEntity, isPriced, type PactPoolEntity } from '../../../src/connectors/pact/schema.js';
import { FROZEN_NOW } from '../../../src/connectors/testing.js';
import type { RawSnapshot, ToFactsOpts } from '../../../src/connectors/types.js';
import { KpiFactSchema, isSuccessFact } from '../../../src/standardize/schema.js';
import type { KpiFact, KpiId } from '../../../src/standardize/schema.js';
import { DEFAULT_BASIS, MIN_TVL_USD } from '../../../src/standardize/types.js';
import {
  loadRecordedPools,
  makeFixtureContext,
  recordedPages,
  splitPool,
} from '../../fixtures/pact/recorded.js';

/**
 * CONNECTOR_GUIDE.md §Step 6 — the seven required tests for the Pact connector,
 * over fixtures recorded from the live API on 2026-09-09.
 *
 * The golden test is the one that matters most: it is the difference between
 * "our methodology is documented" and "our methodology is enforced". Regenerate
 * it with `UPDATE_GOLDEN=1 npx vitest run test/connectors/pact`, and read the
 * diff — a change there is a change to what buyers are paying for.
 */

const GOLDEN = path.resolve('test/fixtures/pact/expected-facts.json');
const METHODOLOGY_VERSION = '1.1.0';
const DECLARED = pactConnector.capabilities().kpis;

function toFactsOpts(overrides: Partial<ToFactsOpts> = {}): ToFactsOpts {
  return {
    basis: DEFAULT_BASIS,
    kpis: DECLARED,
    // Pact publishes its own USD figures, so nothing here consults the §3.7
    // ladder — an empty table is not a degraded case for this connector, it is
    // the normal one, and `priceAssets` is correspondingly absent.
    prices: { asOf: FROZEN_NOW, prices: {} },
    now: FROZEN_NOW,
    methodologyVersion: METHODOLOGY_VERSION,
    ...overrides,
  };
}

const factFor = (facts: readonly KpiFact[], metric: KpiId): KpiFact | undefined =>
  facts.find((f) => f.metric === metric);

let snapshot: RawSnapshot;
let facts: KpiFact[];

beforeAll(async () => {
  snapshot = await pactConnector.fetchRaw(makeFixtureContext(), {
    basis: DEFAULT_BASIS,
    kpis: DECLARED,
  });
  facts = pactConnector.toFacts(snapshot, toFactsOpts());
});

// ---------------------------------------------------------------------------
// fetchRaw — the §3.4 walk
// ---------------------------------------------------------------------------

describe('fetchRaw', () => {
  it('pages exhaustively and collects every recorded pool', () => {
    const pools = (snapshot.entities as unknown[]).filter(isPoolEntity);
    const expected = recordedPages().reduce((n, p) => n + p.results.length, 0);
    expect(pools.length).toBe(expected);
    expect(snapshot.partial).toBe(false);
  });

  /**
   * The quirk this connector is shaped around, asserted rather than described.
   *
   * The fixture echoes `limit: 40` while `fetchRaw` requests `limit=500`. A
   * walk striding by what it requested would fetch offset 500 and stop; one
   * striding by what the server echoed fetches 40 and 80. Against the live API
   * the same mistake reads 2,000 of 3,961 pools without any error at all.
   */
  it('strides by the limit the SERVER echoed, not the one it requested', () => {
    const stride = recordedPages()[0]?.limit ?? 0;
    expect(stride).toBeLessThan(POOL_PAGE_LIMIT);

    const ctx = makeFixtureContext();
    const calls = (ctx.http as { calls: string[] }).calls;
    return pactConnector
      .fetchRaw(ctx, { basis: DEFAULT_BASIS, kpis: DECLARED })
      .then(() => {
        expect(calls).toContain(poolPageUrl(stride));
        expect(calls).toContain(poolPageUrl(stride * 2));
        expect(calls).not.toContain(poolPageUrl(POOL_PAGE_LIMIT));
      });
  });

  it('records the exact URLs it fetched', () => {
    expect(snapshot.sources.length).toBe(recordedPages().length);
    for (const source of snapshot.sources) {
      expect(source.url).toMatch(/^https:\/\/api\.pact\.fi\/api\/pools\?limit=\d+&offset=\d+$/);
      expect(source.kind).toBe('rest');
    }
  });

  it('does no arithmetic: entities carry the upstream strings verbatim', () => {
    const pools = (snapshot.entities as unknown[]).filter(isPoolEntity);
    for (const entity of pools.slice(0, 10)) {
      expect(typeof entity.pool.tvl_usd).toBe('string');
      expect(typeof entity.pool.volume_24h).toBe('string');
      expect(typeof entity.pool.fee_usd_24h).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// 1. toFacts golden
// ---------------------------------------------------------------------------

describe('toFacts golden', () => {
  it('produces byte-identical output for a frozen snapshot', () => {
    const serialized = `${JSON.stringify(facts, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, serialized);
    }
    expect(serialized).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// 2. Cash-flow identity (§3.1)
// ---------------------------------------------------------------------------

describe('cash-flow identity (§3.1)', () => {
  /**
   * The identity is asserted over `splitFees`, not over the emitted facts.
   *
   * Pact publishes only ONE leg of §3.1 — `gross_fees_24h`. The other two, and
   * the two ratios built on them, are declined (see DECLINED_KPIS), because
   * `pact_fee_bps` is null on every pool and a zero there is a claim about
   * Pact's economics rather than a measurement. Reading the legs back off the
   * facts would therefore assert `0 === 0 + 0` and pass forever.
   *
   * So the §Step 6 identity test targets the arithmetic that would produce
   * those legs if we published them. That is the thing that can actually be
   * wrong, and it is still exercised on every fixture.
   */
  const includedValues = (basis: ToFactsOpts['basis'] = DEFAULT_BASIS): PoolValue[] => {
    const out: PoolValue[] = [];
    for (const entity of (snapshot.entities as readonly unknown[]).filter(isPoolEntity)) {
      const value = valuePool(entity.pool);
      if (value !== null && includePool(entity.pool, value, basis)) out.push(value);
    }
    return out;
  };

  const identityHolds = (values: readonly PoolValue[]): void => {
    const { gross, supplySide, protocolRevenue } = splitFees(values);
    expect(Math.abs(gross - (supplySide + protocolRevenue))).toBeLessThan(1e-6);
  };

  it('holds on the recorded fixture', () => {
    identityHolds(includedValues());
  });

  it('holds under verified_only', () => {
    identityHolds(includedValues('verified_only'));
  });

  it('holds when a pool DOES publish its protocol cut', () => {
    // The §3.4 branch no live pool can exercise. See split-pool.json.
    const pool = splitPool();
    const value = valuePool(pool);
    expect(value).not.toBeNull();
    const split = splitFees([...includedValues(), value as PoolValue]);
    expect(Math.abs(split.gross - (split.supplySide + split.protocolRevenue))).toBeLessThan(1e-6);
    // And it is no longer a flat zero: the pool's 5/30 cut is actually taken.
    expect(split.protocolRevenue).toBeGreaterThan(0);
    // The bound is no longer 100% unknown either, which is the condition the
    // decline rests on — and it does NOT re-publish the KPI. A connector whose
    // capabilities changed with the upstream's disclosure would make a missing
    // take_rate ambiguous between "not applicable" and "not today".
    expect(split.unknownShare).toBeLessThan(1);
    expect(pactConnector.capabilities().kpis).not.toContain('protocol_revenue_24h');
  });

  it('is asserted in code, not merely in tests', () => {
    expect(() => {
      assertCashFlowIdentity(100, 60, 30);
    }).toThrow(/§3.1 violated/);
    expect(() => {
      assertCashFlowIdentity(100, 60, 40);
    }).not.toThrow();
  });

  it('publishes the one leg it measured, and no ratio built on the others', () => {
    expect(factFor(facts, 'gross_fees_24h')?.value).toBeGreaterThan(0);
    for (const metric of [
      'protocol_revenue_24h',
      'supply_side_revenue_24h',
      'take_rate',
      'fee_apr',
    ] as const) {
      expect(factFor(facts, metric)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. The decline itself (§1.5, §3.4)
// ---------------------------------------------------------------------------

describe('the unpublished fee split is declined loudly (§1.5)', () => {
  const declined = pactConnector.capabilities().declined ?? {};

  /** The four that rest on the undisclosed split, as opposed to §4.1's count. */
  const SPLIT_DEPENDENT = [
    'fee_apr',
    'protocol_revenue_24h',
    'supply_side_revenue_24h',
    'take_rate',
  ] as const;

  it('declines the four KPIs that rest on pact_fee_bps, plus §4.1\'s user count', () => {
    expect(Object.keys(declined).sort()).toEqual(
      [...SPLIT_DEPENDENT, 'active_users_24h'].sort(),
    );
  });

  it('names the reason — the source does not publish the split', () => {
    for (const kpi of SPLIT_DEPENDENT) {
      expect(declined[kpi]).toMatch(/pact_fee_bps/);
    }
    // Every decline, whatever its cause, carries prose a buyer can act on.
    for (const reason of Object.values(declined)) {
      expect((reason as string).length).toBeGreaterThan(80);
    }
    // The specific harm §1.5 exists to prevent, named where a buyer sees it.
    expect(declined.take_rate).toMatch(/0\.000000/);
    expect(declined.protocol_revenue_24h).toMatch(/does not disclose its cut/);
    // supply_side is declined for the mirror-image reason, and says so.
    expect(declined.supply_side_revenue_24h).toMatch(/100% of swap fees/);
  });

  it('a declined KPI is not also declared', () => {
    for (const kpi of Object.keys(declined)) {
      expect(pactConnector.capabilities().kpis).not.toContain(kpi);
    }
  });

  it('the facts we DO publish carry the reason the others are missing', () => {
    // The number travels without the note, but a buyer holding gross_fees_24h
    // and wondering where the split went finds the answer on the fact itself.
    for (const metric of ['gross_fees_24h', 'capital_efficiency'] as const) {
      const notes = factFor(facts, metric)?.notes ?? [];
      expect(notes.some((n) => /NOT published for Pact/.test(n))).toBe(true);
      expect(notes.some((n) => /404 KPI_NOT_APPLICABLE/.test(n))).toBe(true);
    }
  });

  it('still excludes governance APR from every fee figure, and says so (§3.1)', () => {
    // The commitment used to live on `fee_apr`. That KPI is gone; the
    // commitment is not, so it moved to the ratio that survived.
    const notes = factFor(facts, 'capital_efficiency')?.notes ?? [];
    expect(notes.some((n) => /apr_governance/.test(n) && /excluded/.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Purity
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('two calls on the same snapshot are identical', () => {
    const a = pactConnector.toFacts(snapshot, toFactsOpts());
    const b = pactConnector.toFacts(snapshot, toFactsOpts());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('takes its timestamp from opts.now, never from the clock', () => {
    const other = '2020-01-01T00:00:00.000Z';
    const fs = pactConnector.toFacts(snapshot, toFactsOpts({ now: other }));
    expect(fs.length).toBeGreaterThan(0);
    for (const fact of fs) expect(fact.timestamp).toBe(other);
  });

  it('does not read Date.now()', () => {
    const realNow = Date.now;
    const realDate = globalThis.Date;
    let read = 0;
    try {
      Date.now = () => {
        read++;
        return realNow.call(Date);
      };
      class TrackedDate extends realDate {
        constructor(...args: ConstructorParameters<typeof Date>) {
          if (args.length === 0) read++;
          super(...(args as []));
        }
      }
      globalThis.Date = TrackedDate as DateConstructor;
      globalThis.Date.now = Date.now;
      pactConnector.toFacts(snapshot, toFactsOpts());
    } finally {
      globalThis.Date = realDate;
      Date.now = realNow;
    }
    expect(read).toBe(0);
  });

  it('does not alias the snapshot sources array', () => {
    const fact = facts[0];
    expect(fact?.source).not.toBe(snapshot.sources);
    expect(fact?.source).toEqual([...snapshot.sources]);
  });
});

// ---------------------------------------------------------------------------
// 4. Capability honesty
// ---------------------------------------------------------------------------

describe('capability honesty', () => {
  it('produces every KPI it declares', () => {
    const produced = new Set(facts.map((f) => f.metric));
    for (const kpi of DECLARED) expect(produced).toContain(kpi);
  });

  it('declares nothing it does not produce', () => {
    const declared = new Set<string>(DECLARED);
    for (const fact of facts) expect(declared).toContain(fact.metric);
  });

  it('declines active_users_24h rather than approximating it (§4.1)', () => {
    // Pact has no validator application to filter indexer transactions on:
    // every pool is its own app. §Step 3 says omit, and omitting means no
    // `appIds` either — declaring ids for a KPI we do not compute would be an
    // over-claim `/catalog` publishes.
    expect(DECLARED).not.toContain('active_users_24h');
    // Declined loudly rather than merely omitted: every other dex we cover
    // publishes this, so a bare KPI_NOT_FOUND would read as our gap.
    expect(pactConnector.capabilities().declined?.active_users_24h).toMatch(
      /3,961 distinct app ids/,
    );
    expect(pactConnector.capabilities().appIds).toBeUndefined();
    expect(facts.some((f) => f.metric === 'active_users_24h')).toBe(false);
  });

  it('declares no priceAssets, because nothing here converts to USD', () => {
    expect(pactConnector.priceAssets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Schema conformance
// ---------------------------------------------------------------------------

describe('schema conformance', () => {
  it('every fact validates against the KpiFact schema', () => {
    for (const fact of facts) expect(() => KpiFactSchema.parse(fact)).not.toThrow();
  });

  it('every estimate carries a specific estimation_method (§1.2)', () => {
    for (const fact of facts) {
      if (fact.is_estimated !== true) continue;
      expect(typeof fact.estimation_method).toBe('string');
      expect((fact.estimation_method ?? '').length).toBeGreaterThan(30);
      expect(fact.estimation_method).not.toMatch(/^estimated\.?$/i);
    }
  });

  it('emits no percentages: every RATIO is a finite fraction (§2.1)', () => {
    for (const fact of facts) {
      if (fact.unit !== 'RATIO') continue;
      expect(typeof fact.value).toBe('number');
      expect(Number.isFinite(fact.value)).toBe(true);
      expect(fact.value).toBeGreaterThanOrEqual(0);
      expect(fact.value).toBeLessThan(100);
    }
  });

  it('never emits a NaN, and never a bare null value', () => {
    for (const fact of facts) {
      expect(Number.isNaN(fact.value)).toBe(false);
      expect(fact.value).not.toBeNull();
      expect(isSuccessFact(fact)).toBe(true);
    }
  });

  it('every fact carries full provenance', () => {
    for (const fact of facts) {
      expect(fact.source?.length ?? 0).toBeGreaterThan(0);
      expect(fact.methodology_version).toBe(METHODOLOGY_VERSION);
      expect(fact.coverage?.basis).toBe(DEFAULT_BASIS);
      expect(fact.cache).toBe('miss');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Unpriced-asset handling (§3.6.1)
// ---------------------------------------------------------------------------

describe('unpriced-asset handling (§3.6.1)', () => {
  /**
   * Pact's version of an unpriced asset is not a missing `PriceTable` entry —
   * this connector never consults one. It is the source publishing
   * `"0.00000000"` where it does not know a price, which is an absence wearing
   * the clothes of a measurement: it parses, it sums, and it silently halves
   * the `tvl_usd` of the pool that carries it.
   */
  it('a pool the source prices at 0 on a side is excluded, not contributed', () => {
    const pools = loadRecordedPools();
    const zeroSided = pools.filter(
      (p) =>
        !p.is_deprecated &&
        Number(p.tvl_usd) >= MIN_TVL_USD &&
        (!isPriced(p.primary_asset) || !isPriced(p.secondary_asset)),
    );
    expect(zeroSided.length).toBeGreaterThan(0);

    for (const pool of zeroSided) {
      const value = valuePool(pool);
      expect(value).not.toBeNull();
      expect(includePool(pool, value!, DEFAULT_BASIS)).toBe(false);
    }

    // Its TVL is absent from the total, not present as a zero.
    const excludedTvl = zeroSided.reduce((n, p) => n + Number(p.tvl_usd), 0);
    const includedTvl = pools
      .filter((p) => {
        const v = valuePool(p);
        return v !== null && includePool(p, v, DEFAULT_BASIS);
      })
      .reduce((n, p) => n + Number(p.tvl_usd), 0);
    expect(factFor(facts, 'tvl')?.value).toBeCloseTo(includedTvl, 6);
    expect(factFor(facts, 'tvl')?.value).toBeLessThan(includedTvl + excludedTvl);
  });

  it('entities + excluded reconciles to the full enumeration', () => {
    const enumerated = (snapshot.entities as unknown[]).filter(isPoolEntity).length;
    for (const fact of facts) {
      const coverage = fact.coverage;
      expect((coverage?.entities ?? 0) + (coverage?.excluded ?? 0)).toBe(enumerated);
    }
  });

  it('a stricter basis shrinks the set without inventing value', () => {
    const strict = pactConnector.toFacts(snapshot, toFactsOpts({ basis: 'verified_only' }));
    const a = factFor(facts, 'tvl');
    const b = factFor(strict, 'tvl');
    expect(b?.value).toBeLessThanOrEqual(a?.value ?? 0);
    expect(b?.coverage?.entities).toBeLessThanOrEqual(a?.coverage?.entities ?? 0);
    expect(b?.coverage?.basis).toBe('verified_only');
  });
});

// ---------------------------------------------------------------------------
// 7. Degradation
// ---------------------------------------------------------------------------

describe('graceful degradation', () => {
  it('a failed page yields partial: true, not a throw', async () => {
    const snap = await pactConnector.fetchRaw(makeFixtureContext({ failPage2: true }), {
      basis: DEFAULT_BASIS,
      kpis: DECLARED,
    });
    expect(snap.partial).toBe(true);
    expect(snap.excludedCount).toBeGreaterThan(0);
    // And the pages that DID arrive are kept: a snapshot missing part of its
    // tail, labelled as missing it, is worth strictly more than no snapshot.
    expect((snap.entities as unknown[]).filter(isPoolEntity).length).toBeGreaterThan(0);

    const fs = pactConnector.toFacts(snap, toFactsOpts());
    expect(fs.length).toBeGreaterThan(0);
    for (const fact of fs) {
      expect(fact.notes?.some((n) => /Snapshot is partial/.test(n))).toBe(true);
    }
  });

  /**
   * The live quirk, run as a fault. A server that caps the page size but is
   * believed about it leaves the walk asking for offsets that do not exist —
   * which must reconcile as a shortfall against `count`, not pass as a
   * 40-pool protocol.
   */
  it('a page size the walk cannot honour reconciles as partial, never as a small protocol', async () => {
    const snap = await pactConnector.fetchRaw(makeFixtureContext({ lyingLimit: true }), {
      basis: DEFAULT_BASIS,
      kpis: DECLARED,
    });
    const pools = (snap.entities as unknown[]).filter(isPoolEntity);
    expect(pools.length).toBeLessThan(recordedPages().reduce((n, p) => n + p.results.length, 0));
    expect(snap.partial).toBe(true);
  });

  it('a corrupt record is skipped, counted, and lowers confidence', async () => {
    const clean = await pactConnector.fetchRaw(makeFixtureContext(), {
      basis: DEFAULT_BASIS,
      kpis: DECLARED,
    });
    const dirty = await pactConnector.fetchRaw(makeFixtureContext({ corruptRows: 3 }), {
      basis: DEFAULT_BASIS,
      kpis: DECLARED,
    });
    expect(dirty.excludedCount).toBe(clean.excludedCount + 3);

    const cleanTvl = factFor(pactConnector.toFacts(clean, toFactsOpts()), 'tvl');
    const dirtyTvl = factFor(pactConnector.toFacts(dirty, toFactsOpts()), 'tvl');
    // §5's validation_skip penalty, and a value that shrank by exactly the
    // dropped pools rather than by a coerced zero.
    expect(dirtyTvl?.confidence).toBeLessThan(cleanTvl?.confidence ?? 1);
  });

  it('a truncated page still reconciles against the catalogue count', async () => {
    const snap = await pactConnector.fetchRaw(makeFixtureContext({ truncatePage1: 5 }), {
      basis: DEFAULT_BASIS,
      kpis: DECLARED,
    });
    expect(snap.partial).toBe(true);
  });

  it('healthCheck reports down rather than throwing', async () => {
    const ctx = makeFixtureContext();
    await expect(pactConnector.healthCheck(ctx)).resolves.toEqual({ ok: true });

    const dead = {
      ...ctx,
      http: {
        getJson: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    };
    await expect(pactConnector.healthCheck(dead)).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// §3.4 / §3.6 specifics
// ---------------------------------------------------------------------------

describe('§3.4 fee split', () => {
  it('an absent pact_fee_bps means a 0 protocol share, never a guessed constant', () => {
    for (const pool of loadRecordedPools()) {
      const { share, known } = protocolShareOf(pool);
      if (pool.pact_fee_bps === null) {
        expect(known).toBe(false);
        expect(share).toBe(0);
      } else {
        expect(known).toBe(true);
        expect(share).toBeCloseTo(pool.pact_fee_bps / pool.fee_bps, 12);
      }
    }
  });

  it('a present pact_fee_bps is used as reported', () => {
    const pool = splitPool();
    expect(pool.pact_fee_bps).not.toBeNull();
    const { share, known } = protocolShareOf(pool);
    expect(known).toBe(true);
    expect(share).toBeCloseTo((pool.pact_fee_bps ?? 0) / pool.fee_bps, 12);
  });

  it('a fee_bps of 0 is an absent split, not a division by zero', () => {
    const pool = { ...splitPool(), fee_bps: 0 };
    const { share, known } = protocolShareOf(pool);
    expect(known).toBe(false);
    expect(share).toBe(0);
    expect(Number.isFinite(share)).toBe(true);
  });

  it('states what share of gross fees rests on an unknown split (§3.4)', () => {
    // §3.4 requires this share to be reported "so a buyer can see how tight the
    // bound is". On the recorded fixture it is 100%, which is why there is no
    // bound to publish — the share is reported on the surviving facts instead.
    const values: PoolValue[] = [];
    for (const entity of (snapshot.entities as readonly unknown[]).filter(isPoolEntity)) {
      const value = valuePool(entity.pool);
      if (value !== null && includePool(entity.pool, value, DEFAULT_BASIS)) values.push(value);
    }
    expect(splitFees(values).unknownShare).toBe(1);

    const notes = factFor(facts, 'gross_fees_24h')?.notes ?? [];
    expect(notes.some((n) => /100\.0% of gross fees/.test(n))).toBe(true);
  });

  it('gross_fees_24h is unaffected by the missing split, and says so', () => {
    // The one leg that needs no split: what swappers paid. It stays a measured
    // `reported` figure, not an estimate, even though its siblings are gone.
    const fact = factFor(facts, 'gross_fees_24h');
    expect(fact?.is_estimated).toBe(false);
    expect(fact?.value).toBeGreaterThan(0);
    expect(fact?.notes?.some((n) => /gross_fees_24h itself is unaffected/.test(n))).toBe(true);
  });
});

describe('§3.4 volume denomination', () => {
  /**
   * §3.4 states `volume_24h` is denominated in the primary asset and must be
   * multiplied by its price. It is not, and this test pins the correction to a
   * physical constraint rather than to a preference: a pool cannot charge more
   * fee than its own `fee_bps` on the volume that passed through it.
   */
  it('volume is already USD: fees never exceed fee_bps of the reported volume', () => {
    const pools = loadRecordedPools().filter(
      (p) => Number(p.fee_usd_24h) > 0.001 && Number(p.volume_24h) > 0 && p.fee_bps > 0,
    );
    expect(pools.length).toBeGreaterThan(5);

    let asUsdOk = 0;
    let asPrimaryUnitsOk = 0;
    for (const pool of pools) {
      const fee = Number(pool.fee_usd_24h);
      const raw = Number(pool.volume_24h);
      const price = Number(pool.primary_asset.price);
      const maxFee = pool.fee_bps / 10_000;
      if (fee / raw <= maxFee * 1.05) asUsdOk++;
      if (price > 0 && fee / (raw * price) <= maxFee * 1.05) asPrimaryUnitsOk++;
    }
    // Reading the field as USD is physically possible on essentially every
    // pool; reading it as primary-asset units is impossible on most of them.
    expect(asUsdOk).toBeGreaterThan(pools.length * 0.95);
    expect(asPrimaryUnitsOk).toBeLessThan(pools.length * 0.5);
  });

  it('sums volume without a price conversion, and says so', () => {
    const pools = loadRecordedPools().filter((p) => {
      const v = valuePool(p);
      return v !== null && includePool(p, v, DEFAULT_BASIS);
    });
    const expected = pools.reduce((n, p) => n + Number(p.volume_24h), 0);
    expect(factFor(facts, 'volume_24h')?.value).toBeCloseTo(expected, 6);
    expect(
      factFor(facts, 'volume_24h')?.notes?.some((n) => /reported in USD by the source/.test(n)),
    ).toBe(true);
  });
});

describe('§3.6 filters', () => {
  it('excludes deprecated pools, including a large and active one (§3.6.3)', () => {
    const deprecated = loadRecordedPools().filter((p) => p.is_deprecated);
    expect(deprecated.length).toBeGreaterThan(0);
    // The fixture deliberately carries the deprecated pool that dominates the
    // venue's volume, so this exclusion is exercised on something that matters.
    expect(Math.max(...deprecated.map((p) => Number(p.tvl_usd)))).toBeGreaterThan(100_000);
    for (const pool of deprecated) {
      const value = valuePool(pool);
      expect(includePool(pool, value!, DEFAULT_BASIS)).toBe(false);
    }
    expect(factFor(facts, 'tvl')?.notes?.some((n) => /deprecated/.test(n))).toBe(true);
  });

  it('excludes every pool below the $1,000 floor (§3.6.2)', () => {
    const included = loadRecordedPools().filter((p) => {
      const v = valuePool(p);
      return v !== null && includePool(p, v, DEFAULT_BASIS);
    });
    for (const pool of included) expect(Number(pool.tvl_usd)).toBeGreaterThanOrEqual(MIN_TVL_USD);
  });

  it('uses the shared constant, not a local copy', () => {
    // §3.6: "A connector that redefines MIN_TVL_USD imports its own
    // methodology, which is the exact failure this product exists to
    // eliminate." Asserted by reading the source rather than the behaviour.
    const src = readFileSync('src/connectors/pact/index.ts', 'utf8');
    expect(src).toMatch(/import \{[^}]*MIN_TVL_USD[^}]*\} from '\.\.\/\.\.\/standardize\/types\.js'/s);
    expect(src).not.toMatch(/MIN_TVL_USD\s*=/);
  });

  it('reports the verified / unverified split in notes (§3.6.4)', () => {
    expect(
      factFor(facts, 'tvl')?.notes?.some((n) => /\d+ of the included pools are verified/.test(n)),
    ).toBe(true);
  });

  it('takes the §5 high-exclusion penalty, because the filters do most of the work', () => {
    const coverage = factFor(facts, 'tvl')?.coverage;
    const ratio = (coverage?.excluded ?? 0) / ((coverage?.entities ?? 0) + (coverage?.excluded ?? 0));
    expect(ratio).toBeGreaterThan(0.1);
    expect(factFor(facts, 'tvl')?.confidence).toBeLessThan(0.95);
  });
});

describe('§3.1 exclusions and §5 composites', () => {
  it('a composite ratio takes the MINIMUM confidence of its inputs (§5)', () => {
    const ce = factFor(facts, 'capital_efficiency');
    const gross = factFor(facts, 'gross_fees_24h');
    const tvl = factFor(facts, 'tvl');
    expect(ce?.confidence).toBeLessThanOrEqual(Math.min(gross?.confidence ?? 1, tvl?.confidence ?? 1));
  });

  it('pool_count is an integer equal to coverage.entities', () => {
    const fact = factFor(facts, 'pool_count');
    expect(Number.isInteger(fact?.value)).toBe(true);
    expect(fact?.value).toBe(fact?.coverage?.entities);
  });
});
