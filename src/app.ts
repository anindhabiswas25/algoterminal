import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { ApiError, envelope } from './errors.js';
import { health } from './routes/health.js';
import { catalog } from './routes/catalog.js';
import { llms } from './routes/llms.js';
import { metric } from './routes/metric.js';
import { methodology } from './routes/methodology.js';
import { openapi } from './routes/openapi.js';
import { compare } from './routes/compare.js';
import { ask } from './routes/ask.js';
import { landing } from './routes/landing.js';
import { paymentGate, type GateDeps } from './gate/middleware.js';

export function createApp(gateDeps?: GateDeps) {
  const app = new Hono();

  // Structured request log: method, path, status, duration_ms.
  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms: Number((performance.now() - startedAt).toFixed(2)),
      },
      'request',
    );
  });

  // CORS '*' on free routes only (API_SPEC.md §5). Paid routes are for
  // server-side agents; a permissive policy there would only invite confused
  // browser clients, and they are deliberately absent from this list.
  app.use('/health', cors());
  app.use('/catalog', cors());
  app.use('/llms.txt', cors());
  app.use('/openapi.json', cors());
  app.use('/methodology', cors());
  app.use('/', cors());

  // The x402 gate (ARCHITECTURE.md §4.1). Mounted on '*' rather than on a list
  // of paid paths: it decides what is paid by asking `src/pricing.ts`, so a
  // route added there is gated without editing this file, and there is no
  // second list of paid paths to forget to update. Free routes fall straight
  // through — the gate's first branch — so /health and /catalog never depend on
  // the facilitator being reachable.
  //
  // It sits AFTER the CORS and logging middleware and BEFORE every route, which
  // is what makes "verify before the handler" a property of the app's shape
  // rather than of each handler remembering.
  app.use('*', paymentGate(gateDeps));

  app.route('/', health);
  app.route('/', catalog);
  app.route('/', llms);
  app.route('/', openapi);
  app.route('/', methodology);
  app.route('/', metric);
  app.route('/', compare);
  app.route('/', ask);

  // The landing page (DEPLOYMENT.md §6.3), generated from `pricing.ts` and
  // `config/x402.ts` so its price table cannot drift from the charged price.
  // Registered BEFORE serveStatic, which now serves only the two things that
  // really are static bytes: og-banner.png and favicon.png.
  app.route('/', landing);
  app.use('/*', serveStatic({ root: './public' }));

  app.notFound((c) =>
    c.json(
      envelope('NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`, {
        method: c.req.method,
        path: c.req.path,
      }),
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      logger.warn(
        { code: err.code, status: err.status, path: c.req.path, detail: err.detail },
        err.message,
      );
      return c.json(envelope(err.code, err.message, err.detail), err.status);
    }

    logger.error({ err, path: c.req.path }, 'unhandled error');
    // Never leak internals to the caller; the log has the stack.
    return c.json(
      envelope(
        'INTERNAL_ERROR',
        'An unexpected error occurred.',
        env.NODE_ENV === 'development' ? { message: String(err) } : {},
      ),
      500,
    );
  });

  return app;
}
