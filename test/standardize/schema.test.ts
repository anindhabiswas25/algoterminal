import { describe, expect, it } from 'vitest';

import {
  CoverageSchema,
  ErrorFactSchema,
  KpiFactSchema,
  SourceRefSchema,
  isErrorFact,
  isSuccessFact,
  makeErrorFact,
} from '../../src/standardize/schema.js';
import { assetIdNote, readAssetIdNote } from '../../src/standardize/types.js';

/**
 * DATA_SCHEMA.md §2. This module is the one place where a silent regression
 * corrupts every paid response, so the envelope is tested field-for-field
 * rather than by a single happy-path smoke test.
 */

/** The §2 example fact, verbatim. */
const VALID_FACT = {
  metric: 'gross_fees_24h',
  protocol: 'tinyman',
  value: 12847.32,
  unit: 'USD',
  timestamp: '2026-09-08T14:32:11Z',
  as_of: '2026-09-08T14:30:00Z',
  source: [
    {
      name: 'tinyman-analytics',
      url: 'https://mainnet.analytics.tinyman.org/api/v1/pools/?limit=500',
      kind: 'rest',
      retrieved_at: '2026-09-08T14:30:02Z',
    },
  ],
  confidence: 0.95,
  is_estimated: false,
  estimation_method: null,
  methodology_version: '1.0.0',
  cache: 'hit',
  stale: false,
  coverage: { entities: 412, excluded: 7, basis: 'all_pools_usd_priced' },
  notes: [],
} as const;

describe('KpiFact — §2 envelope', () => {
  it('round-trips the §2 example fact unchanged', () => {
    const parsed = KpiFactSchema.parse(VALID_FACT);
    expect(parsed).toEqual(VALID_FACT);
    expect(KpiFactSchema.parse(parsed)).toEqual(parsed);
  });

  it('carries every field the §2 envelope lists', () => {
    const parsed = KpiFactSchema.parse(VALID_FACT);
    // Field-for-field against the §2 jsonc block, in its order.
    for (const field of [
      'metric',
      'protocol',
      'value',
      'unit',
      'timestamp',
      'as_of',
      'source',
      'confidence',
      'is_estimated',
      'estimation_method',
      'methodology_version',
      'cache',
      'stale',
      'coverage',
      'notes',
    ]) {
      expect(parsed, `§2 field ${field} missing from the parsed fact`).toHaveProperty(field);
    }
  });

  it('rejects a field §2 does not define, rather than silently dropping it', () => {
    expect(KpiFactSchema.safeParse({ ...VALID_FACT, p_f_ratio: 12 }).success).toBe(false);
  });

  it('accepts every §2.1 unit and rejects a percent-style unit', () => {
    for (const [unit, value] of [
      ['USD', 12847.32],
      ['RATIO', 0.0369],
      ['COUNT', 412],
    ] as const) {
      expect(KpiFactSchema.safeParse({ ...VALID_FACT, unit, value }).success).toBe(true);
    }
    expect(KpiFactSchema.safeParse({ ...VALID_FACT, unit: 'PERCENT' }).success).toBe(false);
  });

  it('rejects a RATIO carried as a string — §2.1 forbids it outright', () => {
    const asString = KpiFactSchema.safeParse({
      ...VALID_FACT,
      unit: 'RATIO',
      // exactly what Tinyman's `annual_percentage_rate` hands us
      value: '0.036882',
    });
    expect(asString.success).toBe(false);
  });

  it('rejects a non-finite RATIO, which is what x/0 ratio arithmetic produces', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(KpiFactSchema.safeParse({ ...VALID_FACT, unit: 'RATIO', value }).success).toBe(false);
    }
  });

  it('rejects a non-integer COUNT', () => {
    expect(KpiFactSchema.safeParse({ ...VALID_FACT, unit: 'COUNT', value: 412.5 }).success).toBe(
      false,
    );
  });

  it('requires an asset_id note on an ASSET_UNITS fact (§2.1)', () => {
    const withoutAssetId = { ...VALID_FACT, unit: 'ASSET_UNITS', value: 1234.5, notes: [] };
    expect(KpiFactSchema.safeParse(withoutAssetId).success).toBe(false);

    const withAssetId = { ...withoutAssetId, notes: [assetIdNote(31566704)] };
    expect(KpiFactSchema.safeParse(withAssetId).success).toBe(true);
    expect(readAssetIdNote([assetIdNote(31566704)])).toBe(31566704);
  });

  it('rejects a metric that is not in the §4 registry, including the §4.2 deferrals', () => {
    expect(KpiFactSchema.safeParse({ ...VALID_FACT, metric: 'p_f_ratio' }).success).toBe(false);
  });

  it('requires provenance: a fact with a value and no source is not reproducible (§1.4)', () => {
    expect(KpiFactSchema.safeParse({ ...VALID_FACT, source: [] }).success).toBe(false);
    const { source: _omitted, ...noSource } = VALID_FACT;
    expect(KpiFactSchema.safeParse(noSource).success).toBe(false);
  });
});

