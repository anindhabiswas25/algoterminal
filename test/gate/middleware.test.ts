import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';

import { ApiError, envelope } from '../../src/errors.js';
import { QUOTED_TIMEOUT_SECONDS } from '../../src/gate/deadline.js';
import { paymentGate, RETRY_AFTER_SECONDS } from '../../src/gate/middleware.js';
import { priceAtomic } from '../../src/pricing.js';
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA } from '../../src/config/x402.js';
import {
  buildPayment,
  decodePaymentRequired,
  decodePaymentResponse,
  fakeFacilitator,
  fakeLedger,
  gateDeps,
  FEE_PAYER,
  type FakeFacilitator,
  type FakeLedger,
} from './helpers.js';

/**
 * The gate's contract, as tests.
 *
 * The handler here is a stub whose status is set by the request, because what
 * is under test is the ORDER — verify before it, settle only after a 2xx — and
 * a stub is the only handler whose outcome a test can dictate exactly. The real
 * `/metric` handler's own behaviour is covered in `test/routes/metric.test.ts`.
 */

const METRIC = '/metric/tinyman/tvl';
const BASE_PRICE = priceAtomic('/metric/{protocol}/{kpi}', 'base');

let facilitator: FakeFacilitator;
let ledger: FakeLedger;
let handlerCalls: number;

function app(): Hono {
  const a = new Hono();
  a.use('*', paymentGate(gateDeps(facilitator, ledger)));

  a.get('/metric/:protocol/:kpi', (c) => {
    handlerCalls += 1;
    const fail = c.req.query('fail');
    if (fail === 'throw') throw new Error('handler exploded');
    if (fail !== undefined) {
      throw new ApiError(Number(fail) as 404, 'KPI_NOT_APPLICABLE', 'nope', {});
    }
    return c.json({ metric: 'tvl', protocol: 'tinyman', value: 1 });
  });

  a.get('/catalog', (c) => c.json({ free: true }));
  a.get('/health', (c) => c.json({ status: 'ok' }));

  a.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(envelope(err.code, err.message, err.detail), err.status);
    }
    return c.json(envelope('INTERNAL_ERROR', 'boom', {}), 500);
  });
  return a;
}

/** A 402, and the requirements it quoted — the first half of every paid call. */
async function quote(path = METRIC) {
  const res = await app().request(path);
  expect(res.status).toBe(402);
  const required = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
  return { res, requirements: required.accepts[0]! };
}

beforeEach(() => {
  facilitator = fakeFacilitator();
  ledger = fakeLedger();
  handlerCalls = 0;
});

