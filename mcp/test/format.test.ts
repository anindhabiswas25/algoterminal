import { describe, expect, it } from 'vitest';

import { renderCompareResult, renderFact, renderValue } from '../src/format.js';
import { BASIS_CAVEAT, COMPARISON, CROSS_CLASS_CAVEAT, TINYMAN_TVL, TVL_NOTE } from './fixtures.js';
import type { KpiFact } from '../src/types.js';

describe('values are never transformed', () => {
  it('prints a USD value exactly, grouped but not rounded', () => {
    expect(renderValue(5344337.42, 'USD')).toBe('5344337.42 USD ($5,344,337.42)');
  });

  it('does NOT convert a RATIO to a percentage — that numeral is not one the API returned', () => {
    const out = renderValue(0.0369, 'RATIO');
    expect(out).toContain('0.0369');
    expect(out).toContain('decimal fraction');
    expect(out).not.toContain('3.69%');
    // The explanation of the convention may cite the convention; the value must not be restated as one.
    expect(out.startsWith('0.0369 ')).toBe(true);
  });

  it('says why a null is a null, rather than showing zero', () => {
    expect(renderValue(null, 'USD')).toContain('could not compute');
    expect(renderValue(null, 'USD')).not.toMatch(/\$0/);
  });

  it('does not abbreviate large numbers to millions', () => {
    const out = renderValue(5344337, 'USD');
    expect(out).not.toMatch(/5\.3\s?[Mm]/);
    expect(out).toContain('5344337');
  });
});

describe('confidence is a sentence, not a field', () => {
  const at = (confidence: number): string => renderFact({ ...TINYMAN_TVL, confidence });

  it('is calm at or above 0.9', () => {
    expect(at(0.95)).toContain('safe to act on');
    expect(at(0.95)).not.toContain('!!');
  });

  it('warns in the 0.7-0.9 band and says what the band means', () => {
    const out = at(0.7);
    expect(out).toContain('DIRECTIONALLY SOUND ONLY');
    expect(out).toContain('not good enough to settle a trade on');
    expect(out).toMatch(/State this qualification whenever you state the number/);
  });

  it('below 0.7 says so in plain language and forbids presenting it as fact', () => {
    const out = at(0.55);
    expect(out).toContain('LOW CONFIDENCE 0.55');
    expect(out).toContain('INFORMATIONAL ONLY');
    expect(out).toMatch(/must NOT be presented as a fact/);
    expect(out).toMatch(/repeat this warning with it/);
  });
});

describe('a rendered KpiFact', () => {
  const out = renderFact(TINYMAN_TVL);

  it('keeps the value, the confidence and every note', () => {
    expect(out).toContain('tinyman / tvl');
    expect(out).toContain('5344337');
    expect(out).toContain('CONFIDENCE 0.7');
    expect(out).toContain(TVL_NOTE);
  });

  it('labels notes as travelling with the number', () => {
    expect(out).toMatch(/Do not drop them when summarizing/);
  });

  it('distinguishes as_of from timestamp, which are different things', () => {
    expect(out).toContain('as_of 2026-09-08T14:30:00Z — the moment the data describes');
    expect(out).toContain('computed 2026-09-08T14:32:11Z');
  });

  it('reports coverage, including the basis two facts might differ on', () => {
    expect(out).toContain('412 entities included, 7 excluded');
    expect(out).toContain('all_pools_usd_priced');
  });

  it('flags staleness loudly when a fact is stale', () => {
    const stale = renderFact({ ...TINYMAN_TVL, stale: true, cache: 'stale' });
    expect(stale).toContain('STALE');
    expect(stale).toMatch(/not a current one/);
  });

  it('flags an estimate and names its method', () => {
    const est = renderFact({ ...TINYMAN_TVL, is_estimated: true, estimation_method: 'reserve-factor fallback' });
    expect(est).toContain('ESTIMATED, not measured');
    expect(est).toContain('reserve-factor fallback');
  });

  it('reports a failed leg as failed, and forbids filling it in', () => {
    const failed: KpiFact = {
      metric: 'take_rate',
      protocol: 'pact',
      value: null,
      unit: null,
      timestamp: '2026-09-09T16:00:00Z',
      confidence: 0,
      methodology_version: '1.2.0',
      error: { code: 'KPI_NOT_APPLICABLE', message: 'Pact does not publish its fee split.' },
    };
    const out2 = renderFact(failed);
    expect(out2).toContain('UNAVAILABLE — KPI_NOT_APPLICABLE');
    expect(out2).toMatch(/Do not fill the gap with a zero or an estimate/);
  });
});

describe('a rendered comparison', () => {
  const out = renderCompareResult(COMPARISON);

  it('passes comparability.caveats through verbatim, in full', () => {
    expect(out).toContain(CROSS_CLASS_CAVEAT);
    expect(out).toContain(BASIS_CAVEAT);
  });

  it('keeps the cross-class justification, which is the product', () => {
    expect(out).toContain('§3.1 defines gross_fees identically for both');
  });

  it('keeps the different-basis warning about legs measured on different populations', () => {
    expect(out).toContain('total_deposits');
    expect(out).toContain('all_pools_usd_priced');
  });

  it('instructs against paraphrasing the caveats', () => {
    expect(out).toMatch(/do not paraphrase or condense them/i);
  });

  it('says comparability.confidence is the minimum, not the mean', () => {
    expect(out).toContain('COMPARABILITY: 0.62');
    expect(out).toContain('MINIMUM across the legs, never the mean');
  });

  it('warns that rank 1 is largest, not best', () => {
    expect(out).toMatch(/Rank 1 is the LARGEST value, not the "best" one/);
  });

  it('reports every leg, including the low-confidence stale estimate', () => {
    expect(out).toContain('tinyman / capital_efficiency');
    expect(out).toContain('folks / capital_efficiency');
    expect(out).toContain('LOW CONFIDENCE 0.62');
    expect(out).toContain('ESTIMATED, not measured');
    expect(out).toContain('STALE');
  });

  it('states the RATIO convention once, not on every row', () => {
    const occurrences = out.split('decimal fractions, NOT percentages').length - 1;
    expect(occurrences).toBe(1);
    // Still stated, and still before the numbers it governs.
    expect(out.indexOf('decimal fractions, NOT percentages')).toBeLessThan(out.indexOf('#1 tinyman'));
  });

  it('keeps the ranking rows readable — bare values, no repeated unit essay', () => {
    expect(out).toContain('#1 tinyman: 0.0369');
    expect(out).toContain('#2 folks: 0.0122');
  });

  it('explains a null spread ratio rather than letting a model compute one', () => {
    const zeroed = renderCompareResult({
      ...COMPARISON,
      spread: { max: 0.0369, min: 0, ratio: null },
    });
    expect(zeroed).toMatch(/do not compute one yourself/i);
    expect(zeroed).not.toContain('Infinity');
  });
});