describe('KpiFact — §1.2, never launder an estimate', () => {
  it('FAILS when is_estimated is true and estimation_method is null', () => {
    const result = KpiFactSchema.safeParse({
      ...VALID_FACT,
      is_estimated: true,
      estimation_method: null,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('estimation_method');
  });

  it('FAILS when is_estimated is true and estimation_method is blank whitespace', () => {
    expect(
      KpiFactSchema.safeParse({ ...VALID_FACT, is_estimated: true, estimation_method: '   ' })
        .success,
    ).toBe(false);
  });

  it('accepts is_estimated true with a documented method (§3.5)', () => {
    expect(
      KpiFactSchema.safeParse({
        ...VALID_FACT,
        is_estimated: true,
        estimation_method: 'annualized_rate_to_daily_simple',
      }).success,
    ).toBe(true);
  });

  it('rejects an estimation_method on a fact claiming not to be estimated', () => {
    expect(
      KpiFactSchema.safeParse({
        ...VALID_FACT,
        is_estimated: false,
        estimation_method: 'annualized_rate_to_daily_simple',
      }).success,
    ).toBe(false);
  });
});

describe('KpiFact — §2, a null value requires an error', () => {
  it('FAILS on value null with no error object', () => {
    const result = KpiFactSchema.safeParse({ ...VALID_FACT, value: null });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('error');
  });

  it('FAILS on value null with no error even when unit is also null', () => {
    expect(KpiFactSchema.safeParse({ ...VALID_FACT, value: null, unit: null }).success).toBe(false);
  });

  it('accepts the §2 error fact', () => {
    const errorFact = {
      metric: 'utilization',
      protocol: 'tinyman',
      value: null,
      unit: null,
      timestamp: '2026-09-08T14:32:11Z',
      error: {
        code: 'KPI_NOT_APPLICABLE',
        message: "utilization is defined for lending protocols only; tinyman is class 'dex'",
      },
      confidence: 0.0,
      methodology_version: '1.0.0',
    };
    expect(KpiFactSchema.parse(errorFact)).toEqual(errorFact);
    expect(ErrorFactSchema.parse(errorFact)).toEqual(errorFact);
  });

  it('rejects an error fact that claims confidence in a value it does not have', () => {
    expect(
      KpiFactSchema.safeParse({
        metric: 'utilization',
        protocol: 'tinyman',
        value: null,
        unit: null,
        timestamp: '2026-09-08T14:32:11Z',
        error: { code: 'KPI_NOT_APPLICABLE', message: 'nope' },
        confidence: 0.9,
        methodology_version: '1.0.0',
      }).success,
    ).toBe(false);
  });
});

describe('SourceRef — §1.4 / CONNECTOR_GUIDE §4.2', () => {
  const restRef = {
    name: 'tinyman-analytics',
    url: 'https://mainnet.analytics.tinyman.org/api/v1/pools/?limit=500',
    kind: 'rest',
    retrieved_at: '2026-09-08T14:30:02Z',
  };

  it('accepts a rest ref with no app_id or round', () => {
    expect(SourceRefSchema.parse(restRef)).toEqual(restRef);
  });

  it('FAILS an onchain ref missing both app_id and round', () => {
    const result = SourceRefSchema.safeParse({ ...restRef, kind: 'onchain' });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('app_id');
    expect(paths).toContain('round');
  });

  it('FAILS an onchain ref missing only the round — reproducibility needs it', () => {
    expect(SourceRefSchema.safeParse({ ...restRef, kind: 'onchain', app_id: 971368268 }).success).toBe(
      false,
    );
  });

  it('FAILS an onchain ref missing only the app_id', () => {
    expect(SourceRefSchema.safeParse({ ...restRef, kind: 'onchain', round: 55_000_000 }).success).toBe(
      false,
    );
  });

  it('accepts a complete onchain ref', () => {
    const ref = { ...restRef, kind: 'onchain', app_id: 971368268, round: 55_000_000 };
    expect(SourceRefSchema.parse(ref)).toEqual(ref);
  });

  it('rejects an onchain ref inside a fact, not just in isolation', () => {
    expect(
      KpiFactSchema.safeParse({
        ...VALID_FACT,
        source: [{ ...restRef, kind: 'onchain' }],
      }).success,
    ).toBe(false);
  });
});

describe('Coverage — §2 / §3.6', () => {
  it('accepts the three §2/§3.5 bases and rejects anything else', () => {
    for (const basis of ['all_pools_usd_priced', 'verified_only', 'total_deposits']) {
      expect(CoverageSchema.parse({ entities: 1, excluded: 0, basis }).basis).toBe(basis);
    }
    expect(CoverageSchema.safeParse({ entities: 1, excluded: 0, basis: 'everything' }).success).toBe(
      false,
    );
  });

  it('rejects a negative or fractional entity count', () => {
    expect(CoverageSchema.safeParse({ entities: -1, excluded: 0, basis: 'verified_only' }).success).toBe(
      false,
    );
    expect(CoverageSchema.safeParse({ entities: 1.5, excluded: 0, basis: 'verified_only' }).success).toBe(
      false,
    );
  });
});

describe('makeErrorFact', () => {
  const fact = makeErrorFact({
    metric: 'utilization',
    protocol: 'tinyman',
    code: 'KPI_NOT_APPLICABLE',
    message: "utilization is defined for lending protocols only; tinyman is class 'dex'",
    methodologyVersion: '1.0.0',
    timestamp: '2026-09-08T14:32:11Z',
  });

  it('produces the §2 error-fact shape', () => {
    expect(fact).toEqual({
      metric: 'utilization',
      protocol: 'tinyman',
      value: null,
      unit: null,
      timestamp: '2026-09-08T14:32:11Z',
      error: {
        code: 'KPI_NOT_APPLICABLE',
        message: "utilization is defined for lending protocols only; tinyman is class 'dex'",
      },
      confidence: 0,
      methodology_version: '1.0.0',
    });
  });

  it('produces something the canonical KpiFact schema also accepts', () => {
    expect(KpiFactSchema.parse(fact)).toEqual(fact);
  });

  it('is confidence 0 by construction — there is no number to be confident about', () => {
    expect(fact.confidence).toBe(0);
  });

  it('narrows through the type guards', () => {
    const parsed = KpiFactSchema.parse(fact);
    expect(isErrorFact(parsed)).toBe(true);
    expect(isSuccessFact(parsed)).toBe(false);
    expect(isSuccessFact(KpiFactSchema.parse(VALID_FACT))).toBe(true);
  });

  it('rejects a non-UPPER_SNAKE error code', () => {
    expect(() =>
      makeErrorFact({
        metric: 'utilization',
        protocol: 'tinyman',
        code: 'not applicable',
        message: 'x',
        methodologyVersion: '1.0.0',
        timestamp: '2026-09-08T14:32:11Z',
      }),
    ).toThrow();
  });
});
