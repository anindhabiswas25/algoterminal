/**
 * Tests for the real `Payer` — the one that signs.
 *
 * These matter more than the mocked-backend tests because they exercise the
 * actual `@x402/fetch` flow: a genuine 402 is parsed by the library, the
 * requirements are selected, and OUR hook runs with the amount the server
 * really quoted. A cap enforced anywhere else is a cap enforced against a price
 * we made up.
 *
 * The abort path needs no chain and no node, which is the point: aborting
 * happens BEFORE the scheme builds or signs a transaction, so nothing touches
 * algod. If a cap ever stopped aborting before that step, these tests would try
 * to reach a real node and fail loudly.
 */
import algosdk from 'algosdk';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { Payer, PaymentConfigError } from '../src/payer.js';
import { SpendLedger, SpendLimitError } from '../src/spend.js';

const MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

const config = (overrides: Record<string, string> = {}) =>
  loadConfig({
    ALGOTERMINAL_BASE_URL: 'https://algoterminal.test',
    ALGOTERMINAL_MNEMONIC: MNEMONIC,
    // Point algod somewhere unroutable: a test that reaches it has already failed
    // the thing it is testing.
    ALGOTERMINAL_ALGOD_URL: 'http://127.0.0.1:1',
    ...overrides,
  } as NodeJS.ProcessEnv);

/** A 402 exactly as the live service issues one. */
function paymentRequired(amountAtomic: string, asset = '10458941'): Response {
  const declaration = {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: 'https://algoterminal.test/metric/tinyman/tvl',
      description: 'One standardized financial KPI.',
      mimeType: 'application/json',
      serviceName: 'AlgoTerminal',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
        amount: amountAtomic,
        asset,
        payTo: 'BKRGZZ32PRF6XV7PFJAFM47MF37FPWG6YTT5ONM3OJEUE2HUYZHBZA55UQ',
        maxTimeoutSeconds: 60,
        extra: { decimals: 6, feePayer: 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA' },
      },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(declaration), 'utf8').toString('base64');
  return new Response(JSON.stringify({ error: 'payment_required' }), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'payment-required': encoded,
      'x-payment-required': encoded,
    },
  });
}

function countingFetch(make: () => Response): { fetch: typeof globalThis.fetch; count: () => number } {
  let n = 0;
  const fetch = (async () => {
    n += 1;
    return make();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, count: () => n };
}

describe('Payer construction', () => {
  it('derives the payer address from the user-supplied mnemonic', () => {
    const c = config();
    const payer = new Payer(c, new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic), countingFetch(() => new Response('{}')).fetch);
    expect(algosdk.isValidAddress(payer.address)).toBe(true);
    expect(payer.address).toBe(String(algosdk.mnemonicToSecretKey(MNEMONIC).addr));
  });

  it('rejects an invalid mnemonic without ever echoing the key', () => {
    const c = config({ ALGOTERMINAL_MNEMONIC: 'not actually a mnemonic at all' });
    let thrown: unknown;
    try {
      new Payer(c, new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PaymentConfigError);
    expect((thrown as Error).message).not.toContain('not actually a mnemonic');
    expect((thrown as Error).message).toContain('never logged');
  });
});

describe('the cap is enforced against the amount the server actually quoted', () => {
  it('aborts a payment over the per-call cap before signing anything', async () => {
    const c = config({ ALGOTERMINAL_MAX_PER_CALL_USDC: '0.01' });
    const ledger = new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic);
    // 20000 atomic = $0.02, the fresh=true tier — over the $0.01 cap.
    const f = countingFetch(() => paymentRequired('20000'));
    const payer = new Payer(c, ledger, f.fetch);

    await expect(payer.pay('https://algoterminal.test/metric/tinyman/tvl?fresh=true', {}, 'fresh tvl')).rejects.toThrow(
      SpendLimitError,
    );

    expect(ledger.spentAtomic).toBe(0n);
    // One request: the unpaid probe that produced the 402. No paid retry.
    expect(f.count()).toBe(1);
  });

  it('reports the server-quoted price in the refusal, not a catalog price', async () => {
    const c = config({ ALGOTERMINAL_MAX_PER_CALL_USDC: '0.01' });
    const ledger = new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic);
    // The server quotes 0.037 — a price no catalog tier lists. The refusal must
    // name THAT number, because it is the one the user would have been billed.
    const payer = new Payer(c, ledger, countingFetch(() => paymentRequired('37000')).fetch);

    let message = '';
    try {
      await payer.pay('https://algoterminal.test/metric/tinyman/tvl', {}, 'tvl');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('0.037000 USDC');
    expect(ledger.spentAtomic).toBe(0n);
  });

  it('aborts when the session budget cannot cover the quote', async () => {
    const c = config({ ALGOTERMINAL_MAX_SPEND_USDC: '0.006', ALGOTERMINAL_MAX_PER_CALL_USDC: '0.005' });
    const ledger = new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic);
    ledger.record('earlier call', 5000n, 'TX1');
    const payer = new Payer(c, ledger, countingFetch(() => paymentRequired('5000')).fetch);

    let thrown: unknown;
    try {
      await payer.pay('https://algoterminal.test/metric/pact/tvl', {}, 'tvl');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SpendLimitError);
    expect((thrown as SpendLimitError).kind).toBe('session');
    expect(ledger.spentAtomic).toBe(5000n);
  });
});

describe('the payer refuses to sign for the wrong asset', () => {
  it('aborts when the service asks for an asset this server is not configured for', async () => {
    const c = config();
    const ledger = new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic);
    // MainNet USDC quoted at a server the user configured as TestNet.
    const payer = new Payer(c, ledger, countingFetch(() => paymentRequired('5000', '31566704')).fetch);

    let message = '';
    try {
      await payer.pay('https://algoterminal.test/metric/tinyman/tvl', {}, 'tvl');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('31566704');
    expect(message).toContain('10458941');
    expect(message).toContain('ALGOTERMINAL_NETWORK');
    expect(ledger.spentAtomic).toBe(0n);
  });
});

describe('a free response through the paying client', () => {
  it('costs nothing when the server does not ask for payment', async () => {
    const c = config();
    const ledger = new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic);
    const payer = new Payer(c, ledger, countingFetch(() => new Response(JSON.stringify({ ok: true }))).fetch);

    const result = await payer.pay('https://algoterminal.test/health', {}, 'health');
    expect(result.ok).toBe(true);
    expect(result.quotedAtomic).toBeNull();
    expect(result.settlement).toBeNull();
    expect(ledger.spentAtomic).toBe(0n);
  });

  it('does not record a spend for an error response', async () => {
    const c = config();
    const ledger = new SpendLedger(c.maxSessionAtomic, c.maxPerCallAtomic);
    const payer = new Payer(
      c,
      ledger,
      countingFetch(() => new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_DATA', message: 'x' } }), { status: 502 })).fetch,
    );

    const result = await payer.pay('https://algoterminal.test/compare', {}, 'compare');
    expect(result.ok).toBe(false);
    expect(result.settlement).toBeNull();
    expect(ledger.spentAtomic).toBe(0n);
  });
});
