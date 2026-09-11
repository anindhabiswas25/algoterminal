/**
 * One live end-to-end run of the Pact connector, against the public API.
 *
 *   npx tsx scripts/pact-live.ts
 *
 * Prints the enumeration counts, the ten facts as a table, the §3.4 fee-split
 * disclosure, and a DefiLlama divergence check. DefiLlama is a *divergence
 * signal only*, never a value source (DATA_SCHEMA.md §3.5) — adopting its
 * methodology would defeat the point of having ours.
 *
 * The exclusion breakdown is printed in full because for Pact it is most of the
 * story: 3,961 pools enumerate, fewer than 100 survive §3.6, and the gap
 * between our TVL and DefiLlama's is entirely made of pools we chose to
 * exclude. A cross-check that reports only the percentage would hide that.
 */
import { pino } from 'pino';

import { createHttpClient } from '../src/connectors/http.js';
import { pactConnector } from '../src/connectors/pact/index.js';
import { includePool, valuePool } from '../src/connectors/pact/index.js';
import { isPoolEntity, isPriced } from '../src/connectors/pact/schema.js';
import type { ConnectorContext } from '../src/connectors/types.js';
import { DEFAULT_BASIS, MIN_TVL_USD } from '../src/standardize/types.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
const http = createHttpClient({ log });
const now = (): Date => new Date();

/**
 * Pact needs neither chain access nor the price ladder, so the context is
 * mostly holes. Rather than wire real clients it cannot use, the unused
 * services throw: if this connector ever starts reaching for algod, the indexer
 * or a price, this script fails loudly instead of quietly acquiring a second
 * pricing methodology (CONNECTOR_GUIDE §4.3).
 */
const unusable = (name: string): never => {
  throw new Error(`pact-live: the Pact connector must not use ctx.${name}`);
};
const ctx: ConnectorContext = {
  http,
  algod: new Proxy({} as never, { get: () => () => unusable('algod') }),
  indexer: new Proxy({} as never, { get: () => () => unusable('indexer') }),
  prices: { resolve: async () => unusable('prices') },
  log,
  now,
};

