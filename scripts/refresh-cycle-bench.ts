/**
 * Measures one real fast cycle of the refresher, against live upstreams.
 *
 *   MAINNET_ALGOD_URL=... MAINNET_INDEXER_URL=... npx tsx scripts/refresh-cycle-bench.ts
 *
 * The number that matters: the fast cycle must finish inside its own 60s
 * interval (`FAST_INTERVAL_SECONDS`). A cycle that overruns its period does not
 * fail loudly — the refresher skips the overlapping run — it just quietly
 * refreshes half as often as the logs claim.
 *
 * Registering a connector is supposed to cost one line in `registry.ts` and
 * nothing else; the hot set is built from `listConnectors()`, so this script
 * also prints the groups the cycle discovered, which is the evidence for that
 * claim rather than an assertion of it.
 */
import { HotSet } from '../src/cache/hotset.js';
import { fullMatrix } from '../src/cache/hotset.js';
import { createL0 } from '../src/cache/lru.js';
import { CacheMetrics } from '../src/cache/metrics.js';
import { fakeL1, fakeL2 } from '../src/cache/testing.js';
import { kpisForCycle } from '../src/cache/cycles.js';
import type { CacheDeps } from '../src/cache/index.js';
import { listProtocolIds } from '../src/connectors/registry.js';
import { computeFacts } from '../src/facts/compute.js';
import { Refresher } from '../src/jobs/refresher.js';
import { connectorContextForMainnet } from './mainnet-context.js';

const VERSION = process.env.METHODOLOGY_VERSION ?? '1.2.0';
const perGroup: Array<{ protocol: string; seconds: number }> = [];
const ctx = connectorContextForMainnet();

/**
 * In-memory tiers. The point of measurement is the UPSTREAM cost of a cycle,
 * which is what has to fit in 60s; Redis and Postgres write latency is measured
 * separately by `cache:bench` and would only blur this number.
 */
const deps: CacheDeps = {
  l0: createL0(),
  l1: fakeL1(),
  l2: fakeL2(),
  metrics: new CacheMetrics(),
  hot: new HotSet(),
  now: Date.now,
  methodologyVersion: VERSION,
  async compute(req) {
    // Groups run sequentially inside the cycle (a burst of concurrent requests
    // at one host is what earns a 429), so the cycle's cost is the SUM of these
    // and each connector's share is worth seeing on its own.
    const started = Date.now();
    const facts = await computeFacts(req, ctx);
    perGroup.push({ protocol: req.protocol, seconds: (Date.now() - started) / 1000 });
    return facts;
  },
};

process.stdout.write(`registered protocols: ${listProtocolIds().join(', ')}\n`);
process.stdout.write(`fast-cycle KPIs     : ${kpisForCycle('fast').join(', ')}\n`);
process.stdout.write(`hot-set matrix      : ${fullMatrix().length} keys\n\n`);

const refresher = new Refresher(() => deps);
/**
 * Two consecutive fast cycles. The first is a COLD process — nothing is cached,
 * including the §3.7 price ladder, whose 60s entries the second run inherits.
 * A long-running refresher lives in the second state, not the first, so both
 * numbers are reported: the cold one bounds a restart, the warm one is the
 * steady state that has to fit inside the interval.
 */
for (const cycle of ['fast', 'fast'] as const) {
  perGroup.length = 0;
  const started = Date.now();
  const result = await refresher.runCycle(cycle);
  process.stdout.write(
    [
      `=== ${cycle.toUpperCase()} CYCLE ===`,
      `groups ok     : ${result.ok}`,
      `groups failed : ${result.failed}`,
      `facts written : ${result.factsWritten}`,
      `duration      : ${(result.durationMs / 1000).toFixed(1)}s  (wall ${((Date.now() - started) / 1000).toFixed(1)}s)`,
      `interval      : 60s  -> ${result.durationMs < 60_000 ? 'FITS' : 'OVERRUNS'}`,
      ...perGroup.map((g) => `  ${g.protocol.padEnd(12)}: ${g.seconds.toFixed(1)}s`),
      '',
    ].join('\n'),
  );
}
