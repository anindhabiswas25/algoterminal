import { describe, it, expect } from 'vitest';

import {
  chargeFetchBudget,
  fetchBudgetSpent,
  FetchBudgetExceededError,
  withFetchBudget,
} from '../../src/connectors/budget.js';
import {
  createHttpClient,
  DEFAULT_CONCURRENCY,
  HOST_CONCURRENCY,
  HttpError,
} from '../../src/connectors/http.js';

/**
 * The fetch budget — LAUNCH_LOG.md §4g item 2.
 *
 * §4g item 1 makes a runaway `?fresh=true` fetch safe (a free 504 instead of a
 * free 200). This makes it rare, and it makes it explicable: the fetch stops
 * itself before the gate has to, so the handler is still alive to say why.
 */

const OK = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('per-host concurrency (§4g item 2)', () => {
  it('caps Tinyman analytics below the §4.1 default', () => {
    // The host that actually throttled us. Asserted as a fact about the table
    // rather than about the semaphore, because the semaphore is only correct
    // if this entry exists — and this entry is the whole change. It must stay
    // strictly under 8, the level at which a 429 has actually been observed.
    const cap = HOST_CONCURRENCY['mainnet.analytics.tinyman.org'] as number;
    expect(cap).toBe(5);
    expect(cap).toBeLessThan(DEFAULT_CONCURRENCY);
  });

  it('never lets more than the cap be in flight against one host', async () => {
    let inFlight = 0;
    let peak = 0;
    const http = createHttpClient({
      concurrencyByHost: { 'slow.example': 3 },
      fetch: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return OK();
      }) as unknown as typeof globalThis.fetch,
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, i) => http.getJson(`https://slow.example/${i}`)),
    );

    expect(peak).toBe(3);
  });

  it('does not slow a host that never asked us to', async () => {
    // Per-host, not global: Tinyman's limit must not throttle Pact. This is the
    // property that makes lowering one host's cap a cheap change.
    let peak = 0;
    let inFlight = 0;
    const http = createHttpClient({
      concurrencyByHost: { 'slow.example': 1 },
      concurrency: 8,
      fetch: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return OK();
      }) as unknown as typeof globalThis.fetch,
    });

    await Promise.all(Array.from({ length: 8 }, (_, i) => http.getJson(`https://other.example/${i}`)));
    expect(peak).toBe(8);
  });
});

describe('withFetchBudget', () => {
  it('is a no-op outside a budget, so the refresher is unaffected', () => {
    // The refresher and every free route run outside a budget and must keep
    // running exactly as before — the bound belongs to the paid fresh path.
    expect(fetchBudgetSpent()).toBeNull();
    expect(() => chargeFetchBudget('https://example/1')).not.toThrow();
  });

  it('refuses the request past the request limit', async () => {
    await withFetchBudget({ maxRequests: 2, deadlineAtMs: Date.now() + 60_000 }, async () => {
      chargeFetchBudget('https://example/1');
      chargeFetchBudget('https://example/2');
      expect(fetchBudgetSpent()).toBe(2);
      expect(() => chargeFetchBudget('https://example/3')).toThrow(FetchBudgetExceededError);
    });
  });

  it('refuses the request past the deadline', async () => {
    await withFetchBudget({ maxRequests: 100, deadlineAtMs: 1_000 }, async () => {
      expect(() => chargeFetchBudget('https://example/1', 999)).not.toThrow();
      expect(() => chargeFetchBudget('https://example/1', 1_001)).toThrow(FetchBudgetExceededError);
    });
  });

  it('charges every RETRY, not only every request', async () => {
    // The point of the whole exercise. A 429 with backoff turns one logical
    // request into four, and it was the retries — not the requests — that took
    // a handler past two minutes. A budget that counted only first attempts
    // would have bounded nothing.
    let attempts = 0;
    const http = createHttpClient({
      retries: 3,
      sleep: async () => undefined,
      fetch: (async () => {
        attempts += 1;
        return new Response('Throttled', { status: 429, headers: { 'retry-after': '1' } });
      }) as unknown as typeof globalThis.fetch,
    });

    await withFetchBudget({ maxRequests: 2, deadlineAtMs: Date.now() + 60_000 }, async () => {
      await expect(http.getJson('https://throttled.example/pools')).rejects.toBeInstanceOf(
        FetchBudgetExceededError,
      );
    });

    // Two attempts made, the third refused — rather than the four the retry
    // policy would otherwise have spent.
    expect(attempts).toBe(2);
  });

  it('lets a budget refusal out rather than retrying it as an upstream failure', async () => {
    // A budget refusal is our decision, not the upstream's. Retrying it would
    // be retrying ourselves, and counting it against the host would make
    // /health report a healthy upstream as unreliable.
    const http = createHttpClient({
      retries: 3,
      sleep: async () => undefined,
      fetch: (async () => OK()) as unknown as typeof globalThis.fetch,
    });

    await withFetchBudget({ maxRequests: 0, deadlineAtMs: Date.now() + 60_000 }, async () => {
      await expect(http.getJson('https://example.test/a')).rejects.toBeInstanceOf(
        FetchBudgetExceededError,
      );
    });

    // The host's counters stay at zero: no request was made, so none is
    // recorded — and crucially no `failures`, which is the number /health
    // would otherwise read as this upstream being unreliable.
    expect(http.counters()['example.test']).toEqual({
      requests: 0,
      failures: 0,
      retries: 0,
      throttled: 0,
    });
  });

  it('still counts and retries a real upstream failure inside a budget', async () => {
    // The budget must not accidentally suppress the §4.1 retry policy for the
    // failures it was written for.
    let attempts = 0;
    const http = createHttpClient({
      retries: 2,
      sleep: async () => undefined,
      fetch: (async () => {
        attempts += 1;
        return new Response('boom', { status: 503 });
      }) as unknown as typeof globalThis.fetch,
    });

    await withFetchBudget({ maxRequests: 50, deadlineAtMs: Date.now() + 60_000 }, async () => {
      await expect(http.getJson('https://flaky.test/a')).rejects.toBeInstanceOf(HttpError);
    });

    expect(attempts).toBe(3);
    expect(http.counters()['flaky.test']?.failures).toBe(1);
  });
});
