/**
 * Cut Redis off mid-run and show that paid requests keep being answered —
 * from L0 and from L2 — with the labels ARCHITECTURE.md §4.5 requires.
 *
 *   MAINNET_ALGOD_URL=... MAINNET_INDEXER_URL=... \
 *   npx tsx --env-file=.env scripts/cache-redis-outage.ts
 *
 * It stops and restarts the local Homebrew Redis service itself, so the outage
 * is a real one: the process loses its connection, `ioredis` starts failing
 * commands, and the read path has to cope without being told in advance.
 */
import { execFileSync } from 'node:child_process';

import { getFact, writeFacts, type CacheDeps } from '../src/cache/index.js';
import { HotSet } from '../src/cache/hotset.js';
import { DEFAULT_PARAMS, type FactKey } from '../src/cache/keys.js';
import { createL0 } from '../src/cache/lru.js';
import { CacheMetrics } from '../src/cache/metrics.js';
import { createRedisL1 } from '../src/cache/redis.js';
import { createPostgresL2 } from '../src/cache/snapshots.js';
import { closeDb } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { computeFacts } from '../src/facts/compute.js';
import { connectorContextForMainnet } from './mainnet-context.js';
import { Snapshotter } from '../src/jobs/snapshotter.js';

const KEY: FactKey = { protocol: 'tinyman', kpi: 'tvl', params: DEFAULT_PARAMS };
const out = (line: string): void => void process.stdout.write(`${line}\n`);

const ctx = connectorContextForMainnet();
const l1 = createRedisL1();
const l2 = createPostgresL2();
const shared: CacheDeps = {
  l0: createL0(),
  l1,
  l2,
  metrics: new CacheMetrics(),
  hot: new HotSet(),
  now: Date.now,
  methodologyVersion: process.env.METHODOLOGY_VERSION ?? '1.1.0',
  compute: (req) => computeFacts({ ...req, kpis: [...req.kpis] }, ctx),
};

const brew = (action: 'stop' | 'start'): void => {
  execFileSync('brew', ['services', action, 'redis'], { stdio: 'ignore' });
};

const label = (name: string, fact: Awaited<ReturnType<typeof getFact>>): void => {
  out(
    `  ${name.padEnd(20)} cache=${String(fact.cache).padEnd(5)} stale=${String(fact.stale).padEnd(5)} ` +
      `confidence=${String(fact.confidence).padEnd(5)} value=${String(fact.value)}`,
  );
  const note = (fact.notes ?? []).find((n) => n.startsWith('Cache:'));
  if (note !== undefined) out(`    ${note}`);
  if (fact.error !== undefined) out(`    error: ${fact.error.code} — ${fact.error.message}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await migrate();

  out('=== warm the cache, then snapshot it to L2 ===');
  const warm = await getFact(KEY, {}, shared);
  label('warm', warm);
  const snapshot = await new Snapshotter(() => shared).run();
  out(`  L2 rows written: ${snapshot.written} (found ${snapshot.found} of ${snapshot.considered})`);
  out(`  redis: ${l1.status()}`);

  out('');
  out('=== killing Redis (brew services stop redis) ===');
  brew('stop');
  await sleep(3_000);
  out(`  redis: ${l1.status()}`);

  out('');
  out('=== requests during the outage ===');
  label('L0 (warm process)', await getFact(KEY, {}, shared));

  // A process that was not holding this fact in memory when Redis went away.
  const cold: CacheDeps = { ...shared, l0: createL0() };
  label('L2 (cold process)', await getFact(KEY, {}, {
    ...cold,
    compute: async () => {
      throw new Error('upstream also unavailable');
    },
  }));

  // A different KPI, cold in this process, with the upstream gone too: it
  // takes the same labelled L2 path rather than a fabricated number. (With
  // nothing in L2 either, the read path returns a §2 error fact — asserted in
  // test/cache/read-through.test.ts, since it needs an empty L2 to reach.)
  const other: FactKey = { ...KEY, kpi: 'take_rate' };
  label('another KPI, L2', await getFact(other, {}, {
    ...cold,
    compute: async () => {
      throw new Error('upstream also unavailable');
    },
  }));

  out('');
  out('  writes during the outage do not throw either:');
  await writeFacts('tinyman', DEFAULT_PARAMS, [warm as never], cold);
  out('  (written to L0; L1 skipped, logged, no exception)');

  out('');
  out('=== restarting Redis ===');
  brew('start');
  for (let i = 0; i < 60 && l1.status() !== 'ok'; i++) await sleep(500);
  out(`  redis: ${l1.status()}`);
  label('after recovery', await getFact(KEY, {}, { ...shared, l0: createL0() }));
}

try {
  await main();
} finally {
  try {
    brew('start');
  } catch {
    /* already running */
  }
  await l1.close();
  await closeDb();
}
