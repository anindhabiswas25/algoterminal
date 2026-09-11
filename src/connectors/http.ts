import type { Logger } from 'pino';

import { chargeFetchBudget, FetchBudgetExceededError } from './budget.js';
import type { HttpClient } from './types.js';

/**
 * CONNECTOR_GUIDE.md §4.1 — the one HTTP client every connector must use.
 *
 * A connector that calls bare `fetch` bypasses the timeout, the retry policy,
 * the per-host concurrency cap and the identifying User-Agent, and will
 * eventually get us rate-limited or banned from a source we depend on. That is
 * not hypothetical here: Tinyman's analytics API throttles (HTTP 429 with a
 * `Retry-After` header) at eight unpaced concurrent requests — verified live on
 * 2026-09-08, see `src/connectors/tinyman/README.md`.
 *
 * `getJson` returns `unknown` on purpose (§1.2): every upstream payload is
 * zod-validated at the connector boundary, and a typed return would let a
 * connector skip that by asserting a shape the upstream never promised.
 */

/** §4.1 — 8s timeout. */
export const DEFAULT_TIMEOUT_MS = 8_000;
/** §4.1 — 3 retries with exponential backoff + jitter. */
export const DEFAULT_RETRIES = 3;
/** §4.1 — per-host concurrency cap. */
export const DEFAULT_CONCURRENCY = 8;

/**
 * Hosts whose tolerance is lower than the §4.1 default — §4g item 2.
 *
 * ## The problem
 *
 * Tinyman's analytics API returned `429 Throttled` on `/api/v1/pools/` and
 * `/api/v1/assets/` during the refresher's own cycle at the default cap of 8,
 * and this connector's README records a 429 with `Retry-After: 18` at exactly
 * eight unpaced concurrent requests. The backoff handled it correctly and
 * nothing returned wrong — but the retries are what pushed a `?fresh=true`
 * handler past two minutes and past the payment window it was paid with.
 *
 * ## Why 5 and not 3
 *
 * Measured 2026-09-09 against the live API, running the cold fetch a
 * `?fresh=true` request actually performs (the fast TTL class for tinyman,
 * ~98 requests to this host):
 *
 * | cap | fetch seconds | 429s |
 * |---|---|---|
 * | 8 | 33.6, 27.7, 29.8, 29.3 | 0 / 197 |
 * | 5 | 32.6, 35.1 | 0 / 198 |
 * | 4 | 29.1, 56.3 | 0 / 198 |
 * | 3 | 48.7, 33.5 | 0 / 198 |
 *
 * Two things follow, and they pull in opposite directions. Nothing throttled at
 * any cap on the day of the measurement, so the 429s are episodic rather than a
 * fixed property of eight-way concurrency — which means a cap cannot be
 * justified as "the level that stops 429s", because no level was needed that
 * day. But lowering the cap is not free: it costs wall time on the fetch, and
 * as of §4g item 1 that fetch is bounded by the caller's payment window. Time
 * spent there is now margin against a 504.
 *
 * Three was the first choice and it is the wrong one: ~40% slower on the one
 * path with a hard deadline, buying protection against a failure that could not
 * be reproduced. Five is a 37% reduction in burst pressure below the level
 * where 429s have actually been observed, for ~15% on the fetch. That is the
 * side of the trade worth being on — and `connectors/budget.ts` bounds the
 * retry storm itself, which is the part that did the damage.
 *
 * Per-host rather than global for the reason `Semaphore` gives: one upstream's
 * rate limit must not slow down a different upstream that is perfectly happy.
 */
export const HOST_CONCURRENCY: Readonly<Record<string, number>> = Object.freeze({
  'mainnet.analytics.tinyman.org': 5,
});
/** Base of the exponential backoff, in ms: 250, 500, 1000. */
export const BACKOFF_BASE_MS = 250;
/**
 * A `Retry-After` longer than this is honoured up to this bound rather than
 * slept off in full. An upstream asking us to wait two minutes has told us we
 * are over budget; blocking a whole fetch on it turns a slow snapshot into a
 * timed-out one.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Per-host request counters, exposed on `/health` (§4.1). */
export interface HostCounters {
  requests: number;
  failures: number;
  retries: number;
  throttled: number;
}

export interface HttpClientOptions {
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly concurrency?: number;
  /** Per-host overrides of {@link concurrency}. Defaults to {@link HOST_CONCURRENCY}. */
  readonly concurrencyByHost?: Readonly<Record<string, number>>;
  readonly log?: Logger;
  /** Injected so tests need neither a real clock nor a real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so tests need no network. Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected so backoff jitter is deterministic under test. */
  readonly random?: () => number;
}

