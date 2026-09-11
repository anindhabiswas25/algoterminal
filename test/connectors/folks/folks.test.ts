import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { FOLKS_MARKETS, FOLKS_SDK_VERSION } from '../../../src/connectors/folks/constants.js';
import {
  aggregate,
  assertCashFlowIdentity,
  folksConnector,
  marketGrossFees,
  marketSupplySideRevenue,
  type MarketValue,
} from '../../../src/connectors/folks/index.js';
import {
  decodeMarket,
  isMarketEntity,
  parseUint64s,
  scaleMarket,
  type ScaledMarket,
} from '../../../src/connectors/folks/schema.js';
import { FROZEN_NOW } from '../../../src/connectors/testing.js';
import { priceOf } from '../../../src/connectors/types.js';
import type { RawSnapshot, ToFactsOpts } from '../../../src/connectors/types.js';
import { KpiFactSchema, isSuccessFact } from '../../../src/standardize/schema.js';
import type { KpiFact, KpiId } from '../../../src/standardize/schema.js';
import { DEFAULT_BASIS, RETENTION_DIVERGENCE_THRESHOLD } from '../../../src/standardize/types.js';
import {
  FIXTURE_ROUND,
  makeFixtureContext,
  recordedMarkets,
  recordedPrices,
  recordedSnapshot,
  recordedState,
  sdkDerived,
} from '../../fixtures/folks/recorded.js';

/**
 * CONNECTOR_GUIDE.md §Step 6 — the seven required tests for the Folks
 * connector, over state recorded from mainnet on 2026-09-09.
 *
 * The SDK-agreement test in §0 comes first because DATA_SCHEMA.md §3.5 makes it
 * a precondition: "write the fixture test §3.5 requires ... If you cannot make
 * that test pass, STOP and report rather than proceeding on a scale you
 * inferred." Everything below it is only meaningful once it passes.
 */

const GOLDEN = path.resolve('test/fixtures/folks/expected-facts.json');
const METHODOLOGY_VERSION = '1.2.0';
const DECLARED = folksConnector.capabilities().kpis;

function toFactsOpts(overrides: Partial<ToFactsOpts> = {}): ToFactsOpts {
  return {
    basis: DEFAULT_BASIS,
    kpis: [...DECLARED],
    prices: recordedPrices(),
    now: FROZEN_NOW,
    methodologyVersion: METHODOLOGY_VERSION,
    ...overrides,
  };
}

function factFor(facts: readonly KpiFact[], metric: KpiId): KpiFact | undefined {
  return facts.find((f) => f.metric === metric);
}

/** The USD-valued markets the fixture yields, as `toFacts` computes them. */
function fixtureValues(snapshot: RawSnapshot = recordedSnapshot()): MarketValue[] {
  const prices = recordedPrices();
  const out: MarketValue[] = [];
  for (const entity of snapshot.entities) {
    if (!isMarketEntity(entity)) continue;
    const market = scaleMarket(entity.state);
    const price = priceOf(prices, market.assetId);
    if (price === null || !(price.usd > 0)) continue;
    out.push({
      market,
      priceUsd: price.usd,
      priceConfidence: price.confidence,
      depositsUsd: market.deposits * price.usd,
      borrowsUsd: market.borrows * price.usd,
    });
  }
  return out;
}

let snapshot: RawSnapshot;
let facts: KpiFact[];
beforeAll(() => {
  snapshot = recordedSnapshot();
  facts = folksConnector.toFacts(snapshot, toFactsOpts());
});

// ---------------------------------------------------------------------------
// 0. The SDK-agreement test DATA_SCHEMA.md §3.5 requires
// ---------------------------------------------------------------------------

