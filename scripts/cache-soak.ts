/**
 * A soak run of the real thing: the refresher on its two cycles, steady
 * traffic through the read path, and `/health` sampled as it warms.
 *
 *   MAINNET_ALGOD_URL=https://mainnet-api.4160.nodely.dev \
 *   MAINNET_INDEXER_URL=https://mainnet-idx.4160.nodely.dev \
 *   npx tsx --env-file=.env scripts/cache-soak.ts [--minutes 5] [--rps 2]
 *
 * What it is for: PRD.md §5.1 sets a 70% cache hit rate as a target, and
 * ARCHITECTURE.md §4.6 claims the refresher makes that a floor rather than a
 * hope. This is where that claim is measured against a live upstream instead
 * of asserted.
 */
import { serve } from '@hono/node-server';

import { createApp } from '../src/app.js';
import { cacheDeps, getFact } from '../src/cache/index.js';
import { fullMatrix } from '../src/cache/hotset.js';
import { closeL1 } from '../src/cache/redis.js';
import { env } from '../src/config/env.js';
import { closeDb } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { refresher } from '../src/jobs/refresher.js';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const minutes = arg('minutes', 5);
const rps = arg('rps', 2);
const port = 3999;

const out = (line: string): void => void process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  await migrate();

  const server = serve({ fetch: createApp().fetch, port });
  refresher.start();

  const keys = fullMatrix();
  out(`hot set: ${keys.length} facts across ${new Set(keys.map((k) => k.protocol)).size} protocol(s)`);
  out(`driving ${rps} req/s for ${minutes} min against a live upstream\n`);

  let requests = 0;
  const traffic = setInterval(() => {
    // Uniform over the matrix, which is the harshest realistic pattern: real
    // traffic is Zipf-ish and concentrates on a few KPIs, so a uniform driver
    // understates the hit rate rather than flattering it.
    const key = keys[Math.floor(Math.random() * keys.length)];
    if (key === undefined) return;
    requests += 1;
    void getFact(key).catch(() => undefined);
  }, 1_000 / rps);

  const started = Date.now();
  const sample = setInterval(() => {
    void (async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      const body = (await res.json()) as {
        status: string;
        cache: {
          hit_rate_1h: number | null;
          lookups_1h?: number;
          redis: string | null;
          refresher?: Record<string, { last_duration_ms: number | null; interval_s: number; skipped: number; overruns: number; running: boolean }>;
        };
      };
      const elapsed = Math.round((Date.now() - started) / 1_000);
      const fast = body.cache.refresher?.fast;
      const slow = body.cache.refresher?.slow;
      out(
        `t+${String(elapsed).padStart(3)}s  status=${body.status}  ` +
          `hit_rate_1h=${String(body.cache.hit_rate_1h)}  ` +
          `lookups=${String(body.cache.lookups_1h)}  redis=${String(body.cache.redis)}  ` +
          `fast=${fmtCycle(fast)}  slow=${fmtCycle(slow)}`,
      );
    })();
  }, 15_000);

  await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));

  clearInterval(traffic);
  clearInterval(sample);
  refresher.stop();

  const health = await (await fetch(`http://localhost:${port}/health`)).json();
  out(`\nfinal /health (methodology_version ${env.METHODOLOGY_VERSION}):`);
  out(JSON.stringify(health, null, 2));
  out(`\nrequests issued: ${requests}`);
  out(`cache stats: ${JSON.stringify(cacheDeps().metrics.stats(cacheDeps().l0.size))}`);

  server.close();
}

function fmtCycle(
  c: { last_duration_ms: number | null; interval_s: number; skipped: number; running: boolean } | undefined,
): string {
  if (c === undefined) return 'n/a';
  const dur = c.last_duration_ms === null ? '-' : `${Math.round(c.last_duration_ms / 1_000)}s`;
  return `${dur}/${c.interval_s}s${c.running ? ' (running)' : ''}${c.skipped > 0 ? ` skip=${c.skipped}` : ''}`;
}

try {
  await main();
} finally {
  await closeL1();
  await closeDb();
  process.exit(0);
}