export interface SharedHttpClient extends HttpClient {
  /** Snapshot of the per-host counters, for `/health`. */
  counters(): Record<string, HostCounters>;
}

/**
 * An error carrying the status code, so a caller can tell "upstream said no"
 * from "the network broke" without string-matching a message.
 */
export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`GET ${url} -> ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
  }
}

/**
 * A counting semaphore, one per host.
 *
 * Per-HOST rather than global: the cap exists to stay inside one upstream's
 * tolerance, and a global cap would let a slow Tinyman page block a Pact fetch
 * that the Pact API was perfectly happy to serve.
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Status codes worth retrying: throttling and transient server failures. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * `Retry-After` in ms, or null when absent/unparseable. Both forms of the
 * header are accepted: delta-seconds (what Tinyman sends) and an HTTP-date.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - nowMs, 0), MAX_RETRY_AFTER_MS);
}

export function createHttpClient(options: HttpClientOptions = {}): SharedHttpClient {
  const {
    userAgent = 'AlgoTerminal/0.1 (+https://github.com/SamyaDeb/algoterminal)',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    concurrency = DEFAULT_CONCURRENCY,
    concurrencyByHost = HOST_CONCURRENCY,
    log,
    sleep = defaultSleep,
    fetch: doFetch = globalThis.fetch,
    random = Math.random,
  } = options;

  const semaphores = new Map<string, Semaphore>();
  const counters = new Map<string, HostCounters>();

  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return '(invalid)';
    }
  };
  const semaphoreFor = (host: string): Semaphore => {
    let s = semaphores.get(host);
    if (s === undefined) {
      s = new Semaphore(concurrencyByHost[host] ?? concurrency);
      semaphores.set(host, s);
    }
    return s;
  };
  const counterFor = (host: string): HostCounters => {
    let c = counters.get(host);
    if (c === undefined) {
      c = { requests: 0, failures: 0, retries: 0, throttled: 0 };
      counters.set(host, c);
    }
    return c;
  };

  async function attempt(url: string, ms: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': userAgent },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new HttpError(url, res.status, body);
        // The header is only meaningful on the response that carried it, so it
        // rides along on the error rather than being re-read later.
        (err as HttpError & { retryAfterMs?: number | null }).retryAfterMs = parseRetryAfter(
          res.headers.get('retry-after'),
          Date.now(),
        );
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    counters(): Record<string, HostCounters> {
      return Object.fromEntries([...counters].map(([host, c]) => [host, { ...c }]));
    },

    async getJson(url: string, opts?: { readonly timeoutMs?: number }): Promise<unknown> {
      const host = hostOf(url);
      const counter = counterFor(host);
      const ms = opts?.timeoutMs ?? timeoutMs;

      return semaphoreFor(host).run(async () => {
        let lastError: unknown;
        // A budget refusal is our own decision, not an upstream failure, so it
        // is rethrown before it can touch this host's counters — otherwise a
        // bounded fresh fetch would show up on /health as the upstream being
        // unreliable.
        for (let attemptNo = 0; attemptNo <= retries; attemptNo++) {
          // Charged BEFORE the request, and charged again on every retry: the
          // retries are what overran the payment window (§4g item 1), so a
          // retry has to cost the caller's budget exactly what a first try
          // does. Outside a `withFetchBudget` scope this is a no-op.
          chargeFetchBudget(url);
          counter.requests++;
          try {
            return await attempt(url, ms);
          } catch (err) {
            if (err instanceof FetchBudgetExceededError) throw err;
            lastError = err;
            const status = err instanceof HttpError ? err.status : 0;
            if (status === 429) counter.throttled++;
            // A 4xx that is not throttling will not become a 2xx on retry;
            // burning three more requests on it only spends our rate budget.
            const retryable = status === 0 || isRetryableStatus(status);
            if (!retryable || attemptNo === retries) break;

            counter.retries++;
            const retryAfter =
              err instanceof HttpError
                ? ((err as HttpError & { retryAfterMs?: number | null }).retryAfterMs ?? null)
                : null;
            // Exponential backoff with full jitter, unless the upstream told us
            // exactly how long to wait — in which case obeying it is both
            // politer and faster than guessing.
            const backoff =
              retryAfter ?? Math.round(BACKOFF_BASE_MS * 2 ** attemptNo * (0.5 + random()));
            log?.debug({ url, status, attemptNo, backoff }, 'http retry');
            await sleep(backoff);
          }
        }
        counter.failures++;
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      });
    },
  };
}
