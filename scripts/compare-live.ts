/**
 * The three flagship `/compare` queries, against live mainnet data.
 *
 *   npx tsx --env-file-if-exists=.env scripts/compare-live.ts
 *
 * This runs the real connectors and the real `composeComparison`, but NOT the
 * cache or the payment gate — it is the shortest path to reading the numbers
 * and the generated caveats. The paid, deployed round trip is
 * `scripts/testnet-smoke.ts`.
 *
 * The caveats are printed verbatim and in full. They are the text an agent
 * quotes to its operator, and DATA_SCHEMA.md §6 uses exactly this comparison as
 * the worked example of the whole methodology, so they are worth reading rather
 * than counting.
 */
import { getConnector, listProtocolIds } from '../src/connectors/registry.js';
import { computeFacts } from '../src/facts/compute.js';
import { composeComparison, type ComparisonLeg } from '../src/standardize/compare.js';
import { getKpi, type KpiId } from '../src/standardize/kpis.js';
import { makeErrorFact } from '../src/standardize/schema.js';
import { DEFAULT_BASIS } from '../src/standardize/types.js';
import { connectorContextForMainnet } from './mainnet-context.js';

const VERSION = process.env.METHODOLOGY_VERSION ?? '1.2.0';

const QUERIES: { protocols: string[]; metric: KpiId; expect: string }[] = [
  {
    protocols: ['tinyman', 'pact', 'folks'],
    metric: 'capital_efficiency',
    expect: 'the flagship case — 200, all three legs, no exclusions',
  },
  {
    protocols: ['tinyman', 'pact', 'folks'],
    metric: 'take_rate',
    expect: 'pact declines -> 200 partial, two legs',
  },
  {
    protocols: ['tinyman', 'pact'],
    metric: 'utilization',
    expect: 'lending-only -> 422 KPI_NOT_APPLICABLE_TO_ANY',
  },
];

function num(value: number, unit: string): string {
  if (unit === 'USD') {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (unit === 'COUNT') return value.toLocaleString('en-US');
  return value.toFixed(6);
}

/** One leg, through the real connector pipeline. Failures become error facts. */
async function fetchLeg(
  protocol: string,
  metric: KpiId,
  ctx: ReturnType<typeof connectorContextForMainnet>,
  timestamp: string,
): Promise<ComparisonLeg> {
  const connector = getConnector(protocol);
  if (connector === undefined) throw new Error(`unknown protocol ${protocol}`);
  const caps = connector.capabilities();

  const error = (code: string, message: string): ComparisonLeg => ({
    protocol,
    protocolClass: caps.class,
    fact: makeErrorFact({
      metric,
      protocol,
      code,
      message,
      methodologyVersion: VERSION,
      timestamp,
    }),
  });

  const declined = caps.declined?.[metric];
  if (declined !== undefined) {
    return error('KPI_NOT_APPLICABLE', `"${protocol}" declines "${metric}": ${declined}`);
  }
  if (!getKpi(metric).applicableClasses.includes(caps.class)) {
    return error('KPI_NOT_APPLICABLE', `"${metric}" is not defined for a ${caps.class} protocol.`);
  }
  if (!caps.kpis.includes(metric)) {
    return error('KPI_NOT_FOUND', `"${protocol}" does not publish "${metric}".`);
  }

  try {
    const facts = await computeFacts(
      { protocol, kpis: [metric], params: { basis: DEFAULT_BASIS } },
      ctx,
    );
    const fact = facts.find((f) => f.metric === metric);
    if (fact === undefined) return error('UPSTREAM_UNAVAILABLE', 'connector produced no fact');
    return { protocol, protocolClass: caps.class, fact };
  } catch (err) {
    return error('UPSTREAM_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  const ctx = connectorContextForMainnet();
  console.log(`\n=== /compare live — methodology ${VERSION} ===`);
  console.log(`registry: ${listProtocolIds().join(', ')}\n`);

  for (const query of QUERIES) {
    const label = `/compare?protocols=${query.protocols.join(',')}&metric=${query.metric}`;
    console.log('='.repeat(100));
    console.log(label);
    console.log(`expect: ${query.expect}`);
    console.log('='.repeat(100));

    const timestamp = new Date().toISOString();
    const t0 = Date.now();
    const legs = await Promise.all(
      query.protocols.map((p) => fetchLeg(p, query.metric, ctx, timestamp)),
    );
    const elapsed = Date.now() - t0;

    const resolved = legs.filter((l) => l.fact.error === undefined);

    if (legs.every((l) => l.fact.error?.code === 'KPI_NOT_APPLICABLE')) {
      console.log(`\n  -> 422 KPI_NOT_APPLICABLE_TO_ANY   (NOT SETTLED)   [${elapsed}ms]`);
      for (const leg of legs) console.log(`     ${leg.protocol}: ${leg.fact.error?.message}`);
      console.log();
      continue;
    }
    if (resolved.length < 2) {
      console.log(`\n  -> 502 INSUFFICIENT_DATA   (NOT SETTLED)   [${elapsed}ms]`);
      for (const leg of legs) {
        if (leg.fact.error) console.log(`     ${leg.protocol}: ${leg.fact.error.message}`);
      }
      console.log();
      continue;
    }

    const out = composeComparison(legs, {
      metric: query.metric,
      methodologyVersion: VERSION,
      timestamp,
    });

    console.log(`\n  -> 200 OK   (SETTLED)   partial=${out.partial}   [${elapsed}ms]`);
    console.log(`  unit=${out.unit}  cache=${out.cache}  stale=${out.stale}`);

    console.log('\n  ranking');
    for (const row of out.ranking) {
      const leg = resolved.find((l) => l.protocol === row.protocol);
      console.log(
        `    ${row.rank}. ${row.protocol.padEnd(9)} ${num(row.value, out.unit).padStart(16)}` +
          `   confidence ${leg?.fact.confidence}   class ${leg?.protocolClass}` +
          `   basis ${leg?.fact.coverage?.basis}`,
      );
    }

    if (out.excluded_protocols.length > 0) {
      console.log(`\n  excluded: ${out.excluded_protocols.join(', ')}`);
      for (const fact of out.facts) {
        if (fact.error) console.log(`    ${fact.protocol}: ${fact.error.code}`);
      }
    }

    console.log(
      `\n  spread  max=${num(out.spread?.max ?? 0, out.unit)}  min=${num(out.spread?.min ?? 0, out.unit)}  ratio=${out.spread?.ratio ?? 'null'}`,
    );
    console.log(`  comparability.confidence = ${out.comparability.confidence}  (MINIMUM across legs)`);

    console.log(`\n  comparability.caveats (${out.comparability.caveats.length}), verbatim:`);
    for (const [i, caveat] of out.comparability.caveats.entries()) {
      console.log(`\n  [${i + 1}] ${caveat}`);
    }
    console.log();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
