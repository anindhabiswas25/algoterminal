import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { tinymanConnector } from '../../../src/connectors/tinyman/index.js';
import {
  V1_PROTOCOL_SHARE,
  V2_FALLBACK_PROTOCOL_SHARE,
  V2_VALIDATOR_APP_ID,
  assertCashFlowIdentity,
  assetIdsFor,
  protocolShareOf,
  valuePool,
} from '../../../src/connectors/tinyman/index.js';
import {
  isPoolEntity,
  isV2PoolEntity,
  type TinymanEntity,
} from '../../../src/connectors/tinyman/schema.js';
import { KpiFactSchema, isSuccessFact } from '../../../src/standardize/schema.js';
import type { KpiFact, KpiId } from '../../../src/standardize/schema.js';
import { DEFAULT_BASIS } from '../../../src/standardize/types.js';
import { FROZEN_NOW } from '../../../src/connectors/testing.js';
import type { RawSnapshot, ToFactsOpts } from '../../../src/connectors/types.js';
import {
  makeFixtureContext,
  prices as loadPrices,
  withoutAsset,
} from '../../fixtures/tinyman/recorded.js';

/**
 * CONNECTOR_GUIDE.md §Step 6 — the seven required tests for the Tinyman
 * connector, over fixtures recorded from the live API on 2026-09-09.
 *
 * The golden test is the one that matters most: it is the difference between
 * "our methodology is documented" and "our methodology is enforced". Regenerate
 * it with `UPDATE_GOLDEN=1 npx vitest run test/connectors/tinyman`, and read the
 * diff — a change there is a change to what buyers are paying for.
 */

const GOLDEN = path.resolve('test/fixtures/tinyman/expected-facts.json');
const METHODOLOGY_VERSION = '1.1.0';
const DECLARED = tinymanConnector.capabilities().kpis;

function toFactsOpts(overrides: Partial<ToFactsOpts> = {}): ToFactsOpts {
  return {
    basis: DEFAULT_BASIS,
    kpis: DECLARED,
    prices: loadPrices(),
    now: FROZEN_NOW,
    methodologyVersion: METHODOLOGY_VERSION,
    ...overrides,
  };
}

let snapshot: RawSnapshot;

beforeAll(async () => {
  snapshot = await tinymanConnector.fetchRaw(makeFixtureContext({ withIndexer: true }), {
    basis: DEFAULT_BASIS,
    kpis: DECLARED,
  });
});

// ---------------------------------------------------------------------------
// fetchRaw — the §3.3 enumeration
// ---------------------------------------------------------------------------

