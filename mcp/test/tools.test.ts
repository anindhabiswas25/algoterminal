import { describe, expect, it } from 'vitest';

import { catalogTool } from '../src/tools/catalog.js';
import { methodologyTool } from '../src/tools/methodology.js';
import { metricTool } from '../src/tools/metric.js';
import { compareTool } from '../src/tools/compare.js';
import { askTool } from '../src/tools/ask.js';
import { spendTool } from '../src/tools/spend.js';
import { bodyText, harness } from './harness.js';
import {
  CATALOG,
  CATALOG_WITH_ASK,
  COMPARISON,
  CROSS_CLASS_CAVEAT,
  BASIS_CAVEAT,
  PACT_TAKE_RATE_DECLINE,
  TINYMAN_TVL,
  TVL_NOTE,
} from './fixtures.js';

const ok = (body: unknown) => () => ({ status: 200, body });
const err = (status: number, body: unknown) => () => ({ status, body });
const envelope = (code: string, message: string, detail: Record<string, unknown> = {}) => ({
  error: { code, message, detail },
});

const METHODOLOGY_DOC = {
  service: 'AlgoTerminal',
  methodology_version: '1.2.0',
  units: ['USD', 'RATIO', 'COUNT', 'ASSET_UNITS'],
  document_url: 'https://algoterminal.test/methodology?format=markdown',
  kpis: [
    {
      id: 'capital_efficiency',
      unit: 'RATIO',
      classes: ['dex', 'lending'],
      definition: '(gross_fees_24h * 365) / tvl — annualized fees generated per dollar of capital.',
      ttl_seconds: 600,
      cross_class_basis:
        '§3.1 defines gross_fees identically for both — swap fees paid by traders and interest paid by ' +
        'borrowers are both what users pay to use the protocol',
    },
  ],
  confidence: {
    ladder: [
      { tier: 'safe_to_act', min: 0.9, meaning: 'Safe to act on.' },
      { tier: 'directional', min: 0.7, meaning: 'Directionally sound; check notes[].' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Free tools must never trigger a payment. Proving a negative, so it is proved
// two ways: the payment backend records every call it is asked to make, and the
// fetch stub records every request that goes out.
// ---------------------------------------------------------------------------

describe('free tools never pay', () => {
  it('algoterminal_catalog makes no payment and asks the payer for nothing', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n } });
    await catalogTool(h.ctx);
    expect(h.payer?.calls).toEqual([]);
    expect(h.ledger.spentAtomic).toBe(0n);
    expect(h.fetchStub.calls.every((c) => c.url.includes('/catalog'))).toBe(true);
  });

  it('algoterminal_methodology makes no payment', async () => {
    const h = harness({
      routes: { '/methodology': { body: METHODOLOGY_DOC } },
      paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n },
    });
    await methodologyTool(h.ctx, {});
    expect(h.payer?.calls).toEqual([]);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('algoterminal_spend makes no payment', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n } });
    await spendTool(h.ctx, null);
    expect(h.payer?.calls).toEqual([]);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('no free tool ever sends a payment header', async () => {
    const h = harness({
      routes: { '/methodology': { body: METHODOLOGY_DOC } },
      paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n },
    });
    await catalogTool(h.ctx);
    await methodologyTool(h.ctx, { kpi: 'capital_efficiency' });
    for (const call of h.fetchStub.calls) {
      const headers = new Headers((call.init?.headers ?? {}) as Record<string, string>);
      expect(headers.get('PAYMENT-SIGNATURE')).toBeNull();
      expect(headers.get('X-PAYMENT')).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Spend caps
// ---------------------------------------------------------------------------

describe('spend caps refuse rather than truncate', () => {
  it('refuses a call over the per-call cap BEFORE any paid request is attempted', async () => {
    const h = harness({
      env: { ALGOTERMINAL_MAX_PER_CALL_USDC: '0.01' },
      paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 20_000n },
    });
    const result = await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl', fresh: true });
    const text = bodyText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain('REFUSED');
    expect(text).toContain('0.020000 USDC');
    expect(text).toContain('per-call cap of 0.010000');
    expect(text).toContain('ALGOTERMINAL_MAX_PER_CALL_USDC');
    // The whole point: no request was paid for, and nothing was spent.
    expect(h.payer?.calls).toEqual([]);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('refuses the call that would exceed the session cap, having spent nothing extra', async () => {
    const h = harness({
      env: { ALGOTERMINAL_MAX_SPEND_USDC: '0.012', ALGOTERMINAL_MAX_PER_CALL_USDC: '0.01' },
      paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n },
    });

    await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl' });
    await metricTool(h.ctx, { protocol: 'pact', kpi: 'tvl' });
    expect(h.ledger.summary().spentUsdc).toBe('0.010000');

    const third = await metricTool(h.ctx, { protocol: 'folks', kpi: 'tvl' });
    const text = bodyText(third);
    expect(third.isError).toBe(true);
    expect(text).toContain('REFUSED');
    expect(text).toContain('0.002000 USDC remains');
    expect(text).toContain('ALGOTERMINAL_MAX_SPEND_USDC');
    // Two paid calls happened; the third did not.
    expect(h.payer?.calls).toHaveLength(2);
    expect(h.ledger.summary().spentUsdc).toBe('0.010000');
  });

  it('refuses an over-budget compare without spending, and says how much it would have cost', async () => {
    const h = harness({
      env: { ALGOTERMINAL_MAX_PER_CALL_USDC: '0.02' },
      paid: { respond: ok(COMPARISON), quoteAtomic: 50_000n },
    });
    const result = await compareTool(h.ctx, { protocols: ['tinyman', 'folks'], metric: 'capital_efficiency' });
    expect(result.isError).toBe(true);
    expect(bodyText(result)).toContain('0.050000 USDC');
    expect(h.payer?.calls).toEqual([]);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('the default per-call cap of $0.05 admits a compare but refuses a deep ask', async () => {
    const h = harness({ paid: { respond: ok(COMPARISON), quoteAtomic: 50_000n } });
    const cmp = await compareTool(h.ctx, { protocols: ['tinyman', 'folks'], metric: 'capital_efficiency' });
    expect(cmp.isError).toBeUndefined();

    const askHarness = harness({
      routes: { '/catalog': { body: CATALOG_WITH_ASK } },
      paid: { respond: ok({}), quoteAtomic: 200_000n },
    });
    const ask = await askTool(askHarness.ctx, { question: 'Which protocol earns most per dollar?', depth: 'deep' });
    expect(ask.isError).toBe(true);
    expect(bodyText(ask)).toContain('REFUSED');
    expect(askHarness.payer?.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The paid success path
// ---------------------------------------------------------------------------

describe('a settled paid call', () => {
  it('passes the KpiFact through with confidence and notes intact', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n } });
    const text = bodyText(await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl' }));

    expect(text).toContain('tinyman / tvl');
    expect(text).toContain('5344337');
    expect(text).toContain('CONFIDENCE 0.7');
    expect(text).toContain('DIRECTIONALLY SOUND ONLY');
    expect(text).toContain(TVL_NOTE);
    expect(text).toContain('all_pools_usd_priced');
    expect(text).toContain('methodology_version 1.2.0');
    // And the exact response, so nothing above has to be trusted.
    expect(text).toContain('"value": 5344337');
    expect(text).toContain('"confidence": 0.7');
  });

  it('reports the price, the settlement txid and an explorer link', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n, txid: 'TXABC' } });
    const text = bodyText(await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl' }));
    expect(text).toContain('PAID: 0.005000 USDC');
    expect(text).toContain('Settlement txid: TXABC');
    expect(text).toContain('https://testnet.explorer.perawallet.app/tx/TXABC');
  });

  it('increments the cumulative spend counter and reports it in every result', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n } });

    const first = bodyText(await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl' }));
    expect(first).toContain('SESSION SPEND: 0.005000 USDC of 1.000000 cap (0.995000 remaining, 1 paid call(s)');

    const second = bodyText(await metricTool(h.ctx, { protocol: 'pact', kpi: 'tvl' }));
    expect(second).toContain('SESSION SPEND: 0.010000 USDC of 1.000000 cap (0.990000 remaining, 2 paid call(s)');

    const spend = bodyText(await spendTool(h.ctx, null));
    expect(spend).toContain('spent:        0.010000 USDC across 2 settled payment(s)');
  });

  it('passes compare caveats through verbatim, including the cross-class one', async () => {
    const h = harness({ paid: { respond: ok(COMPARISON), quoteAtomic: 50_000n } });
    const text = bodyText(await compareTool(h.ctx, { protocols: ['tinyman', 'folks'], metric: 'capital_efficiency' }));

    expect(text).toContain(CROSS_CLASS_CAVEAT);
    expect(text).toContain(BASIS_CAVEAT);
    expect(text).toContain('COMPARABILITY: 0.62');
    expect(text).toContain('MINIMUM across the legs');
    expect(text).toContain('LOW CONFIDENCE 0.62');
  });
});

// ---------------------------------------------------------------------------
// Declines and errors
// ---------------------------------------------------------------------------

describe('a declined KPI', () => {
  it('is answered from the free catalog, spending nothing, with the reason in full', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n } });
    const result = await metricTool(h.ctx, { protocol: 'pact', kpi: 'take_rate' });
    const text = bodyText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain(PACT_TAKE_RATE_DECLINE);
    expect(text).toMatch(/Do NOT substitute zero/);
    expect(text).toContain('Nothing was spent');
    expect(h.payer?.calls).toEqual([]);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('refuses a comparison in which fewer than two legs could resolve, for free', async () => {
    const h = harness({ paid: { respond: ok(COMPARISON), quoteAtomic: 50_000n } });
    const result = await compareTool(h.ctx, { protocols: ['pact', 'tinyman'], metric: 'fee_apr' });
    // pact declines fee_apr and folks is not in the list, so only tinyman resolves.
    expect(result.isError).toBe(true);
    expect(bodyText(result)).toContain('fee_apr is supply_side_revenue_24h * 365 / tvl');
    expect(h.payer?.calls).toEqual([]);
  });

  it('still runs a comparison where a declining leg leaves two resolvable ones, and flags it', async () => {
    const h = harness({ paid: { respond: ok(COMPARISON), quoteAtomic: 50_000n } });
    const text = bodyText(
      await compareTool(h.ctx, { protocols: ['pact', 'tinyman', 'folks'], metric: 'take_rate' }),
    );
    expect(text).toContain('pact declines to publish "take_rate"');
    expect(text).toContain('That is not missing data');
    expect(h.payer?.calls).toHaveLength(1);
  });
});

