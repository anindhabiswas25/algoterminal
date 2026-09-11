import { describe, expect, it } from 'vitest';

import { mapError, renderError } from '../src/errors.js';
import { PACT_TAKE_RATE_DECLINE } from './fixtures.js';

const envelope = (code: string, message: string, detail: Record<string, unknown> = {}) => ({
  error: { code, message, detail },
});

describe('error mapping', () => {
  it('never reports a charge, because the service settles only after a 2xx', () => {
    for (const [status, code] of [
      [400, 'INVALID_PARAM'],
      [404, 'KPI_NOT_APPLICABLE'],
      [409, 'PAYMENT_REPLAYED'],
      [422, 'OUT_OF_SCOPE'],
      [502, 'INSUFFICIENT_DATA'],
      [503, 'ROUTE_UNAVAILABLE'],
      [504, 'GATEWAY_TIMEOUT'],
    ] as const) {
      expect(mapError(status, envelope(code, 'x')).charged, `${status} ${code}`).toBe(false);
    }
  });

  it('marks transient failures retryable and permanent ones not', () => {
    expect(mapError(502, envelope('INSUFFICIENT_DATA', 'x')).retryable).toBe(true);
    expect(mapError(502, envelope('UPSTREAM_UNAVAILABLE', 'x')).retryable).toBe(true);
    expect(mapError(409, envelope('PAYMENT_WINDOW_EXPIRED', 'x')).retryable).toBe(true);
    expect(mapError(504, null).retryable).toBe(true);

    expect(mapError(404, envelope('KPI_NOT_APPLICABLE', 'x')).retryable).toBe(false);
    expect(mapError(422, envelope('OUT_OF_SCOPE', 'x')).retryable).toBe(false);
    expect(mapError(422, envelope('UNROUTABLE_QUESTION', 'x')).retryable).toBe(false);
    expect(mapError(503, null).retryable).toBe(false);
  });

  it('falls back to the status when the code is unknown, and still says it was free', () => {
    const m = mapError(500, envelope('SOMETHING_NEW', 'boom'));
    expect(m.code).toBe('SOMETHING_NEW');
    expect(m.charged).toBe(false);
    expect(m.retryable).toBe(true);
  });

  it('survives a body that is not an error envelope at all', () => {
    const m = mapError(502, '<html>bad gateway</html>');
    expect(m.code).toBe('HTTP_502');
    expect(m.message).toContain('bad gateway');
    expect(m.charged).toBe(false);
  });
});

describe('rendered errors', () => {
  it('states plainly that nothing was charged', () => {
    const text = renderError(mapError(504, null));
    expect(text).toContain('YOU WERE NOT CHARGED');
    expect(text).toContain('0.000000 USDC');
    expect(text).toMatch(/retry/i);
  });

  it('surfaces a KPI_NOT_APPLICABLE reason verbatim and forbids substituting zero', () => {
    const text = renderError(
      mapError(
        404,
        envelope('KPI_NOT_APPLICABLE', 'Pact does not publish take_rate.', {
          reason: PACT_TAKE_RATE_DECLINE,
          available_kpis: ['tvl', 'volume_24h', 'gross_fees_24h'],
        }),
      ),
    );
    // The whole paragraph, not a truncation of it.
    expect(text).toContain(PACT_TAKE_RATE_DECLINE);
    expect(text).toContain('pact_fee_bps');
    expect(text).toContain('3,961 pools');
    expect(text).toMatch(/never substitute zero|Do NOT substitute zero/i);
    expect(text).toContain('tvl, volume_24h, gross_fees_24h');
  });

  it('surfaces per-protocol reasons from a compare-level rejection', () => {
    const text = renderError(
      mapError(
        422,
        envelope('KPI_NOT_APPLICABLE_TO_ANY', 'No leg publishes this.', {
          reasons: { pact: PACT_TAKE_RATE_DECLINE },
        }),
      ),
    );
    expect(text).toContain('PER-PROTOCOL REASONS');
    expect(text).toContain('pact: ');
    expect(text).toContain('pact_fee_bps');
  });

  it('explains a 402 as a wallet problem, naming the opt-in trap', () => {
    const text = renderError(mapError(402, null));
    expect(text).toMatch(/opted in/);
    expect(text).toContain('algoterminal_spend');
  });

  it('tells the caller to check routes[].available on a 503', () => {
    const text = renderError(mapError(503, envelope('ROUTE_UNAVAILABLE', '/ask is disabled')));
    expect(text).toContain('routes[].available');
    expect(text).toContain('algoterminal_catalog');
  });
});
