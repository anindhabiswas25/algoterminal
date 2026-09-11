import { describe, expect, it } from 'vitest';

import {
  applyServePenalty,
  CONFIDENCE_FLOOR,
  DERIVATION_BASE,
  L2_SNAPSHOT_FLOOR,
  PENALTIES,
  combineConfidence,
  computeConfidence,
  confidenceTier,
  type Derivation,
  type PenaltyKind,
} from '../../src/standardize/confidence.js';
import { KPI_IDS, getKpi, type KpiId } from '../../src/standardize/kpis.js';

/**
 * A KPI with no §4.1 `maxConfidence`, for the cases that exercise the base and
 * penalty tables rather than the caps. `metric` is required (CONNECTOR_GUIDE
 * §4.4), so every case has to name one; naming an uncapped KPI keeps these
 * expectations equal to the raw §5 arithmetic.
 */
const UNCAPPED: KpiId = 'tvl';

/**
 * DATA_SCHEMA.md §5. Expected values below are computed by hand from the two
 * §5 tables, not by re-running the implementation's arithmetic — the point is
 * to catch the implementation drifting away from the published document.
 */

describe('computeConfidence — §5 base table, one case per row', () => {
  const cases: ReadonlyArray<[string, Derivation, number]> = [
    ['directly reported by the protocol API', { kind: 'reported' }, 0.95],
    ['directly read from on-chain state', { kind: 'onchain' }, 0.95],
    ['arithmetic on directly-reported values', { kind: 'arithmetic' }, 0.9],
    // 0.90 x price_confidence (§3.7)
    ['USD conversion at a hardcoded stable price', { kind: 'usd_conversion', priceConfidence: 1 }, 0.9],
    ['USD conversion via Tinyman assets (0.95)', { kind: 'usd_conversion', priceConfidence: 0.95 }, 0.86],
    ['USD conversion via Pact (0.90)', { kind: 'usd_conversion', priceConfidence: 0.9 }, 0.81],
    ['USD conversion via Vestige (0.85)', { kind: 'usd_conversion', priceConfidence: 0.85 }, 0.77],
    ['documented estimation (annualized -> daily)', { kind: 'documented_estimation' }, 0.85],
    ['fallback constant (Tinyman V2 default fee)', { kind: 'fallback_constant' }, 0.7],
    ['indexer aggregation over addresses', { kind: 'indexer_address_aggregation' }, 0.8],
  ];

  it.each(cases)('%s -> %o', (_label, derivation, expected) => {
    expect(computeConfidence({ derivation, metric: UNCAPPED })).toBe(expected);
  });

  it('exposes the §5 base table verbatim', () => {
    expect(DERIVATION_BASE).toEqual({
      reported: 0.95,
      onchain: 0.95,
      arithmetic: 0.9,
      usd_conversion: 0.9,
      documented_estimation: 0.85,
      fallback_constant: 0.7,
      indexer_address_aggregation: 0.8,
    });
  });

  it('rejects a price confidence outside [0,1] rather than emitting nonsense', () => {
    expect(() =>
      computeConfidence({ derivation: { kind: 'usd_conversion', priceConfidence: 1.5 }, metric: UNCAPPED }),
    ).toThrow(RangeError);
    expect(() =>
      computeConfidence({ derivation: { kind: 'usd_conversion', priceConfidence: -0.1 }, metric: UNCAPPED }),
    ).toThrow(RangeError);
  });
});

describe('computeConfidence — §5 penalty table, one case per row', () => {
  // Every row applied to the same 0.90 `arithmetic` base, so the expected
  // value is just the multiplier (or the subtraction) made visible.
  const cases: ReadonlyArray<[PenaltyKind, number]> = [
    ['stale_l1', 0.81], // 0.90 x 0.90
    ['l2_snapshot', 0.63], // 0.90 x 0.70
    ['high_exclusion', 0.81], // 0.90 x 0.90
    ['defillama_divergence', 0.81], // 0.90 x 0.90
    ['folks_retention_divergence', 0.8], // 0.90 - 0.10, ADDITIVE
    ['validation_skip', 0.77], // 0.90 x 0.85 = 0.765 -> 0.77
  ];

  it.each(cases)('%s -> %o', (penalty, expected) => {
    expect(
      computeConfidence({ derivation: { kind: 'arithmetic' }, penalties: [penalty], metric: UNCAPPED }),
    ).toBe(expected);
  });

  it('exposes the §5 penalty table verbatim, with the one additive row marked', () => {
    expect(PENALTIES).toEqual({
      stale_l1: { mode: 'multiply', amount: 0.9 },
      l2_snapshot: { mode: 'multiply', amount: 0.7 },
      high_exclusion: { mode: 'multiply', amount: 0.9 },
      defillama_divergence: { mode: 'multiply', amount: 0.9 },
      folks_retention_divergence: { mode: 'subtract', amount: 0.1 },
      validation_skip: { mode: 'multiply', amount: 0.85 },
    });
  });

  it('compounds multiplicative penalties', () => {
    // 0.95 x 0.90 x 0.90 = 0.7695 -> 0.77
    expect(
      computeConfidence({
        derivation: { kind: 'reported' },
        penalties: ['stale_l1', 'high_exclusion'],
        metric: UNCAPPED,
      }),
    ).toBe(0.77);
  });

  it('is order-independent in the declared penalty list', () => {
    const a = computeConfidence({
      derivation: { kind: 'reported' },
      penalties: ['stale_l1', 'validation_skip', 'folks_retention_divergence'],
      metric: UNCAPPED,
    });
    const b = computeConfidence({
      derivation: { kind: 'reported' },
      penalties: ['folks_retention_divergence', 'validation_skip', 'stale_l1'],
      metric: UNCAPPED,
    });
    expect(a).toBe(b);
  });
});

