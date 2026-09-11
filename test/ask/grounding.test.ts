import { describe, it, expect } from 'vitest';

import {
  allowedNumbers,
  buildGroundingPayload,
  displayValue,
  extractNumbers,
  generatedCaveats,
  groundingViolations,
  isLowConfidence,
  lowConfidenceMarker,
  lowConfidenceViolations,
  silentOmissionViolations,
  citationViolations,
  toGroundedFact,
  type GroundedFact,
  type GroundingPayload,
} from '../../src/ask/grounding.js';
import { testFact } from '../../src/cache/testing.js';
import { confidenceTier } from '../../src/standardize/confidence.js';
import type { Plan } from '../../src/ask/schema.js';
import type { KpiId } from '../../src/standardize/kpis.js';

/**
 * The grounding checks — API_SPEC.md §3.3's guarantees, as code.
 *
 * These are the tests that have to fail when a model misbehaves, so most of
 * them are written as pairs: the correct prose passes, and a specific,
 * plausible fabrication fails. A guard that only ever sees good input proves
 * nothing.
 */

const PLAN: Plan = {
  protocols: ['tinyman', 'pact'],
  kpis: ['capital_efficiency'],
  comparison_type: 'cross_protocol_ranking',
};

function grounded(
  overrides: Partial<GroundedFact> & { value: number; metric: KpiId; protocol: string },
): GroundedFact {
  const fact = testFact({
    metric: overrides.metric,
    protocol: overrides.protocol,
    value: overrides.value,
    unit: overrides.unit ?? 'RATIO',
    confidence: overrides.confidence ?? 0.81,
  });
  return {
    ...toGroundedFact(fact, overrides.index ?? 0, overrides.protocol_name ?? overrides.protocol, 'dex'),
    ...overrides,
  };
}

function payloadOf(
  facts: GroundedFact[],
  unavailable: GroundingPayload['unavailable'] = [],
): GroundingPayload {
  return buildGroundingPayload({
    question: 'Which protocol is most capital efficient?',
    plan: PLAN,
    facts,
    unavailable,
  });
}

describe('extractNumbers', () => {
  it('reads thousands separators, decimals and signs as one number each', () => {
    expect(extractNumbers('$5,379,486 and 0.0754 and -6.6%')).toEqual([5_379_486, 0.0754, -6.6]);
  });

  it('reads the digits inside an identifier, so they must be accounted for', () => {
    // `24` here comes from `gross_fees_24h`, which is in the payload — so it
    // is allowed. The point is that the extractor does not skip it and quietly
    // create a place a fabricated number could hide.
    expect(extractNumbers('gross_fees_24h rose')).toEqual([24]);
  });
});

