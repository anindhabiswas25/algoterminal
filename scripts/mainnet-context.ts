import { pino } from 'pino';

import { createAlgodClient } from '../src/connectors/algod.js';
import { createHttpClient } from '../src/connectors/http.js';
import { createIndexerClient } from '../src/connectors/indexer.js';
import { createPriceService } from '../src/connectors/price/index.js';
import type { ConnectorContext } from '../src/connectors/types.js';

/**
 * A mainnet {@link ConnectorContext} for the live scripts.
 *
 * The scripts read mainnet while `.env` points algod and the indexer at
 * testnet, because the Tinyman connector's app ids and analytics host are
 * mainnet ones and a testnet read would silently return an empty protocol.
 */
export function connectorContextForMainnet(): ConnectorContext {
  const log = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
  const http = createHttpClient({ log });
  const now = (): Date => new Date();

  return {
    http,
    algod: createAlgodClient({
      baseUrl: process.env.MAINNET_ALGOD_URL ?? 'https://mainnet-api.4160.nodely.dev',
      http,
    }),
    indexer: createIndexerClient({
      baseUrl: process.env.MAINNET_INDEXER_URL ?? 'https://mainnet-idx.4160.nodely.dev',
      http,
    }),
    prices: createPriceService({ http, log, now }),
    log,
    now,
  };
}