const usd = (n: number): string =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const capabilities = pactConnector.capabilities();
  const started = Date.now();

  process.stdout.write(`health: ${JSON.stringify(await pactConnector.healthCheck(ctx))}\n\n`);

  const fetchStarted = Date.now();
  const snapshot = await pactConnector.fetchRaw(ctx, {
    basis: DEFAULT_BASIS,
    kpis: capabilities.kpis,
  });
  const fetchSeconds = (Date.now() - fetchStarted) / 1000;

  const pools = (snapshot.entities as unknown[]).filter(isPoolEntity);

  // The §3.6 breakdown, recomputed here purely to narrate it. `toFacts` is the
  // authority on the numbers; this is the same filter, said out loud.
  let deprecated = 0;
  let zeroPriced = 0;
  let dust = 0;
  let included = 0;
  let excludedTvl = 0;
  let deprecatedTvl = 0;
  for (const { pool } of pools) {
    const value = valuePool(pool);
    if (value === null) continue;
    if (includePool(pool, value, DEFAULT_BASIS)) {
      included++;
      continue;
    }
    excludedTvl += value.tvl;
    if (pool.is_deprecated) {
      deprecated++;
      deprecatedTvl += value.tvl;
    } else if (!isPriced(pool.primary_asset) || !isPriced(pool.secondary_asset)) zeroPriced++;
    else if (value.tvl < MIN_TVL_USD) dust++;
  }

  process.stdout.write(
    [
      '=== ENUMERATION (DATA_SCHEMA.md §3.4) ===',
      `pools enumerated      : ${pools.length}`,
      `distinct ids          : ${new Set(pools.map((e) => e.pool.id)).size} (must equal ${pools.length})`,
      `sources recorded      : ${snapshot.sources.length} pages`,
      `partial               : ${snapshot.partial}`,
      `dropped at fetch      : ${snapshot.excludedCount}`,
      `fetchRaw took         : ${fetchSeconds.toFixed(1)}s`,
      '',
      '=== §3.6 FILTERS ===',
      `included              : ${included}`,
      `excluded, deprecated  : ${deprecated}  (§3.6.3, holding ${usd(deprecatedTvl)})`,
      `excluded, 0-priced side: ${zeroPriced}  (§3.6.1)`,
      `excluded, under $${MIN_TVL_USD}  : ${dust}  (§3.6.2)`,
      `TVL excluded in total : ${usd(excludedTvl)}`,
      '',
    ].join('\n'),
  );

  const facts = pactConnector.toFacts(snapshot, {
    basis: DEFAULT_BASIS,
    kpis: capabilities.kpis,
    // Pact publishes its own USD figures; nothing here consults the §3.7 ladder.
    prices: { asOf: new Date().toISOString(), prices: {} },
    now: new Date().toISOString(),
    methodologyVersion: process.env.METHODOLOGY_VERSION ?? '1.1.0',
  });

  const header = ['metric', 'value', 'unit', 'conf', 'est', 'coverage'];
  const rows = facts.map((f) => [
    f.metric,
    f.unit === 'USD'
      ? usd(f.value ?? 0)
      : f.unit === 'RATIO'
        ? (f.value ?? 0).toFixed(6)
        : String(f.value),
    String(f.unit),
    String(f.confidence),
    String(f.is_estimated),
    `${f.coverage?.entities} incl / ${f.coverage?.excluded} excl (${f.coverage?.basis})`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');

  process.stdout.write(`=== FACTS (${facts.length}) ===\n`);
  process.stdout.write(`${line(header)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);

  // ---- The §3.4 fee-split disclosure, which is the headline for Pact ------
  const revenue = facts.find((f) => f.metric === 'protocol_revenue_24h');
  const gross = facts.find((f) => f.metric === 'gross_fees_24h')?.value ?? 0;
  const withSplit = pools.filter((e) => e.pool.pact_fee_bps !== null).length;
  process.stdout.write(
    [
      '',
      '=== §3.4 FEE SPLIT ===',
      `pools publishing pact_fee_bps : ${withSplit} / ${pools.length}`,
      `gross_fees_24h                : ${usd(gross)}`,
      `protocol_revenue_24h          : ${usd(revenue?.value ?? 0)}  (is_estimated: ${String(revenue?.is_estimated)})`,
      ...(revenue?.notes ?? []).map((n) => `  note: ${n}`),
      '',
    ].join('\n'),
  );

  // ---- DefiLlama divergence check (§3.5: a signal, never a source) --------
  const tvl = facts.find((f) => f.metric === 'tvl')?.value ?? 0;
  const llama = (await http.getJson('https://api.llama.fi/protocol/pact').catch(() => null)) as {
    currentChainTvls?: Record<string, number>;
  } | null;
  const llamaTvl = llama?.currentChainTvls?.['Algorand'] ?? null;
  const unfiltered = pools.reduce((n, e) => n + (valuePool(e.pool)?.tvl ?? 0), 0);

  process.stdout.write('=== CROSS-CHECK: api.llama.fi/protocol/pact ===\n');
  if (llamaTvl === null) {
    process.stdout.write('DefiLlama unreachable.\n');
  } else {
    const divergence = (tvl - llamaTvl) / llamaTvl;
    const rawDivergence = (unfiltered - llamaTvl) / llamaTvl;
    process.stdout.write(
      [
        `ours, after §3.6      : ${usd(tvl)}`,
        `ours, before §3.6     : ${usd(unfiltered)}   <-- the same source data, unfiltered`,
        `DefiLlama             : ${usd(llamaTvl)}`,
        `divergence (filtered) : ${(divergence * 100).toFixed(1)}%  ${Math.abs(divergence) > 0.2 ? '<-- exceeds ~20%' : 'within tolerance'}`,
        `divergence (raw)      : ${(rawDivergence * 100).toFixed(1)}%  <-- how well we READ the source`,
        '',
        'The two lines answer different questions. The raw divergence says whether',
        'our enumeration is complete; the filtered one says how much §3.6 removes.',
        `Here §3.6 removes ${usd(excludedTvl)}, of which ${usd(deprecatedTvl)} is deprecated pools.`,
        '',
      ].join('\n'),
    );
  }

  process.stdout.write(
    [
      '=== TIMING (target: under the 60s fast-cycle interval) ===',
      `fetchRaw          : ${fetchSeconds.toFixed(1)}s`,
      `end-to-end        : ${((Date.now() - started) / 1000).toFixed(1)}s (includes the DefiLlama cross-check)`,
      '',
    ].join('\n'),
  );
}

await main();