describe('free routes', () => {
  it('never gates a free route', async () => {
    const a = app();
    for (const path of ['/catalog', '/health']) {
      const res = await a.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    }
    // No facilitator contact at all: a free route must not depend on it.
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it('serves free routes even when the facilitator is unreachable', async () => {
    facilitator.getSupported = async () => {
      throw new Error('ECONNREFUSED');
    };
    const res = await app().request('/health');
    expect(res.status).toBe(200);
  });
});

describe('402 — no payment (API_SPEC.md §2.1)', () => {
  it('emits a spec-valid PAYMENT-REQUIRED header', async () => {
    const res = await app().request(METRIC);
    expect(res.status).toBe(402);

    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).not.toBeNull();
    // §2.1: the v1 alias carries the same bytes.
    expect(res.headers.get('X-PAYMENT-REQUIRED')).toBe(header);

    const decoded = decodePaymentRequired(header);
    expect(decoded.x402Version).toBe(2);

    const accept = decoded.accepts[0]!;
    expect(accept.scheme).toBe('exact');
    expect(accept.network).toBe(ALGORAND_TESTNET_CAIP2);
    expect(accept.asset).toBe(String(USDC_TESTNET_ASA));
    expect(accept.amount).toBe(String(BASE_PRICE));
    expect(accept.amount).toBe('5000');
    expect(accept.payTo).toBe(process.env.X402_PAYTO);
    // 30, not 60 (§4g item 1). The quoted timeout is now the same constant the
    // gate enforces as the handler's hard ceiling, and it is below the ~31s
    // validity window an x402 AVM client actually builds — so a request that
    // finishes inside the number we advertise finishes inside the window that
    // decides whether we get paid.
    expect(accept.maxTimeoutSeconds).toBe(QUOTED_TIMEOUT_SECONDS);
    expect(QUOTED_TIMEOUT_SECONDS).toBe(30);
    expect(accept.extra?.decimals).toBe(6);
    // Populated from the facilitator's own /supported, never typed by us.
    expect(accept.extra?.feePayer).toBe(FEE_PAYER);
  });

  it('emits a plain-JSON body restating price, resource and description', async () => {
    const res = await app().request(METRIC);
    const body = await res.json();

    expect(body.error).toBe('payment_required');
    expect(body.resource).toBe(`${process.env.PUBLIC_BASE_URL}${METRIC}`);
    expect(body.description).toContain('KPI');
    expect(body.price.amount_atomic).toBe('5000');
    expect(body.price.amount_usdc).toBe('0.005');
    expect(body.price.asset).toBe(String(USDC_TESTNET_ASA));
    expect(body.price.network).toBe(ALGORAND_TESTNET_CAIP2);
    expect(body.price.payTo).toBe(process.env.X402_PAYTO);
    expect(body.price.fee_sponsored).toBe(true);
    expect(body.settlement_policy).toContain('after a 2xx response');
  });

  it('advertises the canonical public URL, not the one the socket saw', async () => {
    // Behind a TLS-terminating proxy the request arrives over plain HTTP. The
    // 402's resource URL is what the Bazaar indexes and what an agent retries
    // against, so it must be the public origin in both the header and the body.
    const res = await app().request(METRIC);
    const decoded = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
    expect(decoded.resource?.url).toBe(`${process.env.PUBLIC_BASE_URL}${METRIC}`);
    expect((await res.json()).resource).toBe(decoded.resource?.url);
  });

  it('carries the Bazaar discovery block with the challenge tag', async () => {
    const res = await app().request(METRIC);
    const body = await res.json();
    expect(body.discovery.tags).toContain('x402-global-challenge');
    expect(body.discovery.input_example).toEqual({ method: 'GET', path: '/metric/tinyman/tvl' });
    expect(body.discovery.output_example.metric).toBe('tvl');

    // The same declaration in the protocol's own shape, which is what the
    // Bazaar indexer actually reads (DEPLOYMENT.md §6.1).
    const decoded = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
    expect(decoded.resource?.tags).toContain('x402-global-challenge');
    expect(decoded.extensions?.bazaar).toBeDefined();
  });

  it('does not run the handler', async () => {
    await app().request(METRIC);
    expect(handlerCalls).toBe(0);
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it('quotes the dynamic price before the 402, per variant', async () => {
    const fresh = await app().request(`${METRIC}?fresh=true`);
    expect(decodePaymentRequired(fresh.headers.get('PAYMENT-REQUIRED')).accepts[0]!.amount).toBe(
      String(priceAtomic('/metric/{protocol}/{kpi}', 'fresh')),
    );

    const users = await app().request('/metric/tinyman/active_users_24h');
    expect(decodePaymentRequired(users.headers.get('PAYMENT-REQUIRED')).accepts[0]!.amount).toBe(
      String(priceAtomic('/metric/{protocol}/{kpi}', 'active_users')),
    );

    // Both costs at once takes the higher price, never the lower.
    const both = await app().request('/metric/tinyman/active_users_24h?fresh=true');
    expect(decodePaymentRequired(both.headers.get('PAYMENT-REQUIRED')).accepts[0]!.amount).toBe(
      String(priceAtomic('/metric/{protocol}/{kpi}', 'active_users')),
    );
  });
});

describe('402 — payment rejected (API_SPEC.md §2.4)', () => {
  it('returns payment_invalid with the facilitator reason', async () => {
    const { requirements } = await quote();
    facilitator.verifyResult = {
      isValid: false,
      invalidReason: 'invalid_exact_avm_invalid_signature',
    };

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('payment_invalid');
    expect(body.detail.facilitator_reason).toBe('invalid_exact_avm_invalid_signature');
    expect(handlerCalls).toBe(0);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it('returns payment_insufficient with required and provided', async () => {
    const { requirements } = await quote();
    facilitator.verifyResult = {
      isValid: false,
      invalidReason: 'invalid_exact_avm_amount_mismatch',
    };

    const payment = buildPayment(requirements, { amount: 1 });
    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('payment_insufficient');
    expect(body.required).toBe(String(BASE_PRICE));
    expect(body.required_usdc).toBe('0.005');
    // Read from the caller's own signed transfer, not from the facilitator.
    expect(body.provided).toBe('1');
  });

  it('returns payment_expired when the reason names an expiry', async () => {
    const { requirements } = await quote();
    facilitator.verifyResult = { isValid: false, invalidReason: 'payment_expired' };

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });
    expect((await res.json()).error).toBe('payment_expired');
  });

  it('re-issues PAYMENT-REQUIRED on a rejection so the caller can retry', async () => {
    const { requirements } = await quote();
    facilitator.verifyResult = { isValid: false, invalidReason: 'nope' };
    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });
    expect(res.headers.get('PAYMENT-REQUIRED')).not.toBeNull();
    expect(res.headers.get('X-PAYMENT-REQUIRED')).toBe(res.headers.get('PAYMENT-REQUIRED'));
  });
});

describe('409 payment_replayed (API_SPEC.md §2.4)', () => {
  it('rejects a txid already in the ledger, before verify', async () => {
    const { requirements } = await quote();
    const payment = buildPayment(requirements);
    ledger.replayed.add(payment.paymentTxid);

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('PAYMENT_REPLAYED');
    expect(body.error.detail.error).toBe('payment_replayed');
    expect(body.error.detail.payment_txid).toBe(payment.paymentTxid);

    // The whole point of doing this first: no facilitator call, no work.
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(handlerCalls).toBe(0);
  });
});

describe('503 fail-closed (ARCHITECTURE.md §5.2)', () => {
  it('returns 503 with Retry-After and NO data when /verify is unreachable', async () => {
    const { requirements } = await quote();
    facilitator.verify = async () => {
      throw new Error('ECONNREFUSED facilitator.goplausible.xyz');
    };

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(String(RETRY_AFTER_SECONDS));

    const body = await res.json();
    expect(body.error.code).toBe('FACILITATOR_UNAVAILABLE');
    expect(body.error.detail.error).toBe('facilitator_unavailable');

    // The bug that would invalidate the entry: serving data anyway.
    expect(handlerCalls).toBe(0);
    expect(JSON.stringify(body)).not.toContain('"value"');
  });

  it('fails closed when /supported cannot be fetched at all', async () => {
    facilitator.getSupported = async () => {
      throw new Error('DNS failure');
    };
    const res = await app().request(METRIC);
    expect(res.status).toBe(503);
    expect(handlerCalls).toBe(0);
  });

  it('recovers on a later request once the facilitator returns', async () => {
    let up = false;
    const real = facilitator.getSupported.bind(facilitator);
    facilitator.getSupported = async () => {
      if (!up) throw new Error('down');
      return real();
    };

    const a = app();
    expect((await a.request(METRIC)).status).toBe(503);
    up = true;
    // Initialization is retried rather than cached as permanently failed.
    expect((await a.request(METRIC)).status).toBe(402);
  });
});

describe('settle-after-success (ARCHITECTURE.md §3)', () => {
  it('settles exactly once on a 200 and writes one ledger row', async () => {
    const { requirements } = await quote();
    const payment = buildPayment(requirements);

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    expect(res.status).toBe(200);
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(handlerCalls).toBe(1);

    const receipt = decodePaymentResponse(res.headers.get('PAYMENT-RESPONSE'));
    expect(receipt.success).toBe(true);
    // Both names for the same field: the protocol's `transaction` and the
    // `txid` API_SPEC.md §2.3 documents.
    expect(receipt.txid).toBe(receipt.transaction);
    expect(receipt.txid).toBe('TESTTXID0000000000000000000000000000000000000000000000');

    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      paymentTxid: payment.paymentTxid,
      txid: 'TESTTXID0000000000000000000000000000000000000000000000',
      status: 'settled',
      amountAtomic: BASE_PRICE,
      assetId: USDC_TESTNET_ASA,
      route: '/metric/{protocol}/{kpi}',
      network: ALGORAND_TESTNET_CAIP2,
    });
    // A settled row keeps no payload — the txid is the receipt.
    expect(ledger.rows[0]!.payload).toBeUndefined();
  });

  it.each([
    ['404 KPI_NOT_APPLICABLE', '404'],
    ['422 UNROUTABLE_QUESTION', '422'],
    ['502 UPSTREAM_UNAVAILABLE', '502'],
  ])('does not settle a %s', async (_label, status) => {
    const { requirements } = await quote();
    const res = await app().request(`${METRIC}?fail=${status}`, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });

    expect(res.status).toBe(Number(status));
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });

  it('does not settle when the handler throws', async () => {
    const { requirements } = await quote();
    const res = await app().request(`${METRIC}?fail=throw`, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });

    expect(res.status).toBe(500);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it('verifies before the handler runs', async () => {
    const { requirements } = await quote();
    const order: string[] = [];
    const real = facilitator.verify.bind(facilitator);
    facilitator.verify = async (p, r) => {
      order.push('verify');
      return real(p, r);
    };
    const realSettle = facilitator.settle.bind(facilitator);
    facilitator.settle = async (p, r) => {
      order.push('settle');
      return realSettle(p, r);
    };

    const a = new Hono();
    a.use('*', paymentGate(gateDeps(facilitator, ledger)));
    a.get('/metric/:protocol/:kpi', (c) => {
      order.push('handler');
      return c.json({ ok: true });
    });

    await a.request(METRIC, { headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header } });
    expect(order).toEqual(['verify', 'handler', 'settle']);
  });
});

