/**
 * The AlgoTerminal HTTP client.
 *
 * Split cleanly in two, and the split is the point:
 *
 *  - **`getFree`** uses plain `fetch`. It cannot pay, because it does not have
 *    the paying fetch. `/catalog`, `/methodology`, `/health`, `/llms.txt` and
 *    `/openapi.json` are free, must stay free, and the way to guarantee that in
 *    code is to make paying structurally unavailable on that path rather than
 *    merely unused.
 *  - **`getPaid` / `postPaid`** go through the `Payer`, which enforces the caps.
 *
 * There is deliberately no cache here. AlgoTerminal already caches with per-KPI
 * TTLs and reports `cache` and `stale` on every fact — that freshness signal is
 * part of what the caller is paying to see. A second cache in front of it would
 * report a stale number as a `cache: "hit"`, which is the exact confusion the
 * service's design goes out of its way to avoid.
 */
import type { Config } from './config.js';
import { mapError, type MappedError } from './errors.js';
import type { PaymentBackend, PaidResult } from './payer.js';
import type { Catalog } from './types.js';

export class ServiceUnreachableError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(
      `Could not reach AlgoTerminal at ${url}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'Nothing was spent. Check ALGOTERMINAL_BASE_URL and your network connection.',
    );
    this.name = 'ServiceUnreachableError';
  }
}

export interface FreeResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

export class AlgoTerminalClient {
  constructor(
    readonly config: Config,
    /** Null when no key is configured: every free tool still works, paid ones explain themselves. */
    readonly payer: PaymentBackend | null,
    private readonly baseFetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  url(path: string, query: Record<string, string | undefined> = {}): string {
    const u = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  /** A free endpoint. Uses unpaid `fetch`; there is no payment path from here. */
  async getFree(path: string, query: Record<string, string | undefined> = {}): Promise<FreeResult> {
    const url = this.url(path, query);
    let res: Response;
    try {
      res = await this.baseFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (cause) {
      throw new ServiceUnreachableError(url, cause);
    }
    const body = await res
      .clone()
      .json()
      .catch(async () => await res.text().catch(() => null));
    return { status: res.status, ok: res.ok, body };
  }

  /**
   * The live capability list.
   *
   * Read fresh on every call that needs it, never memoized. Coverage grows as
   * connectors are added and routes flip availability (today `/ask` is `false`
   * because this deployment has no synthesis key), so a snapshot taken at
   * startup would advertise KPIs that 404 and hide ones that work.
   */
  async getCatalog(): Promise<Catalog> {
    const { ok, status, body } = await this.getFree('/catalog');
    if (!ok) {
      const err = mapError(status, body);
      throw new Error(`GET /catalog failed: ${err.status} ${err.code} — ${err.message}`);
    }
    return body as Catalog;
  }

  async getPaid(path: string, query: Record<string, string | undefined>, label: string): Promise<PaidResult> {
    if (this.payer === null) throw new Error('No payer configured.');
    return await this.payer.pay(
      this.url(path, query),
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.config.requestTimeoutMs) },
      label,
    );
  }

  async postPaid(
    path: string,
    query: Record<string, string | undefined>,
    body: unknown,
    label: string,
  ): Promise<PaidResult> {
    if (this.payer === null) throw new Error('No payer configured.');
    return await this.payer.pay(
      this.url(path, query),
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      },
      label,
    );
  }
}

export function describeFailure(result: PaidResult): MappedError {
  return mapError(result.status, result.body);
}