describe('fixed-point scales agree with the SDK (§3.5, the "do not skip" test)', () => {
  const derived = sdkDerived();
  const scaled = new Map<number, ScaledMarket>(
    recordedMarkets().map((m) => {
      const entity = decodeMarket(m, recordedState(m.appId), FIXTURE_ROUND);
      if (entity.kind !== 'market') throw new Error(`fixture market ${m.name} failed to decode`);
      return [m.appId, scaleMarket(entity.state)];
    }),
  );

  it('was recorded from the pinned SDK version', () => {
    // If the pin moves, this fixture is stale and every scale below is
    // unverified. A silently re-scaled field is precisely the failure §3.5
    // warns about, so it must break the suite rather than the numbers.
    expect(derived.sdkVersion).toBe(FOLKS_SDK_VERSION);
  });

  it("supply_apr matches the SDK's own derived value to within 1e-6, on every market", () => {
    // The literal §3.5 requirement. `depositInterestRate` is 16 dp; reading it
    // at 14 dp would make a 1.96% deposit rate read as 196%, and nothing
    // downstream would look wrong.
    for (const market of Object.values(derived.markets)) {
      const ours = scaled.get(market.appId);
      expect(ours, `no decoded market for ${market.name}`).toBeDefined();
      expect(
        Math.abs((ours as ScaledMarket).depositRate - market.supply_apr),
        `supply_apr disagreement on ${market.name}`,
      ).toBeLessThan(1e-6);
    }
  });

  it('every other rate, ratio and total matches the SDK too', () => {
    for (const market of Object.values(derived.markets)) {
      const ours = scaled.get(market.appId) as ScaledMarket;
      const close = (a: number, b: number, what: string): void => {
        expect(Math.abs(a - b), `${what} disagreement on ${market.name}`).toBeLessThan(1e-6);
      };
      close(ours.variableBorrowRate, market.variable_borrow_apr, 'variable borrow rate');
      // The blended rate — the one gross_fees_24h actually multiplies.
      close(ours.overallBorrowRate, market.overall_borrow_apr, 'overall borrow rate');
      close(ours.retentionRate, market.retention_rate, 'retention rate');
      // Amounts are 0 dp on chain and divided by 10^assetDecimals; OPUL has 10
      // decimals rather than 6 or 8, so this covers the non-default case.
      close(ours.deposits, market.deposits, 'deposits');
      close(ours.variableBorrows, market.variable_borrows, 'variable borrows');
      close(ours.stableBorrows, market.stable_borrows, 'stable borrows');
      expect(ours.deprecated).toBe(market.deprecated);
      expect(ours.stableBorrowSupported).toBe(market.stable_borrow_supported);
    }
  });

  it('a rate read at the WRONG scale would fail this test — the guard has teeth', () => {
    // Guards the guard: if `scaleMarket` used the index scale (14 dp) for a
    // rate, every value would be 100x too large. Asserting that such a value
    // would be rejected is what stops the tolerance from being so loose that
    // the test passes on anything.
    const algo = Object.values(derived.markets).find((m) => m.name === 'ALGO');
    expect(algo).toBeDefined();
    const wrongScale = (algo as { supply_apr: number }).supply_apr * 100;
    expect(Math.abs(wrongScale - (algo as { supply_apr: number }).supply_apr)).toBeGreaterThan(1e-6);
  });

  it('decodes the packed uint64 arrays the way the SDK lays them out', () => {
    // The decoder itself, at the byte level: a 1-slot offset would swap a rate
    // for a total and still produce a plausible number.
    const state = recordedState(FOLKS_MARKETS.find((m) => m.name === 'ALGO')?.appId ?? 0);
    expect(state).not.toBeNull();
    const packed = state?.['i'];
    expect(packed?.type).toBe('bytes');
    const slots = parseUint64s((packed as { type: 'bytes'; bytes: Uint8Array }).bytes);
    expect(slots.length).toBeGreaterThanOrEqual(7);
    // Slot 0 is retentionRate, and ALGO's is 20% at 16 dp.
    expect(slots[0]).toBe(2_000_000_000_000_000n);
  });
});

// ---------------------------------------------------------------------------
// 1. toFacts golden
// ---------------------------------------------------------------------------

