import { serve } from '@hono/node-server';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { createApp } from './app.js';
import { activeNetwork } from './config/x402.js';
import { listProtocolIds, validateRegistryOrExit } from './connectors/registry.js';
import { closeL1 } from './cache/redis.js';
import { closeDb } from './db/pool.js';
import { concentrationMonitor } from './jobs/concentration.js';
import { refresher } from './jobs/refresher.js';
import { snapshotter } from './jobs/snapshotter.js';

// Refuse to boot on an incoherent connector registry, the same fail-loud
// principle as env validation: a connector declaring a KPI its class does not
// support would otherwise reach /catalog as a public promise we cannot keep.
validateRegistryOrExit();

const net = activeNetwork();

// The cache is warm because of these two, not because callers happen to repeat
// each other (ARCHITECTURE.md §4.6). Started before the listener so the first
// fast cycle is already underway when the port opens.
refresher.start();
snapshotter.start();
// DEPLOYMENT.md §7.2's weekly volume-integrity review. Started here rather
// than left to a runbook: it is the control that disqualifies an entry, and
// until now it was SQL in a document with nothing running it (§4g item 5).
concentrationMonitor.start();

const server = serve({ fetch: createApp().fetch, port: env.PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      node_env: env.NODE_ENV,
      x402_network: net.network,
      caip2: net.caip2,
      usdc_asa_id: net.usdcAsaId,
      methodology_version: env.METHODOLOGY_VERSION,
      public_base_url: env.PUBLIC_BASE_URL,
      protocols: listProtocolIds(),
    },
    'algoterminal listening',
  );
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  refresher.stop();
  snapshotter.stop();
  concentrationMonitor.stop();

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
    // Closed after the listener, so an in-flight request can still finish its
    // L1 read or L2 fallback rather than failing on a client we shut early.
    void Promise.allSettled([closeL1(), closeDb()]).then(() => {
      logger.info('shutdown complete');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
