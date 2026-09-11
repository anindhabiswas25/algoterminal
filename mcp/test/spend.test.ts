import { describe, expect, it } from 'vitest';

import { atomicToUsdc, usdcToAtomic, ConfigError } from '../src/config.js';
import { SpendLedger, SpendLimitError } from '../src/spend.js';

const usdc = (s: string): bigint => usdcToAtomic(s, 'test');

describe('USDC arithmetic', () => {
  it('round-trips without floating-point drift', () => {
    // The reason this is bigint and not number: twenty $0.005 calls, which is
    // an entirely ordinary session, and which floats get wrong.
    let total = 0n;
    for (let i = 0; i < 20; i += 1) total += usdc('0.005');
    expect(atomicToUsdc(total)).toBe('0.100000');

    let asFloat = 0;
    for (let i = 0; i < 20; i += 1) asFloat += 0.005;
    expect(asFloat).not.toBe(0.1);
    expect(asFloat).toBeGreaterThan(0.1);
  });

  it('rejects anything that is not a plain decimal amount', () => {
    for (const bad of ['1e-3', '0.0000001', 'free', '-1', '1,00', '']) {
      expect(() => usdc(bad)).toThrow(ConfigError);
    }
  });

  it('accepts a leading dollar sign and full 6dp precision', () => {
    expect(usdc('$0.05')).toBe(50_000n);
    expect(usdc('0.000001')).toBe(1n);
    expect(atomicToUsdc(1n)).toBe('0.000001');
  });
});

describe('SpendLedger — per-call cap', () => {
  it('refuses a call priced above the per-call cap', () => {
    const ledger = new SpendLedger(usdc('1.00'), usdc('0.05'));
    expect(() => ledger.assertAllowed(usdc('0.08'), 'GET /compare?fresh=true')).toThrow(SpendLimitError);
  });

  it('allows a call priced exactly at the cap', () => {
    const ledger = new SpendLedger(usdc('1.00'), usdc('0.05'));
    expect(() => ledger.assertAllowed(usdc('0.05'), 'GET /compare')).not.toThrow();
  });

  it('names the env var to change and tells the caller not to retry', () => {
    const ledger = new SpendLedger(usdc('1.00'), usdc('0.05'));
    let message = '';
    try {
      ledger.assertAllowed(usdc('0.15'), 'POST /ask');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('REFUSED');
    expect(message).toContain('0.150000');
    expect(message).toContain('ALGOTERMINAL_MAX_PER_CALL_USDC');
    expect(message).toContain('Nothing was spent');
    expect(message).toMatch(/do not retry/i);
  });

  it('spends nothing when it refuses', () => {
    const ledger = new SpendLedger(usdc('1.00'), usdc('0.05'));
    expect(() => ledger.assertAllowed(usdc('0.08'), 'x')).toThrow();
    expect(ledger.spentAtomic).toBe(0n);
    expect(ledger.summary().callCount).toBe(0);
  });
});

describe('SpendLedger — session cap', () => {
  it('refuses the call that would cross the session cap, rather than truncating it', () => {
    const ledger = new SpendLedger(usdc('0.02'), usdc('0.05'));
    ledger.assertAllowed(usdc('0.005'), 'a');
    ledger.record('a', usdc('0.005'), 'TX1');
    ledger.record('b', usdc('0.005'), 'TX2');
    ledger.record('c', usdc('0.005'), 'TX3');
    // 0.015 spent, 0.005 left. A 0.005 call fits; a second one does not.
    expect(() => ledger.assertAllowed(usdc('0.005'), 'd')).not.toThrow();
    ledger.record('d', usdc('0.005'), 'TX4');
    expect(() => ledger.assertAllowed(usdc('0.005'), 'e')).toThrow(SpendLimitError);
    // Crucially: no partial spend happened on the refusal.
    expect(atomicToUsdc(ledger.spentAtomic)).toBe('0.020000');
  });

  it('reports how much is left and what was already spent', () => {
    const ledger = new SpendLedger(usdc('0.10'), usdc('0.05'));
    ledger.record('a', usdc('0.05'), 'TX1');
    ledger.record('b', usdc('0.04'), 'TX2');
    let message = '';
    try {
      ledger.assertAllowed(usdc('0.05'), 'GET /compare');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('0.010000 USDC remains');
    expect(message).toContain('0.090000 USDC already spent');
    expect(message).toContain('2 paid call(s)');
    expect(message).toContain('ALGOTERMINAL_MAX_SPEND_USDC');
  });

  it('never reports negative remaining budget', () => {
    const ledger = new SpendLedger(usdc('0.01'), usdc('0.05'));
    ledger.record('overshoot', usdc('0.05'), 'TX1');
    expect(ledger.remainingAtomic).toBe(0n);
    expect(ledger.summary().remainingUsdc).toBe('0.000000');
  });
});

describe('SpendLedger — receipts', () => {
  it('records the settlement with its txid and exposes it in the summary', () => {
    const ledger = new SpendLedger(usdc('1.00'), usdc('0.05'), () => new Date('2026-09-09T12:00:00Z'));
    ledger.record('GET /metric/tinyman/tvl', usdc('0.005'), 'ABC123');
    const s = ledger.summary();
    expect(s.spentUsdc).toBe('0.005000');
    expect(s.callCount).toBe(1);
    expect(s.settlements[0]).toEqual({
      label: 'GET /metric/tinyman/tvl',
      atomic: 5000n,
      txid: 'ABC123',
      at: '2026-09-09T12:00:00.000Z',
    });
  });

  it('renders a spend line carrying spent, cap and remaining', () => {
    const ledger = new SpendLedger(usdc('1.00'), usdc('0.05'));
    ledger.record('x', usdc('0.055'), 'TX');
    expect(ledger.render()).toBe(
      'SESSION SPEND: 0.055000 USDC of 1.000000 cap (0.945000 remaining, 1 paid call(s) this session).',
    );
  });
});