describe('toFacts golden', () => {
  it('produces byte-identical output for a frozen snapshot', () => {
    const serialized = `${JSON.stringify(facts, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, serialized);
    expect(serialized).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// 2. Cash-flow identity (§3.1)
// ---------------------------------------------------------------------------

describe('cash-flow identity (§3.1)', () => {
  const identityHolds = (fs: readonly KpiFact[]): void => {
    const gross = factFor(fs, 'gross_fees_24h')?.value ?? 0;
    const supply = factFor(fs, 'supply_side_revenue_24h')?.value ?? 0;
    const protocol = factFor(fs, 'protocol_revenue_24h')?.value ?? 0;
    expect(Math.abs(gross - (supply + protocol))).toBeLessThan(1e-6);
  };

  it('holds on the recorded fixture', () => {
    identityHolds(facts);
  });

  it('holds when the biggest market is dropped', () => {
    const withoutAlgo: RawSnapshot = {
      ...snapshot,
      entities: snapshot.entities.filter(
        (e) => !(isMarketEntity(e) && e.state.name === 'ALGO'),
      ),
    };
    identityHolds(folksConnector.toFacts(withoutAlgo, toFactsOpts()));
  });

  it('is asserted in code, not merely in tests', () => {
    expect(() => {
      assertCashFlowIdentity(100, 60, 30);
    }).toThrow(/§3.1 violated/);
    expect(() => {
      assertCashFlowIdentity(100, 60, 40);
    }).not.toThrow();
  });

  it('take_rate is exactly protocol_revenue / gross_fees', () => {
    const gross = factFor(facts, 'gross_fees_24h')?.value ?? 0;
    const protocol = factFor(facts, 'protocol_revenue_24h')?.value ?? 0;
    expect(gross).toBeGreaterThanOrEqual(1);
    expect(factFor(facts, 'take_rate')?.value).toBeCloseTo(protocol / gross, 12);
  });

  it('gross fees are driven by BORROWS, not deposits (§3.5)', () => {
    // The classic error, asserted against rather than merely commented on:
    // using deposits would inflate fees by 1/utilization. On this fixture
    // utilization is well under 1, so the two are far apart.
    const values = fixtureValues();
    const fromBorrows = values.reduce((sum, v) => sum + marketGrossFees(v), 0);
    const fromDeposits = values.reduce(
      (sum, v) => sum + (v.depositsUsd * v.market.overallBorrowRate) / 365,
      0,
    );
    expect(factFor(facts, 'gross_fees_24h')?.value).toBeCloseTo(fromBorrows, 9);
    expect(fromDeposits).toBeGreaterThan(fromBorrows);

    // The size of the error is exactly 1/utilization, per market — asserted on
    // one market rather than on the aggregate, because the aggregate ratio is
    // a fee-weighted mix of per-market utilizations and is not 1/utilization
    // for any single market.
    const algo = values.find((v) => v.market.name === 'ALGO') as MarketValue;
    const algoUtil = algo.borrowsUsd / algo.depositsUsd;
    const algoFromDeposits = (algo.depositsUsd * algo.market.overallBorrowRate) / 365;
    expect(algoFromDeposits).toBeCloseTo(marketGrossFees(algo) / algoUtil, 9);
    expect(algoUtil).toBeLessThan(1);
  });

  it('supply-side revenue is computed independently, not as a residual', () => {
    // If supply_side were derived from gross_fees the identity would be a
    // tautology and would catch nothing. It comes from deposits x the deposit
    // rate, which is what makes the retention cross-check below meaningful.
    const values = fixtureValues();
    const independent = values.reduce((sum, v) => sum + marketSupplySideRevenue(v), 0);
    expect(factFor(facts, 'supply_side_revenue_24h')?.value).toBeCloseTo(independent, 9);
  });
});

// ---------------------------------------------------------------------------
// 2b. The §3.5 retention cross-check
// ---------------------------------------------------------------------------

describe('retention-rate cross-check (§3.5)', () => {
  it('passes on the recorded fixture, to far inside the 5% threshold', () => {
    const agg = aggregate(fixtureValues());
    expect(agg.retentionDivergence).toBeLessThan(RETENTION_DIVERGENCE_THRESHOLD);
    // Not merely inside the threshold: the residual and the retention-rate
    // prediction agree to floating-point noise, which is what an independent
    // confirmation of the fixed-point scaling looks like.
    expect(agg.retentionDivergence).toBeLessThan(1e-9);
    expect(factFor(facts, 'protocol_revenue_24h')?.notes?.some((n) => /cross-check PASSED/.test(n))).toBe(true);
  });

  it("the blended borrow rate is why it passes — §3.5's variable-only formula breaks it", () => {
    // The correction this connector makes to DATA_SCHEMA.md §3.5, pinned as a
    // test rather than only argued in a comment. Stable debt is 54% of
    // ISOLATED_TINY and 22% of USDC, so the variable rate alone understates
    // what borrowers pay and the identity stops reconciling.
    const values = fixtureValues();
    const agg = aggregate(values);
    const supply = agg.supplySide;

    // §3.5 as literally written: `borrows_usd(m) = variableBorrowTotal_m /
    // 10^decimals × P`, multiplied by `variableBorrowInterestRate`. So the
    // stable half of the debt is dropped from BOTH the principal and the rate.
    const grossLiteral = values.reduce(
      (sum, v) => sum + ((v.market.variableBorrows * v.priceUsd) * v.market.variableBorrowRate) / 365,
      0,
    );
    const divergenceLiteral =
      Math.abs(grossLiteral - supply - grossLiteral * agg.retentionWeighted) / grossLiteral;

    // The literal formula trips §3.5's own 5% detector; ours agrees to noise.
    expect(divergenceLiteral).toBeGreaterThan(RETENTION_DIVERGENCE_THRESHOLD);
    expect(agg.retentionDivergence).toBeLessThan(1e-9);
    // It also understates what borrowers paid by a large margin, which is what
    // makes it a value error and not only a diagnostic one.
    expect(grossLiteral).toBeLessThan(agg.grossFees * 0.9);

    // Per market, it is worse than the aggregate suggests: dropping stable
    // debt makes the protocol's own revenue come out NEGATIVE wherever stable
    // borrowers are a large share, which is incoherent rather than imprecise.
    const negative = values.filter(
      (v) =>
        v.borrowsUsd > 0 &&
        ((v.market.variableBorrows * v.priceUsd) * v.market.variableBorrowRate) / 365 -
          marketSupplySideRevenue(v) <
          0,
    );
    expect(negative.length).toBeGreaterThan(0);
  });

  it('fires, penalises and keeps the residual when the rates disagree', () => {
    // A market whose deposit rate is inconsistent with its borrow rate — the
    // shape a real fixed-point bug would produce. §3.5: keep the residual (the
    // identity is authoritative), add a note, apply the additive penalty.
    const tampered: RawSnapshot = {
      ...snapshot,
      entities: snapshot.entities.map((e) =>
        isMarketEntity(e) && e.state.name === 'ALGO'
          ? { ...e, state: { ...e.state, depositRate: e.state.depositRate / 4n } }
          : e,
      ),
    };
    const fs = folksConnector.toFacts(tampered, toFactsOpts());
    const gross = factFor(fs, 'gross_fees_24h')?.value ?? 0;
    const supply = factFor(fs, 'supply_side_revenue_24h')?.value ?? 0;
    const prot = factFor(fs, 'protocol_revenue_24h');

    // The residual is kept: §3.1 is an identity, not a preference.
    expect(prot?.value).toBeCloseTo(gross - supply, 9);
    expect(prot?.notes?.some((n) => /RETENTION CROSS-CHECK FIRED/.test(n))).toBe(true);
    // And it costs confidence, additively (§5).
    const clean = factFor(facts, 'protocol_revenue_24h')?.confidence ?? 0;
    expect(prot?.confidence).toBeLessThan(clean);
  });
});