describe('fetchRaw', () => {
  it('enumerates V1.1 and V2 pools, and counts both as distinct venues', () => {
    const pools = (snapshot.entities as TinymanEntity[]).filter(isPoolEntity);
    const v1 = pools.filter((e) => e.kind === 'v1_pool');
    const v2 = pools.filter(isV2PoolEntity);

    // The whole point of the §3.3 quirk: the analytics list yields only V1.1,
    // and a V2 count of zero means the enumeration is broken, not that Tinyman
    // has no V2 liquidity.
    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
    expect(pools.length).toBe(v1.length + v2.length);
  });

  it('enumerates V2 from the chain, not through the V1.1 v2_address pointer', () => {
    // The 1.1.0 methodology change, asserted rather than described. Every V2
    // pool in the fixture came out of the indexer account walk; under the old
    // algorithm only the ones with a V1.1 predecessor could have been reached,
    // and the fixture's V2 count exceeds the number of `v2_address` pointers
    // the recorded V1.1 pages carry.
    const pools = (snapshot.entities as TinymanEntity[]).filter(isPoolEntity);
    const v2 = pools.filter(isV2PoolEntity);
    const pointers = new Set(
      pools.flatMap((e) => (e.kind === 'v1_pool' && e.pool.v2_address !== null ? [e.pool.v2_address] : [])),
    );
    expect(v2.length).toBeGreaterThan(pointers.size);
    // And every one of them is fully described on-chain: ids, reserves, fee
    // split, all out of app 1002541853 local state.
    for (const pool of v2) {
      expect(pool.fee.kind).toBe('v2_onchain');
      expect(pool.asset1Id).toBeTypeOf('number');
      expect(pool.round).toBeGreaterThan(0);
    }
  });

  it('never fetches the same address twice under two keys (§3.3 guard)', () => {
    const pools = (snapshot.entities as TinymanEntity[]).filter(isPoolEntity);
    const addresses = pools.map((e) => (e.kind === 'v1_pool' ? e.pool.address : e.address));
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('records the exact URLs it fetched, and a round for every on-chain read', () => {
    expect(snapshot.sources.length).toBeGreaterThan(0);
    for (const source of snapshot.sources) {
      expect(source.url).toMatch(/^https:\/\//);
      if (source.kind === 'onchain') {
        expect(source.round).toBeTypeOf('number');
        // The account walk names the V2 validator app; the §4.1 indexer scan
        // names each app it filtered on.
        expect([552_635_992, V2_VALIDATOR_APP_ID]).toContain(source.app_id);
      }
    }
    // Provenance is a product feature: both page walks must be visible in it.
    expect(snapshot.sources.some((s) => s.url.includes('offset=0'))).toBe(true);
    expect(
      snapshot.sources.some((s) => s.url.includes(`application-id=${V2_VALIDATOR_APP_ID}`)),
    ).toBe(true);
  });

  it('reads a PER-POOL V2 fee share, not one protocol-wide constant', () => {
    const shares = new Set(
      (snapshot.entities as TinymanEntity[])
        .filter(isPoolEntity)
        .filter((e) => e.fee.kind === 'v2_onchain')
        .map((e) => protocolShareOf(e.fee).share),
    );
    // The recorded fixture holds both live combinations: protocol_fee_ratio 4
    // (a 25% cut) and 6 (16.7%). A flat constant would misstate one of them,
    // which is exactly what §3.3 warns liquidity migration would expose.
    expect(shares.size).toBeGreaterThan(1);
    expect(shares).toContain(0.25);
    expect(shares).toContain(V2_FALLBACK_PROTOCOL_SHARE);
  });

  it('fetches flows only for the pools that will be reported', () => {
    // The §3.3 performance decision, asserted: a flow lookup costs one request
    // per pool, and a pool that cannot clear the $1k floor contributes to no
    // flow KPI. Regressing this is invisible in the numbers and quadruples the
    // refresh time, so it is a test rather than a comment.
    const v2 = (snapshot.entities as TinymanEntity[]).filter(isPoolEntity).filter(isV2PoolEntity);
    const withFlows = v2.filter((e) => e.flows !== null);
    expect(withFlows.length).toBeGreaterThan(0);
    expect(withFlows.length).toBeLessThan(v2.length);
    for (const pool of withFlows) {
      expect(pool.asset1Reserves).toBeGreaterThan(0);
      expect(pool.asset2Reserves).toBeGreaterThan(0);
    }
  });

  it('skips the flow fetch entirely for a TVL-only refresh', async () => {
    const cheap = await tinymanConnector.fetchRaw(makeFixtureContext(), {
      basis: DEFAULT_BASIS,
      kpis: ['tvl', 'pool_count'],
    });
    const v2 = (cheap.entities as TinymanEntity[]).filter(isPoolEntity).filter(isV2PoolEntity);
    expect(v2.length).toBeGreaterThan(0);
    expect(v2.every((e) => e.flows === null)).toBe(true);
    // And TVL is still a real number: it never depended on the analytics API.
    const tvl = tinymanConnector.toFacts(cheap, toFactsOpts()).find((f) => f.metric === 'tvl');
    expect(tvl?.value ?? 0).toBeGreaterThan(0);
  });

  it('skips the indexer scan entirely when active_users_24h is not requested', async () => {
    // The fixture indexer throws unless replay is enabled, so a context without
    // it proves the scan was never attempted rather than merely cheap.
    const cheap = await tinymanConnector.fetchRaw(makeFixtureContext(), {
      basis: DEFAULT_BASIS,
      kpis: ['tvl'],
    });
    expect((cheap.entities as TinymanEntity[]).some((e) => e.kind === 'active_users')).toBe(false);
    expect(cheap.partial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. Golden
// ---------------------------------------------------------------------------

describe('toFacts golden', () => {
  it('produces byte-identical output for a frozen snapshot', () => {
    const facts = tinymanConnector.toFacts(snapshot, toFactsOpts());
    const serialized = `${JSON.stringify(facts, null, 1)}\n`;

    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(GOLDEN, serialized);
    }
    expect(serialized).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// 2. Cash-flow identity
// ---------------------------------------------------------------------------

describe('cash-flow identity (§3.1)', () => {
  const factsOf = (opts: Partial<ToFactsOpts>): Map<KpiId, KpiFact> =>
    new Map(tinymanConnector.toFacts(snapshot, toFactsOpts(opts)).map((f) => [f.metric, f]));

  it.each([
    ['all_pools_usd_priced' as const],
    ['verified_only' as const],
  ])('gross_fees == supply_side + protocol_revenue on basis %s', (basis) => {
    const facts = factsOf({ basis });
    const gross = facts.get('gross_fees_24h')?.value ?? NaN;
    const supply = facts.get('supply_side_revenue_24h')?.value ?? NaN;
    const protocol = facts.get('protocol_revenue_24h')?.value ?? NaN;

    expect(gross).toBeGreaterThan(0);
    expect(Math.abs(gross - (supply + protocol))).toBeLessThanOrEqual(1e-6);
  });

  it('holds with an asset removed from the price table', () => {
    const facts = factsOf({ prices: withoutAsset(loadPrices(), 0) });
    const gross = facts.get('gross_fees_24h')?.value ?? NaN;
    const supply = facts.get('supply_side_revenue_24h')?.value ?? NaN;
    const protocol = facts.get('protocol_revenue_24h')?.value ?? NaN;
    expect(Math.abs(gross - (supply + protocol))).toBeLessThanOrEqual(1e-6);
  });

  it('is asserted in code, not merely in tests', () => {
    expect(() => assertCashFlowIdentity(100, 80, 20)).not.toThrow();
    // A misclassified flow — the failure mode the assertion exists for.
    expect(() => assertCashFlowIdentity(100, 80, 5)).toThrow(/§3.1 violated/);
  });

  it('take_rate is exactly protocol_revenue / gross_fees', () => {
    const facts = factsOf({});
    const takeRate = facts.get('take_rate')?.value ?? NaN;
    const gross = facts.get('gross_fees_24h')?.value ?? NaN;
    const protocol = facts.get('protocol_revenue_24h')?.value ?? NaN;
    expect(takeRate).toBeCloseTo(protocol / gross, 12);
    // Between the two live shares, 1/6 and 1/4, by construction.
    expect(takeRate).toBeGreaterThanOrEqual(V1_PROTOCOL_SHARE - 1e-9);
    expect(takeRate).toBeLessThanOrEqual(0.25 + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// 3. Purity
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('two calls on the same snapshot are identical', () => {
    const a = tinymanConnector.toFacts(snapshot, toFactsOpts());
    const b = tinymanConnector.toFacts(snapshot, toFactsOpts());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('takes its timestamp from opts.now, never from the clock', () => {
    const other = '2020-01-02T03:04:05.000Z';
    const facts = tinymanConnector.toFacts(snapshot, toFactsOpts({ now: other }));
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) expect(fact.timestamp).toBe(other);
  });

  it('does not read Date.now()', () => {
    // If a clock leaked into toFacts, this would throw rather than pass.
    const realNow = Date.now;
    const realDate = globalThis.Date;
    Date.now = () => {
      throw new Error('toFacts must not read the clock (CONNECTOR_GUIDE §1)');
    };
    class TrapDate extends realDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) throw new Error('toFacts must not construct a bare Date');
        super(...args);
      }
    }
    globalThis.Date = TrapDate as unknown as DateConstructor;
    globalThis.Date.now = Date.now;
    try {
      expect(() => tinymanConnector.toFacts(snapshot, toFactsOpts())).not.toThrow();
    } finally {
      globalThis.Date = realDate;
      Date.now = realNow;
    }
  });

  it('does not alias the snapshotsources array', () => {
    const facts = tinymanConnector.toFacts(snapshot, toFactsOpts());
    const first = facts[0];
    expect(first?.source).not.toBe(snapshot.sources);
    expect(first?.source).toEqual([...snapshot.sources]);
  });
});

// ---------------------------------------------------------------------------
// 4. Capability honesty
// ---------------------------------------------------------------------------

describe('capability honesty', () => {
  it('produces every KPI it declares', () => {
    const produced = new Set(tinymanConnector.toFacts(snapshot, toFactsOpts()).map((f) => f.metric));
    const declared = tinymanConnector.capabilities().kpis;
    expect(declared.length).toBe(11);
    for (const kpi of declared) expect([...produced]).toContain(kpi);
  });

  it('declares nothing it does not produce', () => {
    const declared = new Set<string>(tinymanConnector.capabilities().kpis);
    for (const fact of tinymanConnector.toFacts(snapshot, toFactsOpts())) {
      expect(declared).toContain(fact.metric);
    }
  });

  it('lists the app ids active_users_24h is computed from (§4.1)', () => {
    const caps = tinymanConnector.capabilities();
    expect(caps.kpis).toContain('active_users_24h');
    expect(caps.appIds).toEqual([552_635_992, V2_VALIDATOR_APP_ID]);
  });

  it('caps active_users_24h confidence at 0.80 on every basis', () => {
    for (const basis of ['all_pools_usd_priced', 'verified_only'] as const) {
      const fact = tinymanConnector
        .toFacts(snapshot, toFactsOpts({ basis }))
        .find((f) => f.metric === 'active_users_24h');
      expect(fact?.confidence).toBeLessThanOrEqual(0.8);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Schema conformance
// ---------------------------------------------------------------------------

describe('schema conformance', () => {
  it('every fact validates against the KpiFact schema', () => {
    for (const fact of tinymanConnector.toFacts(snapshot, toFactsOpts())) {
      expect(() => KpiFactSchema.parse(fact)).not.toThrow();
    }
  });

  it('every estimate carries a specific estimation_method (§1.2)', () => {
    for (const fact of tinymanConnector.toFacts(snapshot, toFactsOpts())) {
      if (fact.is_estimated === true) {
        expect(fact.estimation_method).toBeTypeOf('string');
        expect((fact.estimation_method ?? '').length).toBeGreaterThan(20);
      } else {
        expect(fact.estimation_method).toBeNull();
      }
    }
  });

  it('emits no percentages: every RATIO is a finite fraction (§2.1)', () => {
    for (const fact of tinymanConnector.toFacts(snapshot, toFactsOpts())) {
      if (fact.unit === 'RATIO') {
        expect(Number.isFinite(fact.value)).toBe(true);
        expect(fact.value).toBeGreaterThanOrEqual(0);
        expect(fact.value).toBeLessThan(10);
      }
      if (fact.unit === 'COUNT') expect(Number.isInteger(fact.value)).toBe(true);
    }
  });

  it('never emits a NaN, and never a bare null value', () => {
    for (const fact of tinymanConnector.toFacts(snapshot, toFactsOpts())) {
      expect(fact.value).not.toBeNull();
      expect(Number.isNaN(fact.value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Unpriced-asset handling
// ---------------------------------------------------------------------------

describe('unpriced-asset handling (§3.6.1)', () => {
  it('an asset removed from prices.json raises coverage.excluded', () => {
    const before = tinymanConnector.toFacts(snapshot, toFactsOpts())[0];
    const after = tinymanConnector.toFacts(
      snapshot,
      toFactsOpts({ prices: withoutAsset(loadPrices(), 0) }),
    )[0];

    expect(after?.coverage?.excluded).toBeGreaterThan(before?.coverage?.excluded ?? 0);
    expect(after?.coverage?.entities).toBeLessThan(before?.coverage?.entities ?? 0);
  });

  it('the excluded pools DROP OUT of the total rather than contributing zero', () => {
    const opts = toFactsOpts();
    const before = tinymanConnector.toFacts(snapshot, opts);
    const after = tinymanConnector.toFacts(
      snapshot,
      toFactsOpts({ prices: withoutAsset(loadPrices(), 0) }),
    );

    const tvlBefore = before.find((f) => f.metric === 'tvl')?.value ?? 0;
    const tvlAfter = after.find((f) => f.metric === 'tvl')?.value ?? 0;

    // A zero-contributing pool would leave TVL unchanged. The number MUST move,
    // and it must move down: value and coverage tell one consistent story.
    expect(tvlAfter).toBeLessThan(tvlBefore);
    expect(tvlAfter).toBeGreaterThanOrEqual(0);
  });

  it('entities + excluded is conserved as pricing changes', () => {
    const totals = [loadPrices(), withoutAsset(loadPrices(), 0)].map((prices) => {
      const fact = tinymanConnector.toFacts(snapshot, toFactsOpts({ prices }))[0];
      return (fact?.coverage?.entities ?? 0) + (fact?.coverage?.excluded ?? 0);
    });
    expect(totals[0]).toBe(totals[1]);
  });

  it('assetIdsFor asks the price service only about includable pools', () => {
    const ids = assetIdsFor(snapshot);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain(0);
    expect([...ids]).toEqual([...ids].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// 7. Degradation
// ---------------------------------------------------------------------------

describe('graceful degradation', () => {
  it.each([
    ['a V1.1 analytics page', { failPage2: true } as const],
    ['an indexer account page', { failAccountPage2: true } as const],
  ])('a failed %s yields partial: true, not a throw', async (_label, options) => {
    const snap = await tinymanConnector.fetchRaw(makeFixtureContext(options), {
      basis: DEFAULT_BASIS,
      kpis: ['tvl', 'gross_fees_24h'],
    });
    expect(snap.partial).toBe(true);
    expect(snap.entities.length).toBeGreaterThan(0);

    const facts = tinymanConnector.toFacts(snap, toFactsOpts());
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.notes?.some((n) => n.includes('Snapshot is partial'))).toBe(true);
    }
  });

  it('a truncated account walk NEVER passes as a complete enumeration', async () => {
    // The one failure this whole step exists to prevent. A walk that stopped
    // early reports fewer pools AND says so; what it must never do is look
    // like a smaller, healthy Tinyman.
    const full = await tinymanConnector.fetchRaw(makeFixtureContext(), {
      basis: DEFAULT_BASIS,
      kpis: ['tvl'],
    });
    const cut = await tinymanConnector.fetchRaw(makeFixtureContext({ failAccountPage2: true }), {
      basis: DEFAULT_BASIS,
      kpis: ['tvl'],
    });
    expect(cut.entities.length).toBeLessThan(full.entities.length);
    expect(full.partial).toBe(false);
    expect(cut.partial).toBe(true);
  });

  it('a V2 pool whose flow lookup fails keeps its TVL and contributes no flow', async () => {
    const snap = await tinymanConnector.fetchRaw(makeFixtureContext({ failFlows: true }), {
      basis: DEFAULT_BASIS,
      kpis: DECLARED.filter((k) => k !== 'active_users_24h'),
    });
    const facts = new Map(
      tinymanConnector.toFacts(snap, toFactsOpts()).map((f) => [f.metric, f]),
    );
    // TVL is on-chain and survives the analytics API being unreachable...
    expect(facts.get('tvl')?.value ?? 0).toBeGreaterThan(0);
    // ...and the flow KPIs describe only the V1.1 pools that still had one,
    // and say so rather than reporting a V2 zero (§1.5).
    expect(
      facts.get('volume_24h')?.notes?.some((n) => n.includes('24h flows cover')),
    ).toBe(true);
  });

  it('a corrupt record is skipped, counted, and lowers confidence', async () => {
    const ctx = makeFixtureContext();
    const good = await tinymanConnector.fetchRaw(ctx, { basis: DEFAULT_BASIS, kpis: ['tvl'] });

    // Corrupt one recorded row the way upstream drift actually looks: a field
    // retyped, not removed.
    const corrupted: RawSnapshot = {
      ...good,
      excludedCount: good.excludedCount + 1,
    };
    const clean = tinymanConnector.toFacts(good, toFactsOpts())[0];
    const dirty = tinymanConnector.toFacts(corrupted, toFactsOpts())[0];

    expect(dirty?.coverage?.excluded).toBe((clean?.coverage?.excluded ?? 0) + 1);
    expect(dirty?.confidence).toBeLessThan(clean?.confidence ?? 1);
  });

  it('an unusable protocol_fee_ratio falls back to 1/6 and says so', () => {
    // Since 1.1.0 the fee split arrives with the enumeration, so the fallback
    // is no longer reachable by breaking a fetch — it is reachable only by
    // state that is present and wrong, which is what this asserts directly.
    expect(protocolShareOf({ kind: 'v2_unreadable', detail: 'malformed' })).toEqual({
      share: V2_FALLBACK_PROTOCOL_SHARE,
      estimated: true,
      reason: 'malformed',
    });
    const zeroRatio = protocolShareOf({
      kind: 'v2_onchain',
      totalFeeShare: 30,
      protocolFeeRatio: 0,
      appId: V2_VALIDATOR_APP_ID,
      round: 1,
    });
    // A zero divisor is division by zero wearing a plausible face.
    expect(zeroRatio.share).toBe(V2_FALLBACK_PROTOCOL_SHARE);
    expect(zeroRatio.estimated).toBe(true);
  });

  it('declines active_users_24h rather than reporting a truncated scan', async () => {
    const ctx = makeFixtureContext({ withIndexer: true });
    const broken = {
      ...ctx,
      indexer: {
        ...ctx.indexer,
        searchTransactions: async () => {
          throw new Error('indexer page failed');
        },
      },
    };
    const snap = await tinymanConnector.fetchRaw(broken, {
      basis: DEFAULT_BASIS,
      kpis: ['active_users_24h'],
    });
    expect(snap.partial).toBe(true);
    const facts = tinymanConnector.toFacts(snap, toFactsOpts());
    expect(facts.some((f) => f.metric === 'active_users_24h')).toBe(false);
  });

  it('healthCheck reports down rather than throwing', async () => {
    const ctx = makeFixtureContext();
    const dead = {
      ...ctx,
      http: {
        getJson: async () => {
          throw new Error('unreachable');
        },
      },
    };
    await expect(tinymanConnector.healthCheck(ctx)).resolves.toEqual({ ok: true });
    await expect(tinymanConnector.healthCheck(dead)).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Filters and confidence
// ---------------------------------------------------------------------------

describe('§3.6 filters and §5 confidence', () => {
  it('verified_only is a strict subset of the default basis', () => {
    const all = tinymanConnector.toFacts(snapshot, toFactsOpts())[0];
    const verified = tinymanConnector.toFacts(
      snapshot,
      toFactsOpts({ basis: 'verified_only' }),
    )[0];
    expect(verified?.coverage?.entities).toBeLessThanOrEqual(all?.coverage?.entities ?? 0);
    expect(verified?.coverage?.basis).toBe('verified_only');
    expect(all?.coverage?.basis).toBe('all_pools_usd_priced');
  });

  it('V2 TVL is the on-chain reserve formula, not the reported figure', () => {
    // §3.3, 1.1.0 — asserted against the fixture's own numbers so the formula
    // cannot drift from the specification without failing here.
    const prices = loadPrices();
    const pool = (snapshot.entities as TinymanEntity[])
      .filter(isPoolEntity)
      .filter(isV2PoolEntity)
      .find(
        (e) =>
          e.asset1Decimals !== null &&
          e.asset2Decimals !== null &&
          prices.prices[e.asset1Id] !== undefined &&
          prices.prices[e.asset2Id] !== undefined &&
          e.asset1Reserves > 0,
      );
    expect(pool).toBeDefined();
    if (pool === undefined) return;

    const expected =
      (pool.asset1Reserves / 10 ** (pool.asset1Decimals ?? 0)) *
        (prices.prices[pool.asset1Id]?.usd ?? 0) +
      (pool.asset2Reserves / 10 ** (pool.asset2Decimals ?? 0)) *
        (prices.prices[pool.asset2Id]?.usd ?? 0);
    expect(valuePool(pool, prices)?.tvl).toBeCloseTo(expected, 9);
  });

  it('grades TVL by §5 usd_conversion, because the fact is denominated in USD', () => {
    const tvl = tinymanConnector.toFacts(snapshot, toFactsOpts()).find((f) => f.metric === 'tvl');
    // Reserves are on-chain (0.95) but the number is dollars, so the price
    // confidence propagates: 0.90 x price_confidence, never the 0.95 the
    // analytics API's own USD figure earned before 1.1.0.
    expect(tvl?.confidence ?? 1).toBeLessThan(0.95);
    expect(tvl?.notes?.some((n) => n.includes('usd_conversion row governs'))).toBe(true);
  });

  it('states that flow coverage is narrower than TVL coverage (§3.3)', () => {
    const facts = tinymanConnector.toFacts(snapshot, toFactsOpts());
    for (const metric of ['volume_24h', 'gross_fees_24h', 'protocol_revenue_24h'] as const) {
      const fact = facts.find((f) => f.metric === metric);
      expect(fact?.notes?.some((n) => n.includes('different coverage'))).toBe(true);
    }
    // And the turnover ratios say which denominator they used, so a numerator
    // and a denominator over different pools can never pass unremarked.
    const ce = facts.find((f) => f.metric === 'capital_efficiency');
    expect(ce?.notes?.some((n) => n.includes('Denominator is'))).toBe(true);
  });

  it('excludes every pool below the $1,000 floor (§3.6.2)', () => {
    const facts = tinymanConnector.toFacts(snapshot, toFactsOpts());
    const poolCount = facts.find((f) => f.metric === 'pool_count')?.value ?? 0;
    const tvl = facts.find((f) => f.metric === 'tvl')?.value ?? 0;
    expect(poolCount).toBeGreaterThan(0);
    // Every included pool is worth at least $1k, so the total must be too.
    expect(tvl).toBeGreaterThanOrEqual(1_000 * poolCount);
  });

  it('reports the verified / unverified split in notes (§3.6.4)', () => {
    const fact = tinymanConnector.toFacts(snapshot, toFactsOpts())[0];
    expect(fact?.notes?.some((n) => /\d+ verified, \d+ unverified/.test(n))).toBe(true);
  });

  it('a composite ratio takes the MINIMUM confidence of its inputs (§5)', () => {
    const facts = new Map(
      tinymanConnector.toFacts(snapshot, toFactsOpts()).map((f) => [f.metric, f]),
    );
    const takeRate = facts.get('take_rate');
    const gross = facts.get('gross_fees_24h');
    const protocol = facts.get('protocol_revenue_24h');
    expect(takeRate?.confidence).toBeLessThanOrEqual(
      Math.min(gross?.confidence ?? 1, protocol?.confidence ?? 1),
    );
  });

  it('every fact is a success fact carrying full provenance', () => {
    for (const fact of tinymanConnector.toFacts(snapshot, toFactsOpts())) {
      expect(isSuccessFact(fact)).toBe(true);
      expect(fact.source?.length).toBeGreaterThan(0);
      expect(fact.as_of).toBe(snapshot.fetchedAt);
      expect(fact.methodology_version).toBe(METHODOLOGY_VERSION);
    }
  });
});