describe('the Folks retention penalty is ADDITIVE, not multiplicative (§3.5)', () => {
  it('subtracts exactly 0.10 from a 0.85 documented-estimation base', () => {
    const actual = computeConfidence({
      derivation: { kind: 'documented_estimation' },
      penalties: ['folks_retention_divergence'],
      metric: UNCAPPED,
    });
    // §3.5's Folks fee flow is is_estimated with base 0.85; a >5% retention
    // divergence drops it by 0.10.
    expect(actual).toBe(0.75);
    // If it were ever refactored into a multiplier it would land here instead,
    // 0.02 higher — small enough to look like rounding, large enough to move a
    // fact across the 0.7 buyer-facing boundary on a weaker base.
    expect(actual).not.toBe(0.77);
  });

  it('differs from a 0.90 multiplier at every base in the §5 table', () => {
    for (const kind of Object.keys(DERIVATION_BASE) as Array<keyof typeof DERIVATION_BASE>) {
      if (kind === 'usd_conversion') continue;
      const additive = computeConfidence({
        derivation: { kind },
        penalties: ['folks_retention_divergence'],
        metric: UNCAPPED,
      });
      const asIfMultiplied = Math.round(DERIVATION_BASE[kind] * 0.9 * 100) / 100;
      expect(additive, kind).not.toBe(asIfMultiplied);
    }
  });

  it('applies after the multiplicative penalties, per §5’s "base x penalties" formula', () => {
    // 0.90 x 0.90 = 0.81, then -0.10 = 0.71.
    // Subtracting first would give (0.90 - 0.10) x 0.90 = 0.72.
    expect(
      computeConfidence({
        derivation: { kind: 'arithmetic' },
        penalties: ['stale_l1', 'folks_retention_divergence'],
        metric: UNCAPPED,
      }),
    ).toBe(0.71);
  });
});

/** Every §5 base row as a `Derivation`, at the most favourable price confidence. */
const ALL_DERIVATIONS: ReadonlyArray<[keyof typeof DERIVATION_BASE, Derivation]> = (
  Object.keys(DERIVATION_BASE) as Array<keyof typeof DERIVATION_BASE>
).map((kind) => [kind, kind === 'usd_conversion' ? { kind, priceConfidence: 1 } : { kind }]);