// ---------------------------------------------------------------------------
// 3. Purity
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('two calls on the same snapshot are identical', () => {
    const a = folksConnector.toFacts(snapshot, toFactsOpts());
    const b = folksConnector.toFacts(snapshot, toFactsOpts());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('takes its timestamp from opts.now, never from the clock', () => {
    const other = '2020-01-01T00:00:00.000Z';
    const fs = folksConnector.toFacts(snapshot, toFactsOpts({ now: other }));
    for (const fact of fs) expect(fact.timestamp).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// 4. Capability honesty
// ---------------------------------------------------------------------------

describe('capability honesty', () => {
  it('produces every KPI it declares', () => {
    // active_users_24h needs the indexer scan, which is only in the snapshot
    // when it was requested; it is covered by its own test below.
    const produced = new Set(facts.map((f) => f.metric));
    for (const kpi of DECLARED) {
      if (kpi === 'active_users_24h') continue;
      expect(produced.has(kpi), `declared but not produced: ${kpi}`).toBe(true);
    }
  });

  it('declares nothing outside the §4 lending set, and is registry-coherent', () => {
    const caps = folksConnector.capabilities();
    expect(caps.class).toBe('lending');
    expect(caps.id).toBe('folks');
    // DEX-only KPIs must not appear: this is the assertion that would have
    // caught a copy-paste from the Tinyman or Pact connector.
    for (const dexOnly of ['volume_24h', 'fee_apr', 'volume_to_tvl'] as const) {
      expect(caps.kpis).not.toContain(dexOnly);
    }
    // §4.1: declaring active_users_24h obliges listing the app ids.
    expect(caps.kpis).toContain('active_users_24h');
    expect(caps.appIds?.length ?? 0).toBeGreaterThan(25);
  });

  it('produces active_users_24h when the scan is present', () => {
    const withScan: RawSnapshot = {
      ...snapshot,
      entities: [
        ...snapshot.entities,
        {
          kind: 'active_users',
          scan: {
            addresses: 141,
            transactions: 10_279,
            appIds: folksConnector.capabilities().appIds ?? [],
            requestedMinRound: FIXTURE_ROUND - 31_500,
            requestedMaxRound: FIXTURE_ROUND,
            observedMinRound: FIXTURE_ROUND - 31_400,
            observedMaxRound: FIXTURE_ROUND,
          },
        },
      ],
    };
    const fact = factFor(folksConnector.toFacts(withScan, toFactsOpts()), 'active_users_24h');
    expect(fact?.value).toBe(141);
    // §4.1's hard cap, "always, on every protocol".
    expect(fact?.confidence).toBeLessThanOrEqual(0.8);
    expect(fact?.notes?.some((n) => /deposit-staking application is deliberately NOT scanned/.test(n))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Schema conformance
// ---------------------------------------------------------------------------

describe('schema conformance', () => {
  it('every fact validates against the KpiFact schema', () => {
    for (const fact of facts) {
      const parsed = KpiFactSchema.safeParse(fact);
      expect(parsed.success, `${fact.metric}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('every fact is a success fact, stamped and covered', () => {
    for (const fact of facts) {
      expect(isSuccessFact(fact)).toBe(true);
      expect(fact.protocol).toBe('folks');
      expect(fact.methodology_version).toBe(METHODOLOGY_VERSION);
      // §3.5: lending TVL is total deposits, and the definition rides on every
      // fact rather than living only in the methodology document.
      expect(fact.coverage?.basis).toBe('total_deposits');
      expect(fact.source.length).toBeGreaterThan(0);
      for (const source of fact.source) {
        expect(source.kind).toBe('onchain');
        // §1.4/§4.2: an on-chain number without a round is not reproducible.
        expect(source.round).toBe(FIXTURE_ROUND);
        expect(source.app_id).toBeGreaterThan(0);
      }
    }
  });

  it('rates are dimensionless fractions, never percents (§2.1)', () => {
    for (const metric of ['supply_apr', 'borrow_apr', 'utilization', 'take_rate'] as const) {
      const value = factFor(facts, metric)?.value as number;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('utilization is between 0 and 1 and equals borrows / deposits', () => {
    const tvl = factFor(facts, 'tvl')?.value as number;
    const borrows = factFor(facts, 'total_borrows')?.value as number;
    const util = factFor(facts, 'utilization')?.value as number;
    expect(util).toBeGreaterThan(0);
    expect(util).toBeLessThan(1);
    expect(util).toBeCloseTo(borrows / tvl, 12);
  });

  it('TVL is total deposits — not net of borrows, and not deposits plus borrows', () => {
    // §3.5's definition, pinned. All three readings are plausible and sources
    // genuinely disagree, so the one we chose is asserted rather than assumed.
    const values = fixtureValues();
    const deposits = values.reduce((s, v) => s + v.depositsUsd, 0);
    const borrows = values.reduce((s, v) => s + v.borrowsUsd, 0);
    const tvl = factFor(facts, 'tvl')?.value as number;
    expect(tvl).toBeCloseTo(deposits, 6);
    expect(tvl).not.toBeCloseTo(deposits - borrows, 2);
    expect(tvl).not.toBeCloseTo(deposits + borrows, 2);
  });
});

// ---------------------------------------------------------------------------
// 6. Unpriced-asset handling (§3.6.1)
// ---------------------------------------------------------------------------

describe('unpriced assets are excluded and counted, never zeroed', () => {
  it('SILVER is already unpriced in the recorded table, and is counted out', () => {
    // The fixture exercises this path by construction: prices.json omits
    // SILVER on purpose, so the golden itself covers the exclusion branch.
    const silver = recordedMarkets().find((m) => m.name === 'SILVER');
    expect(silver).toBeDefined();
    expect(priceOf(recordedPrices(), silver?.assetId ?? -1)).toBeNull();

    const coverage = factFor(facts, 'tvl')?.coverage;
    expect(coverage?.excluded).toBeGreaterThanOrEqual(1);
    expect((coverage?.entities ?? 0) + (coverage?.excluded ?? 0)).toBe(recordedMarkets().length);
  });

  it('removing a price EXCLUDES the market and lowers TVL by exactly its value', () => {
    const prices = recordedPrices();
    const usdcValue = fixtureValues().find((v) => v.market.name === 'USDC');
    expect(usdcValue).toBeDefined();

    const without = { ...prices, prices: { ...prices.prices } };
    delete without.prices[31566704];
    const fs = folksConnector.toFacts(snapshot, toFactsOpts({ prices: without }));

    const before = factFor(facts, 'tvl')?.value as number;
    const after = factFor(fs, 'tvl')?.value as number;
    const beforeCoverage = factFor(facts, 'tvl')?.coverage;
    const afterCoverage = factFor(fs, 'tvl')?.coverage;

    // Excluded and counted — not contributed as a zero, which would be
    // indistinguishable from a market holding nothing (§1.5).
    expect(afterCoverage?.entities).toBe((beforeCoverage?.entities ?? 0) - 1);
    expect(afterCoverage?.excluded).toBe((beforeCoverage?.excluded ?? 0) + 1);
    // USDC and ISOLATED_USDC share asset 31566704; only USDC is in the fixture.
    expect(before - after).toBeCloseTo(usdcValue?.depositsUsd ?? 0, 6);
    // And the whole aggregate moved, rather than the market silently becoming
    // a zero that left the ratios unchanged.
    expect(factFor(fs, 'utilization')?.value).not.toBeCloseTo(
      factFor(facts, 'utilization')?.value as number,
      6,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Degradation
// ---------------------------------------------------------------------------

describe('degradation', () => {
  it('a market that fails to read is partial + counted, not a throw', async () => {
    const ctx = makeFixtureContext({ failAppIds: [971368268] }); // ALGO
    const snap = await folksConnector.fetchRaw(ctx, {
      basis: DEFAULT_BASIS,
      kpis: [...DECLARED].filter((k) => k !== 'active_users_24h'),
    });
    expect(snap.partial).toBe(true);
    expect(snap.excludedCount).toBeGreaterThanOrEqual(1);

    const fs = folksConnector.toFacts(snap, toFactsOpts());
    expect(fs.length).toBeGreaterThan(0);
    // The caveat is on every fact, not just the one someone remembered.
    for (const fact of fs) {
      expect(fact.notes?.some((n) => /Snapshot is partial/.test(n))).toBe(true);
    }
    // And it costs confidence (§5 validation_skip).
    const degraded = factFor(fs, 'tvl')?.confidence ?? 1;
    expect(degraded).toBeLessThan(factFor(facts, 'tvl')?.confidence ?? 0);
  });

  it('a truncated packed array is skipped and counted, never coerced', () => {
    const market = recordedMarkets()[0];
    const truncated = decodeMarket(
      market as (typeof FOLKS_MARKETS)[number],
      { i: { type: 'bytes', bytes: new Uint8Array(8) }, v: { type: 'bytes', bytes: new Uint8Array(8) }, s: { type: 'bytes', bytes: new Uint8Array(8) } },
      FIXTURE_ROUND,
    );
    expect(truncated.kind).toBe('unreadable');
    // A NaN or a zero reaching a paid response is the worst outcome available.
    expect(JSON.stringify(truncated)).not.toContain('NaN');
  });

  it('an application with no global state is an absence, not a zero market', () => {
    const missing = decodeMarket(recordedMarkets()[0] as (typeof FOLKS_MARKETS)[number], null, FIXTURE_ROUND);
    expect(missing.kind).toBe('unreadable');
  });

  it('a market with zero borrows produces no NaN and no Infinity', () => {
    // gALGO: zero borrows, zero rates. Every ratio here has a zero denominator
    // somewhere, and each guard is real rather than incidental.
    const gAlgo = fixtureValues().find((v) => v.market.name === 'gALGO');
    expect(gAlgo?.borrowsUsd).toBe(0);
    const agg = aggregate([gAlgo as MarketValue]);
    for (const value of Object.values(agg)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    expect(agg.borrowApr).toBe(0);
    expect(agg.utilization).toBe(0);
  });

  it('an empty snapshot yields no facts that claim a zero protocol', () => {
    const empty = folksConnector.toFacts({ ...snapshot, entities: [] }, toFactsOpts());
    // take_rate and capital_efficiency are omitted (null by definition, §4),
    // never emitted as a plausible-looking 0.
    expect(factFor(empty, 'take_rate')).toBeUndefined();
    expect(factFor(empty, 'capital_efficiency')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. fetchRaw / I-O discipline
// ---------------------------------------------------------------------------

describe('fetchRaw', () => {
  it('reads global state for every market and records a SourceRef with the round', async () => {
    const ctx = makeFixtureContext();
    const snap = await folksConnector.fetchRaw(ctx, {
      basis: DEFAULT_BASIS,
      kpis: ['tvl'],
    });
    expect(snap.entities.filter(isMarketEntity)).toHaveLength(recordedMarkets().length);
    expect(snap.sources).toHaveLength(FOLKS_MARKETS.length);
    for (const source of snap.sources) {
      expect(source.kind).toBe('onchain');
      expect(source.round).toBe(FIXTURE_ROUND);
    }
  });

  it('skips the indexer scan unless active_users_24h was requested', async () => {
    let searched = 0;
    const ctx = makeFixtureContext();
    const spy = { ...ctx, indexer: { ...ctx.indexer, searchTransactions: async () => { searched++; return { transactions: [] }; } } };

    await folksConnector.fetchRaw(spy, { basis: DEFAULT_BASIS, kpis: ['tvl'] });
    expect(searched).toBe(0);

    await folksConnector.fetchRaw(spy, { basis: DEFAULT_BASIS, kpis: ['active_users_24h'] });
    // One walk per declared app id; the scan is what keeps the fast cycle cheap
    // by NOT running on it.
    expect(searched).toBe((folksConnector.capabilities().appIds ?? []).length);
  });

  it('priceAssets names every market asset, and nothing else', async () => {
    const assets = folksConnector.priceAssets?.(snapshot) ?? [];
    const expected = new Set(recordedMarkets().map((m) => m.assetId));
    expect(new Set(assets)).toEqual(expected);
  });

  it('healthCheck is a single cheap read, and fails honestly', async () => {
    await expect(folksConnector.healthCheck(makeFixtureContext())).resolves.toEqual({ ok: false, detail: expect.any(String) });
  });
});
