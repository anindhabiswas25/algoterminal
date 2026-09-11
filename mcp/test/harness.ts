/**
 * Test harness.
 *
 * Two properties the suite depends on:
 *
 *  - **Nothing reaches the network.** Every request goes through `stubFetch`,
 *    which throws on any URL it was not given a handler for. A test that
 *    accidentally hits the live service would spend real USDC, so an unstubbed
 *    request is a hard failure rather than a pass-through.
 *  - **Payment is observable.** `RecordingPayer` implements the same
 *    `PaymentBackend` the real signer does, so the tools cannot tell the
 *    difference — and every call through it is recorded, which is how the
 *    "free tools never pay" tests prove a negative.
 */
import { AlgoTerminalClient } from '../src/client.js';
import { loadConfig, type Config } from '../src/config.js';
import type { PaidResult, PaymentBackend } from '../src/payer.js';
import { SpendLedger } from '../src/spend.js';
import type { ToolContext } from '../src/tools/shared.js';
import { CATALOG } from './fixtures.js';

export const BASE = 'https://algoterminal.test';

export interface StubRoute {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FetchStub {
  fetch: typeof globalThis.fetch;
  /** Every URL requested, in order. */
  readonly calls: { url: string; init: RequestInit | undefined }[];
}

/**
 * A fetch that serves only what it was told to serve.
 *
 * Keys are matched as substrings of the URL, longest first, so a test can pin
 * `/metric/pact/take_rate` without also having to describe `/metric`.
 */
export function stubFetch(routes: Record<string, StubRoute>): FetchStub {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);

  const fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const key = keys.find((k) => url.includes(k));
    if (key === undefined) {
      throw new Error(
        `stubFetch: no handler for ${url}. Tests must never reach the network — a live request here would ` +
          `spend real USDC. Known handlers: ${keys.join(', ')}`,
      );
    }
    const route = routes[key];
    if (route === undefined) throw new Error(`stubFetch: handler for ${key} is undefined`);
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

/**
 * A payment backend that settles whatever it is asked to, at a fixed price, and
 * remembers every call. Credits the same ledger the real `Payer` credits, from
 * the same place: after a successful response.
 */
export class RecordingPayer implements PaymentBackend {
  readonly address = 'TESTPAYERADDRESS7777777777777777777777777777777777777777';
  readonly calls: { url: string; label: string; init: RequestInit }[] = [];

  constructor(
    private readonly ledger: SpendLedger,
    private readonly respond: (url: string) => { status: number; body: unknown },
    private readonly quoteAtomic: bigint,
    private readonly txid: string | null = 'TESTTXID4RXWFXCEXAMPLE7777777777777777777777777777777777',
  ) {}

  async pay(url: string, init: RequestInit, label: string): Promise<PaidResult> {
    this.calls.push({ url, label, init });
    // The real Payer vetoes here, before signing. Mirror that so a cap test
    // exercising this backend fails the same way the real one would.
    this.ledger.assertAllowed(this.quoteAtomic, label);
    const { status, body } = this.respond(url);
    const ok = status >= 200 && status < 300;
    return {
      status,
      ok,
      body,
      quotedAtomic: this.quoteAtomic,
      settlement: ok ? this.ledger.record(label, this.quoteAtomic, this.txid) : null,
    };
  }
}

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    ALGOTERMINAL_BASE_URL: BASE,
    ALGOTERMINAL_NETWORK: 'testnet',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface Harness {
  ctx: ToolContext;
  ledger: SpendLedger;
  payer: RecordingPayer | null;
  fetchStub: FetchStub;
}

export function harness(
  options: {
    env?: Partial<NodeJS.ProcessEnv>;
    routes?: Record<string, StubRoute>;
    paid?: { respond: (url: string) => { status: number; body: unknown }; quoteAtomic: bigint; txid?: string | null };
  } = {},
): Harness {
  const config = testConfig(options.env);
  const ledger = new SpendLedger(config.maxSessionAtomic, config.maxPerCallAtomic);
  const fetchStub = stubFetch({ '/catalog': { body: CATALOG }, ...(options.routes ?? {}) });
  const payer =
    options.paid === undefined
      ? null
      : new RecordingPayer(ledger, options.paid.respond, options.paid.quoteAtomic, options.paid.txid ?? undefined);
  const client = new AlgoTerminalClient(config, payer, fetchStub.fetch);
  return { ctx: { client, ledger, config }, ledger, payer, fetchStub };
}

export function bodyText(result: { content: { type: 'text'; text: string }[] }): string {
  return result.content.map((c) => c.text).join('\n\n');
}
