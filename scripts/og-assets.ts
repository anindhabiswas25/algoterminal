/**
 * Regenerates `public/og-banner.png` and `public/favicon.png` from the live
 * price table and connector registry (DEPLOYMENT.md §6.3).
 *
 *     npm run og:assets
 *
 * The banner carries prices, and the Bazaar enrichment engine re-fetches it
 * daily, so it is one more surface on which an advertised price can drift from
 * a charged one. It cannot here: the numbers come from `src/pricing.ts` and the
 * protocol names from `capabilities()`, the same declarations `/catalog` and
 * the gate read. Drawing is `scripts/make-og-assets.py` (Pillow); this file is
 * only the half that knows what is true.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { listConnectors } from '../src/connectors/registry.js';
import { gatedRoutes } from '../src/gate/routes.js';
import { formatUsdc } from '../src/pricing.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The base price of each paid route this deployment can actually serve: what a
 * caller pays to try it once.
 *
 * `gatedRoutes()` rather than `paidRoutes()`, for the same reason `/llms.txt`
 * marks an unconfigured `/ask` not-yet-live and `/openapi.json` marks it
 * unavailable. The enrichment engine re-fetches this image daily and puts it in
 * front of operators choosing what to integrate; a price on it for a route that
 * answers 503 is an advertisement we cannot honour. Set ANTHROPIC_API_KEY, run
 * this again, and the card appears.
 */
const prices = gatedRoutes().map((route) => {
  const base = route.variants[0];
  if (base === undefined) throw new Error(`paid route ${route.path} has no price variant`);
  return [`${route.method} ${route.path}`, `$${formatUsdc(base.amountAtomic)}`, base.when];
});

const protocols = listConnectors().map((c) => c.capabilities().name);

const payload = JSON.stringify({ prices, protocols });

const child = spawn('python3', [join(HERE, 'make-og-assets.py')], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.write(payload);
child.stdin.end();
child.on('exit', (code) => process.exit(code ?? 1));