describe('settle failure after a delivered response (ARCHITECTURE.md §5.2)', () => {
  it('keeps the 200, records settle_failed with the payload, and flags the response', async () => {
    const { requirements } = await quote();
    const payment = buildPayment(requirements);
    facilitator.settleResult = {
      success: false,
      transaction: '',
      network: ALGORAND_TESTNET_CAIP2,
      errorReason: 'invalid_exact_avm_settlement_failed',
    };

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': payment.header },
    });

    // We do not retract a delivered response.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ metric: 'tvl' });
    expect(res.headers.get('X-AlgoTerminal-Settlement')).toBe('failed');

    const receipt = decodePaymentResponse(res.headers.get('PAYMENT-RESPONSE'));
    expect(receipt.success).toBe(false);
    expect(receipt.txid).toBeNull();

    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      status: 'settle_failed',
      txid: null,
      errorReason: 'invalid_exact_avm_settlement_failed',
    });
    // §5.2 — the payload, so the failure can be reconciled by hand.
    expect(ledger.rows[0]!.payload).toBeDefined();
  });

  it('treats a facilitator throw at settle the same way', async () => {
    const { requirements } = await quote();
    facilitator.settle = async () => {
      throw new Error('facilitator timed out');
    };

    const res = await app().request(METRIC, {
      headers: { 'PAYMENT-SIGNATURE': buildPayment(requirements).header },
    });

    expect(res.status).toBe(200);
    expect(ledger.rows[0]).toMatchObject({ status: 'settle_failed' });
  });
});

describe('v1 header compatibility (API_SPEC.md §2.2)', () => {
  it('accepts the payment in X-PAYMENT', async () => {
    const { requirements } = await quote();
    const res = await app().request(METRIC, {
      headers: { 'X-PAYMENT': buildPayment(requirements).header },
    });
    expect(res.status).toBe(200);
    expect(facilitator.settleCalls).toHaveLength(1);
  });
});

describe('malformed payment headers', () => {
  it('falls back to a 402 rather than a 500', async () => {
    for (const header of ['not-base64!!', Buffer.from('{}').toString('base64'), '']) {
      const res = await app().request(METRIC, { headers: { 'PAYMENT-SIGNATURE': header } });
      expect(res.status).toBe(402);
      expect(handlerCalls).toBe(0);
    }
  });
});