describe('active_users_24h — the §4.1 hard cap of 0.80', () => {
  // §4.1: the cap applies "always, on every protocol" — so it must hold for
  // every row of the §5 base table, not only the indexer row whose base
  // happens to sit at 0.80 anyway. A cap that only works because one base is
  // already low is not a cap; the `reported`/`onchain`/`arithmetic` rows are
  // the ones that would silently publish a 0.95 active-users figure.
  it.each(ALL_DERIVATIONS)('caps the %s derivation at exactly min(base, 0.80)', (kind, derivation) => {
    const expected = Math.min(DERIVATION_BASE[kind], 0.8);
    expect(computeConfidence({ derivation, metric: 'active_users_24h' })).toBe(expected);
  });

  it('applies every §4 registry cap, for every derivation — not just this one KPI', () => {
    // Generalised over the registry, so a cap added to a future KPI row is
    // enforced by this test on the day it is added rather than on the day
    // someone remembers to write a test for it.
    for (const metric of KPI_IDS) {
      const cap = getKpi(metric).maxConfidence;
      if (cap === undefined) continue;
      for (const [kind, derivation] of ALL_DERIVATIONS) {
        expect(computeConfidence({ derivation, metric }), `${metric}/${kind}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('caps even the strongest possible derivation', () => {
    // A connector declaring `reported` (0.95) for active users still gets 0.80:
    // the cap is enforced here, not by the caller (CONNECTOR_GUIDE §4.4).
    expect(computeConfidence({ derivation: { kind: 'reported' }, metric: 'active_users_24h' })).toBe(0.8);
    expect(computeConfidence({ derivation: { kind: 'onchain' }, metric: 'active_users_24h' })).toBe(0.8);
  });

  it('still applies penalties below the cap', () => {
    // 0.95 x 0.70 = 0.665 -> 0.67, which is already under the cap.
    expect(
      computeConfidence({
        derivation: { kind: 'reported' },
        penalties: ['l2_snapshot'],
        metric: 'active_users_24h',
      }),
    ).toBe(0.67);
  });

  it('caps nothing else', () => {
    for (const metric of KPI_IDS) {
      if (metric === 'active_users_24h') continue;
      expect(computeConfidence({ derivation: { kind: 'reported' }, metric }), metric).toBe(0.95);
    }
  });

  it('ignores an unknown metric string rather than throwing', () => {
    // `metric` is typed `KpiId`, so this is unreachable from TypeScript. The
    // cast stands in for the untyped boundary (a JS caller, a metric read off a
    // request path): an id with no §4 registry row finds no cap and is left
    // alone rather than throwing. It cannot become a published fact regardless,
    // since `KpiFact.metric` is `z.enum(KPI_IDS)` (§2).
    expect(computeConfidence({ derivation: { kind: 'reported' }, metric: 'p_f_ratio' as KpiId })).toBe(0.95);
  });
});

describe('floors — §5', () => {
  it('never drops an L2-snapshot fact below 0.4', () => {
    // 0.70 x 0.70 x 0.85 x 0.90 x 0.90 = 0.337, floored to 0.4.
    expect(
      computeConfidence({
        derivation: { kind: 'fallback_constant' },
        penalties: ['l2_snapshot', 'validation_skip', 'stale_l1', 'defillama_divergence'],
        metric: UNCAPPED,
      }),
    ).toBe(L2_SNAPSHOT_FLOOR);
  });

  it('holds the 0.4 floor even with the additive penalty stacked on', () => {
    expect(
      computeConfidence({
        derivation: { kind: 'fallback_constant' },
        penalties: [
          'l2_snapshot',
          'validation_skip',
          'stale_l1',
          'defillama_divergence',
          'high_exclusion',
          'folks_retention_divergence',
        ],
        metric: UNCAPPED,
      }),
    ).toBe(L2_SNAPSHOT_FLOOR);
  });

  it('holds the 0.4 floor for active_users_24h too, under its 0.80 cap', () => {
    const c = computeConfidence({
      derivation: { kind: 'indexer_address_aggregation' },
      penalties: ['l2_snapshot', 'validation_skip', 'stale_l1', 'defillama_divergence'],
      metric: 'active_users_24h',
    });
    expect(c).toBe(L2_SNAPSHOT_FLOOR);
    expect(c).toBeLessThanOrEqual(0.8);
  });

  it('uses the global 0.1 floor when the fact is not an L2 snapshot', () => {
    // 0.90 x 0.05 = 0.045, below the floor.
    expect(
      computeConfidence({ derivation: { kind: 'usd_conversion', priceConfidence: 0.05 }, metric: UNCAPPED }),
    ).toBe(CONFIDENCE_FLOOR);
  });

  it('never returns anything outside [0.1, 1]', () => {
    const all = Object.keys(PENALTIES) as PenaltyKind[];
    for (const kind of Object.keys(DERIVATION_BASE) as Array<keyof typeof DERIVATION_BASE>) {
      const derivation: Derivation =
        kind === 'usd_conversion' ? { kind, priceConfidence: 0.85 } : { kind };
      for (const penalties of [[], all, ['folks_retention_divergence'] as PenaltyKind[]]) {
        const c = computeConfidence({ derivation, penalties, metric: UNCAPPED });
        expect(c).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rounds to 2dp, per §5', () => {
    // 0.90 x 0.85 = 0.765
    expect(
      computeConfidence({ derivation: { kind: 'arithmetic' }, penalties: ['validation_skip'], metric: UNCAPPED }),
    ).toBe(0.77);
    // 0.95 x 0.85 = 0.8075
    expect(
      computeConfidence({ derivation: { kind: 'reported' }, penalties: ['validation_skip'], metric: UNCAPPED }),
    ).toBe(0.81);
  });
});

describe('combineConfidence — §5 composite facts take the MINIMUM', () => {
  it('returns the minimum, not the mean', () => {
    const facts = [{ confidence: 0.95 }, { confidence: 0.45 }];
    expect(combineConfidence(facts)).toBe(0.45);
  });

  it('fails under a mean implementation: the weak leg must survive the combine', () => {
    // A 0.95 TVL against a 0.45 fee estimate averages to 0.70, which reads as
    // "directionally sound" on the §5 buyer ladder and hides exactly the case a
    // risk agent needs to see. Asserting both the value and the ladder verdict
    // means a mean implementation cannot slip past this test.
    const combined = combineConfidence([{ confidence: 0.95 }, { confidence: 0.45 }]);
    expect(combined).not.toBe(0.7);
    expect(combined).toBeLessThan(0.7); // informational, must be caveated in /ask
  });

  it('is unaffected by how many strong legs sit alongside the weak one', () => {
    // Under a mean, each extra 0.95 would drag the result upward.
    const weak = { confidence: 0.4 };
    expect(combineConfidence([weak, { confidence: 0.95 }])).toBe(0.4);
    expect(
      combineConfidence([weak, { confidence: 0.95 }, { confidence: 0.95 }, { confidence: 0.95 }]),
    ).toBe(0.4);
  });

  it('is order-independent', () => {
    expect(combineConfidence([{ confidence: 0.9 }, { confidence: 0.6 }])).toBe(
      combineConfidence([{ confidence: 0.6 }, { confidence: 0.9 }]),
    );
  });

  it('returns the single confidence for a one-fact composite', () => {
    expect(combineConfidence([{ confidence: 0.86 }])).toBe(0.86);
  });

  it('returns 0 for an empty composite — nothing combined is nothing known', () => {
    expect(combineConfidence([])).toBe(0);
  });

  it('propagates an error fact’s 0 confidence through a /compare', () => {
    expect(combineConfidence([{ confidence: 0.95 }, { confidence: 0 }])).toBe(0);
  });
});

describe('confidenceTier — the §5 buyer ladder', () => {
  it('grades at the published boundaries, inclusive on the lower bound', () => {
    expect(confidenceTier(0.95)).toBe('safe_to_act');
    expect(confidenceTier(0.9)).toBe('safe_to_act');
    expect(confidenceTier(0.89)).toBe('directional');
    expect(confidenceTier(0.7)).toBe('directional');
    expect(confidenceTier(0.69)).toBe('informational');
    expect(confidenceTier(0.4)).toBe('informational');
  });

  it('puts an error fact’s 0 confidence in the informational band', () => {
    expect(confidenceTier(0)).toBe('informational');
  });
});

// ---------------------------------------------------------------------------
// Serve-time cache penalties (§5, ARCHITECTURE.md §4.5)
// ---------------------------------------------------------------------------

describe('applyServePenalty', () => {
  it('applies the §5 stale_l1 multiplier', () => {
    expect(applyServePenalty(0.9, 'stale_l1', 'tvl')).toBe(0.81);
    expect(applyServePenalty(0.7, 'stale_l1', 'tvl')).toBe(0.63);
  });

  it('applies the §5 l2_snapshot multiplier and its 0.4 floor', () => {
    expect(applyServePenalty(0.9, 'l2_snapshot', 'tvl')).toBe(0.63);
    // 0.5 x 0.7 = 0.35, which §5 floors at 0.40: an L2 row is a number that
    // was true recently, and grading it at the global 0.1 floor would say
    // less about it than we know.
    expect(applyServePenalty(0.5, 'l2_snapshot', 'tvl')).toBe(L2_SNAPSHOT_FLOOR);
    expect(applyServePenalty(0.1, 'l2_snapshot', 'tvl')).toBe(L2_SNAPSHOT_FLOOR);
  });

  it('re-applies the §4.1 per-KPI cap', () => {
    // A caller cannot smuggle an active-users fact past the 0.80 cap by
    // handing in a confidence that was never capped in the first place.
    expect(applyServePenalty(1, 'stale_l1', 'active_users_24h')).toBe(0.8);
  });

  it('only ever lowers a confidence', () => {
    for (const c of [0.1, 0.4, 0.63, 0.8, 0.95, 1]) {
      expect(applyServePenalty(c, 'stale_l1', 'tvl')).toBeLessThanOrEqual(c);
    }
  });

  it('agrees with computeConfidence when the penalty is known up front', () => {
    // The two paths exist because a freshness penalty is not knowable at
    // compute time; where both CAN be expressed, they must not disagree.
    const upFront = computeConfidence({
      derivation: { kind: 'reported' },
      penalties: ['stale_l1'],
      metric: 'tvl',
    });
    const atServeTime = applyServePenalty(
      computeConfidence({ derivation: { kind: 'reported' }, metric: 'tvl' }),
      'stale_l1',
      'tvl',
    );
    expect(atServeTime).toBe(upFront);
  });
});
