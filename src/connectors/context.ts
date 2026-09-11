import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { createAlgodClient } from './algod.js';
import { createHttpClient, type SharedHttpClient } from './http.js';
import { createIndexerClient } from './indexer.js';
import { createPriceService } from './price/index.js';
import type { ConnectorContext } from './types.js';

/**
 * The production {@link ConnectorContext} factory.
 *
 * Its four I/O services are shared infrastructure a connector must not
 * reimplement (CONNECTOR_GUIDE.md §4): the `ctx.http` client with its timeout,
 * retry/backoff and per-host concurrency cap (§4.1), the Nodely algod and
 * indexer clients (§4.2), and the price service (§4.3).
 *
 * Built once and memoised. Not for speed: the §4.1 per-host concurrency cap and
 * the per-host counters `/health` reports are state *on the client*, so a
 * second client would quietly double the concurrency we promise an upstream and
 * split the counters in half — the exact way a "harmless" factory call gets a
 * source to ban us.
 */
let cached: { context: ConnectorContext; http: SharedHttpClient } | null = null;

export function connectorContext(): ConnectorContext {
  return (cached ??= build()).context;
}

/** Per-host request counters for `/health` (§4.1), or `{}` before first use. */
export function httpCounters(): Record<string, ReturnType<SharedHttpClient['counters']>[string]> {
  return cached?.http.counters() ?? {};
}

/** Drops the memoised context. Tests only — production builds it once. */
export function resetConnectorContext(): void {
  cached = null;
}

function build(): { context: ConnectorContext; http: SharedHttpClient } {
  const log = logger.child({ component: 'connector' });
  const http = createHttpClient({ log });
  const now = (): Date => new Date();

  return {
    http,
    context: {
      http,
      algod: createAlgodClient({ baseUrl: env.ALGOD_URL, http }),
      indexer: createIndexerClient({ baseUrl: env.INDEXER_URL, http }),
      prices: createPriceService({ http, log: log.child({ component: 'prices' }), now }),
      log,
      now,
    },
  };
}
