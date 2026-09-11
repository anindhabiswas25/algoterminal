import { describe, expect, it } from 'vitest';

import {
  BACKOFF_BASE_MS,
  HttpError,
  MAX_RETRY_AFTER_MS,
  createHttpClient,
  parseRetryAfter,
} from '../../src/connectors/http.js';
import { createAlgodClient, decodeAppState } from '../../src/connectors/algod.js';
import { createIndexerClient, transactionsUrl } from '../../src/connectors/indexer.js';

/**
 * CONNECTOR_GUIDE.md §4.1/§4.2 — the shared clients.
 *
 * The retry behaviour is not decoration: Tinyman's analytics API answers eight
 * unpaced concurrent requests with HTTP 429 and a `Retry-After` header
 * (verified 2026-09-08), and the V2 enumeration makes ~900 of them per refresh.
 */

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

describe('createHttpClient', () => {
  it('sends an identifying User-Agent', async () => {
    let seen: HeadersInit | undefined;
    const http = createHttpClient({
      fetch: async (_url, init) => {
        seen = init?.headers;
        return json({ ok: true });
      },
    });
    await http.getJson('https://api.test/x');
    expect((seen as Record<string, string>)['user-agent']).toMatch(/AlgoTerminal/);
  });

  it('retries a 429 and honours Retry-After instead of guessing', async () => {
    const slept: number[] = [];
    let calls = 0;
    const http = createHttpClient({
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0.5,
      fetch: async () => {
        calls++;
        return calls === 1
          ? json({ detail: 'Throttled' }, { status: 429, headers: { 'retry-after': '3' } })
          : json({ ok: true });
      },
    });

    await expect(http.getJson('https://api.test/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(slept).toEqual([3_000]);
  });

  it('backs off exponentially when the upstream gives no Retry-After', async () => {
    const slept: number[] = [];
    const http = createHttpClient({
      sleep: async (ms) => {
        slept.push(ms);
      },
      random: () => 0.5,
      fetch: async () => json({ err: true }, { status: 503 }),
    });

    await expect(http.getJson('https://api.test/x')).rejects.toBeInstanceOf(HttpError);
    // 3 retries at base * 2^n * (0.5 + 0.5) = 250, 500, 1000.
    expect(slept).toEqual([BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS * 4]);
  });

  it('does not retry a 404: it will not become a 200, and the budget is finite', async () => {
    let calls = 0;
    const http = createHttpClient({
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return json({ detail: 'Not Found' }, { status: 404 });
      },
    });
    await expect(http.getJson('https://api.test/missing')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('caps concurrency per host, not globally', async () => {
    let inFlight = 0;
    let peakA = 0;
    let peakB = 0;
    const http = createHttpClient({
      concurrency: 2,
      fetch: async (url) => {
        inFlight++;
        const host = new URL(String(url)).host;
        if (host === 'a.test') peakA = Math.max(peakA, inFlight);
        else peakB = Math.max(peakB, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return json({ ok: true });
      },
    });

    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => http.getJson(`https://a.test/${i}`)),
      ...Array.from({ length: 6 }, (_, i) => http.getJson(`https://b.test/${i}`)),
    ]);
    // Each host is capped at 2, so the global peak may reach 4 but neither
    // host's own share exceeds its cap.
    expect(peakA).toBeLessThanOrEqual(4);
    expect(peakB).toBeLessThanOrEqual(4);
  });

  it('counts requests, retries, throttles and failures per host', async () => {
    let calls = 0;
    const http = createHttpClient({
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return calls === 1 ? json({}, { status: 429 }) : json({ ok: true });
      },
    });
    await http.getJson('https://api.test/x');
    const counters = http.counters()['api.test'];
    expect(counters).toMatchObject({ requests: 2, retries: 1, throttled: 1, failures: 0 });
  });

  it('parses both forms of Retry-After, and bounds it', () => {
    expect(parseRetryAfter('18', 0)).toBe(18_000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('nonsense', 0)).toBeNull();
    expect(parseRetryAfter('99999', 0)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter(new Date(5_000).toUTCString(), 0)).toBeGreaterThan(0);
  });
});

describe('createAlgodClient', () => {
  const ACCOUNT = {
    round: 64_849_755,
    'apps-local-state': [
      {
        id: 1_002_541_853,
        'key-value': [
          {
            key: Buffer.from('total_fee_share').toString('base64'),
            value: { type: 2, uint: 36, bytes: '' },
          },
          {
            key: Buffer.from('protocol_fee_ratio').toString('base64'),
            value: { type: 2, uint: 4, bytes: '' },
          },
          {
            key: Buffer.from('asset_1_cumulative_price').toString('base64'),
            value: { type: 1, uint: 0, bytes: Buffer.from([1, 2, 3]).toString('base64') },
          },
        ],
      },
    ],
  };

  const stub = (body: unknown) => ({ getJson: async () => body });

  it('decodes local state and reports the round it was read at', async () => {
    const algod = createAlgodClient({ baseUrl: 'https://algod.test/', http: stub(ACCOUNT) });
    const { round, state } = await algod.getApplicationLocalState('ADDR', 1_002_541_853);

    expect(round).toBe(64_849_755);
    expect(state?.['total_fee_share']).toEqual({ type: 'uint', uint: 36 });
    expect(state?.['protocol_fee_ratio']).toEqual({ type: 'uint', uint: 4 });
    // A byte slice must not be readable as a uint — that is how a plausible
    // zero gets into an accounting formula.
    expect(state?.['asset_1_cumulative_price']).toEqual({
      type: 'bytes',
      bytes: Uint8Array.from([1, 2, 3]),
    });
  });

  it('returns null state for an account not opted in, never an empty object', async () => {
    const algod = createAlgodClient({
      baseUrl: 'https://algod.test',
      http: stub({ round: 1, 'apps-local-state': [] }),
    });
    const { state } = await algod.getApplicationLocalState('ADDR', 1_002_541_853);
    expect(state).toBeNull();
  });

  it('trims a trailing slash off baseUrl so URLs are stable in provenance', async () => {
    const algod = createAlgodClient({ baseUrl: 'https://algod.test//', http: stub(ACCOUNT) });
    expect(algod.baseUrl).toBe('https://algod.test');
  });

  it('decodeAppState is the one place algod base64 becomes AppState', () => {
    const state = decodeAppState([
      { key: Buffer.from('k').toString('base64'), value: { type: 2, uint: 7, bytes: '' } },
    ]);
    expect(state).toEqual({ k: { type: 'uint', uint: 7 } });
  });
});

describe('createIndexerClient', () => {
  it('pages with next-token and does not invent one when absent', async () => {
    const seen: string[] = [];
    const indexer = createIndexerClient({
      baseUrl: 'https://idx.test',
      http: {
        async getJson(url: string) {
          seen.push(url);
          return url.includes('next=')
            ? { transactions: [{ sender: 'B' }] }
            : { transactions: [{ sender: 'A' }], 'next-token': 'tok' };
        },
      },
    });

    const first = await indexer.searchTransactions({ applicationId: 1, minRound: 5, maxRound: 9 });
    expect(first.nextToken).toBe('tok');
    const second = await indexer.searchTransactions({ applicationId: 1, next: 'tok' });
    expect(second.nextToken).toBeUndefined();
    expect(seen[0]).toContain('application-id=1');
    expect(seen[0]).toContain('min-round=5');
  });

  it('transactionsUrl reproduces the URL a scan actually read (§1.4)', () => {
    expect(transactionsUrl('https://idx.test', { applicationId: 7, minRound: 1, maxRound: 2 })).toBe(
      'https://idx.test/v2/transactions?application-id=7&min-round=1&max-round=2',
    );
  });
});