describe('error responses from the service', () => {
  it('maps a 404 KPI_NOT_APPLICABLE and says nothing was charged', async () => {
    const h = harness({
      paid: {
        respond: err(
          404,
          envelope('KPI_NOT_APPLICABLE', 'Not applicable.', {
            reason: PACT_TAKE_RATE_DECLINE,
            available_kpis: ['tvl'],
          }),
        ),
        quoteAtomic: 5000n,
      },
    });
    const text = bodyText(await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl' }));
    expect(text).toContain('ERROR 404 KPI_NOT_APPLICABLE');
    expect(text).toContain('YOU WERE NOT CHARGED');
    expect(text).toContain(PACT_TAKE_RATE_DECLINE);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('maps a 502 INSUFFICIENT_DATA as free and retryable', async () => {
    const h = harness({
      paid: { respond: err(502, envelope('INSUFFICIENT_DATA', 'Only one leg resolved.')), quoteAtomic: 50_000n },
    });
    const text = bodyText(await compareTool(h.ctx, { protocols: ['tinyman', 'folks'], metric: 'tvl' }));
    expect(text).toContain('ERROR 502 INSUFFICIENT_DATA');
    expect(text).toContain('YOU WERE NOT CHARGED');
    expect(text).toMatch(/Retrying shortly may succeed/);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('maps a 504 to free-and-retry with the fresh=true hint', async () => {
    const h = harness({ paid: { respond: err(504, 'upstream timeout'), quoteAtomic: 20_000n } });
    const text = bodyText(await metricTool(h.ctx, { protocol: 'tinyman', kpi: 'tvl', fresh: true }));
    expect(text).toContain('ERROR 504');
    expect(text).toContain('YOU WERE NOT CHARGED');
    expect(text).toMatch(/drop `fresh`/);
    expect(h.ledger.spentAtomic).toBe(0n);
  });

  it('maps an uncharged 422 on /ask', async () => {
    const h = harness({
      routes: { '/catalog': { body: CATALOG_WITH_ASK } },
      paid: {
        respond: err(422, envelope('OUT_OF_SCOPE', 'Forecasts are out of scope.')),
        quoteAtomic: 150_000n,
      },
      env: { ALGOTERMINAL_MAX_PER_CALL_USDC: '0.20' },
    });
    const text = bodyText(await askTool(h.ctx, { question: 'Will TINY go up next week?' }));
    expect(text).toContain('ERROR 422 OUT_OF_SCOPE');
    expect(text).toContain('YOU WERE NOT CHARGED');
    expect(text).toMatch(/no forecasts, no price targets/i);
    expect(h.ledger.spentAtomic).toBe(0n);
  });
});

describe('route availability is checked at runtime', () => {
  it('refuses /ask on a deployment that reports it unavailable, without paying', async () => {
    const h = harness({ paid: { respond: ok({}), quoteAtomic: 150_000n } });
    const result = await askTool(h.ctx, { question: 'What is the TVL of Tinyman?' });
    expect(result.isError).toBe(true);
    expect(bodyText(result)).toContain('ROUTE NOT AVAILABLE');
    expect(bodyText(result)).toContain('Nothing was spent');
    expect(h.payer?.calls).toEqual([]);
  });

  it('rejects an unknown protocol from the live catalog rather than paying to find out', async () => {
    const h = harness({ paid: { respond: ok(TINYMAN_TVL), quoteAtomic: 5000n } });
    const result = await metricTool(h.ctx, { protocol: 'algofi', kpi: 'tvl' });
    expect(result.isError).toBe(true);
    expect(bodyText(result)).toContain('tinyman (dex)');
    expect(h.payer?.calls).toEqual([]);
  });
});

describe('the catalog tool', () => {
  it('reports every decline in full, with the instruction not to zero it', async () => {
    const h = harness();
    const text = bodyText(await catalogTool(h.ctx));
    expect(text).toContain(PACT_TAKE_RATE_DECLINE);
    expect(text).toMatch(/never substitute zero/);
    expect(text).toContain('NOT AVAILABLE on this deployment');
    expect(text).toContain('base $0.005');
    expect(text).toContain('fresh=true $0.02');
    expect(text).toContain('active_users_24h $0.03');
  });

  it('reads coverage live rather than from a hardcoded matrix', async () => {
    const grown = {
      ...CATALOG,
      protocols: [...CATALOG.protocols, { id: 'algofi', name: 'Algofi', class: 'lending', kpis: ['tvl'] }],
    };
    const h = harness({ routes: { '/catalog': { body: grown } } });
    expect(bodyText(await catalogTool(h.ctx))).toContain('algofi — Algofi (lending)');
  });
});

describe('the methodology tool', () => {
  it('surfaces the cross-class basis, which is what justifies a cross-type comparison', async () => {
    const h = harness({ routes: { '/methodology': { body: METHODOLOGY_DOC } } });
    const text = bodyText(await methodologyTool(h.ctx, { kpi: 'capital_efficiency' }));
    expect(text).toContain('CROSS-CLASS BASIS');
    expect(text).toContain('§3.1 defines gross_fees identically for both');
  });

  it('lists the KPIs it does define when asked for one it does not', async () => {
    const h = harness({ routes: { '/methodology': { body: METHODOLOGY_DOC } } });
    const result = await methodologyTool(h.ctx, { kpi: 'sharpe_ratio' });
    expect(result.isError).toBe(true);
    expect(bodyText(result)).toContain('capital_efficiency');
  });
});