describe('the number rule', () => {
  const facts = [
    grounded({ protocol: 'tinyman', metric: 'capital_efficiency', value: 0.073653, index: 0 }),
    grounded({ protocol: 'pact', metric: 'capital_efficiency', value: 0.036365, index: 1 }),
  ];
  const payload = payloadOf(facts);

  it('accepts a value copied verbatim', () => {
    expect(groundingViolations('Tinyman is at 0.073653.', payload)).toEqual([]);
  });

  it('accepts a rounding of a value', () => {
    expect(groundingViolations('Tinyman is at 0.0737, Pact at 0.036.', payload)).toEqual([]);
  });

  it('accepts a ratio rendered as a percentage', () => {
    // 0.073653 * 100 = 7.3653; "7.37%" is a rounding of that rendering.
    expect(groundingViolations('Tinyman annualizes at 7.37%.', payload)).toEqual([]);
  });

  it('accepts the ratio between two facts of the same metric', () => {
    // 0.073653 / 0.036365 = 2.0253...; "2.0x" is the comparison a reader wants.
    expect(groundingViolations('Tinyman is 2.0x Pact.', payload)).toEqual([]);
  });

  /**
   * The headline assertion: a model that invents a number must fail CI.
   */
  it('REJECTS a number that is nowhere in the facts', () => {
    const violations = groundingViolations('Tinyman earned $518 in fees.', payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('ungrounded_number');
    expect(violations[0]!.detail).toContain('518');
  });

  it('REJECTS a near-miss that a looser check would let through', () => {
    // 0.0737 is a legitimate rounding of 0.073653. 0.0738 is not, and the gap
    // between them is the whole value of the check.
    expect(groundingViolations('Tinyman is at 0.0737.', payload)).toEqual([]);
    expect(groundingViolations('Tinyman is at 0.0738.', payload)).toHaveLength(1);
  });

  it('REJECTS arithmetic across facts, even when both operands are real', () => {
    // 0.073653 - 0.036365 = 0.037288. Both inputs are in the payload; the
    // difference is a number we never computed and cannot point at.
    expect(groundingViolations('The gap is 0.037288.', payload)).toHaveLength(1);
  });

  it('accepts a magnitude scaling of a dollar figure', () => {
    const usd = payloadOf([
      grounded({ protocol: 'tinyman', metric: 'tvl', value: 5_379_486, unit: 'USD', index: 0 }),
    ]);
    expect(groundingViolations('TVL is $5.4M.', usd)).toEqual([]);
    expect(groundingViolations('TVL is $5,379,486.', usd)).toEqual([]);
    expect(groundingViolations('TVL is $5.6M.', usd)).toHaveLength(1);
  });

  it('accepts numbers that appear only inside a string we supplied', () => {
    // `as_of` timestamps and the `24` in a metric id are numbers we handed the
    // model. Repeating one back is quotation, not invention.
    expect(
      groundingViolations('As of 2026-09-09, gross_fees_24h was unchanged.', payload),
    ).toEqual([]);
  });

  it('allows every value in the payload, and nothing beyond it', () => {
    const allowed = allowedNumbers(payload);
    expect(allowed.has(0.073653)).toBe(true);
    expect(allowed.has(0.0737)).toBe(true);
    expect(allowed.has(7.37)).toBe(true);
    expect(allowed.has(518)).toBe(false);
  });
});

describe('the low-confidence caveat (§3.3, §5)', () => {
  const low = grounded({
    protocol: 'pact',
    metric: 'capital_efficiency',
    value: 0.036365,
    confidence: 0.62,
    index: 0,
  });
  const payload = payloadOf([low]);

  it('requires the exact marker in prose', () => {
    expect(lowConfidenceViolations('Pact is at 0.036365.', payload)).toHaveLength(1);
    expect(
      lowConfidenceViolations(
        'Pact is at 0.036365 (confidence 0.62, informational only).',
        payload,
      ),
    ).toEqual([]);
  });

  it('names the marker the prompt mandates', () => {
    expect(lowConfidenceMarker(0.62)).toBe('confidence 0.62');
  });

  /**
   * The boundary is live, not hypothetical: Tinyman's `capital_efficiency`
   * currently grades exactly 0.70, and DATA_SCHEMA.md §5 draws the
   * informational line at `< 0.7`. So a 0.70 fact needs NO marker and a 0.69
   * fact does. Asserted in both directions because a `<=` here would put a
   * "informational only" disclaimer on our flagship number, and a `<` in the
   * ladder with a `<=` here would be a silent disagreement between the
   * published policy and the enforced one.
   */
  it('does not fire at exactly 0.70, and does fire just below it', () => {
    expect(confidenceTier(0.7)).toBe('directional');
    expect(isLowConfidence(0.7)).toBe(false);
    expect(isLowConfidence(0.69)).toBe(true);

    const boundary = payloadOf([
      grounded({ protocol: 'tinyman', metric: 'capital_efficiency', value: 0.073653, confidence: 0.7 }),
    ]);
    expect(lowConfidenceViolations('Tinyman is at 0.073653.', boundary)).toEqual([]);

    const below = payloadOf([
      grounded({ protocol: 'tinyman', metric: 'capital_efficiency', value: 0.073653, confidence: 0.69 }),
    ]);
    expect(lowConfidenceViolations('Tinyman is at 0.073653.', below)).toHaveLength(1);
  });

  it('puts the caveat in caveats[] whether or not the model wrote one', () => {
    expect(generatedCaveats(payload).some((c) => c.includes('0.62'))).toBe(true);
  });
});

describe('a declined KPI is never silently omitted (§1.5)', () => {
  const payload = payloadOf(
    [grounded({ protocol: 'tinyman', metric: 'take_rate', value: 0.25, index: 0 })],
    [
      {
        protocol: 'pact',
        protocol_name: 'Pact',
        metric: 'take_rate',
        reason: 'Pact declines "take_rate": pact_fee_bps is null on 100% of pools.',
        declined: true,
      },
    ],
  );

  it('REJECTS a ranking that just leaves the declining protocol out', () => {
    const violations = silentOmissionViolations('Tinyman has the highest take rate, 0.25.', payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('silent_omission');
  });

  it('accepts an answer that says the protocol does not publish it', () => {
    expect(
      silentOmissionViolations(
        'Tinyman has the highest take rate at 0.25. Pact does not publish its fee split, so no ' +
          'take rate is available for it.',
        payload,
      ),
    ).toEqual([]);
  });

  it('carries the reason into caveats[] regardless', () => {
    expect(generatedCaveats(payload).some((c) => c.includes('pact_fee_bps'))).toBe(true);
  });
});

describe('citations', () => {
  const payload = payloadOf([
    grounded({ protocol: 'tinyman', metric: 'tvl', value: 1, unit: 'USD', index: 0 }),
  ]);

  it('accepts an index inside facts[]', () => {
    expect(citationViolations([{ claim: 'x', fact_index: 0 }], payload)).toEqual([]);
  });

  it('REJECTS an index past the end — a citation to nothing looks checkable', () => {
    expect(citationViolations([{ claim: 'x', fact_index: 3 }], payload)).toHaveLength(1);
    expect(citationViolations([{ claim: 'x', fact_index: -1 }], payload)).toHaveLength(1);
  });
});

describe('displayValue', () => {
  it('formats each unit the way prose should read it', () => {
    expect(displayValue(5_379_486, 'USD')).toBe('$5,379,486.00');
    expect(displayValue(0.0754, 'RATIO')).toBe('0.0754 (7.54%)');
    expect(displayValue(411, 'COUNT')).toBe('411');
  });
});
