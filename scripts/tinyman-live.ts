/**
 * One live end-to-end run of the Tinyman connector, against mainnet.
 *
 *   MAINNET_ALGOD_URL=https://mainnet-api.4160.nodely.dev \
 *   MAINNET_INDEXER_URL=https://mainnet-idx.4160.nodely.dev \
 *   npx tsx --env-file=.env scripts/tinyman-live.ts [--users]
 *
 * Prints the enumeration counts, the eleven facts as a table, and a DefiLlama
 * divergence check. DefiLlama is a *divergence signal only*, never a value
 * source (DATA_SCHEMA.md §3.5) — adopting its methodology would defeat the
 * point of having ours.
 *
 * `--users` adds the §4.1 indexer scan, which is off by default because it
 * moves a few hundred megabytes; see the connector README.
 */
import { pino } from 'pino';

import { createAlgodClient } from '../src/connectors/algod.js';
import { createHttpClient } from '../src/connectors/http.js';
import { createIndexerClient } from '../src/connectors/indexer.js';
import { createPriceService } from '../src/connectors/price/index.js';
import { assetIdsFor, tinymanConnector } from '../src/connectors/tinyman/index.js';
import {
  isActiveUsersEntity,
  isPoolEntity,
  isV2PoolEntity,
  type TinymanEntity,
} from '../src/connectors/tinyman/schema.js';
import type { ConnectorContext } from '../src/connectors/types.js';
import { DEFAULT_BASIS } from '../src/standardize/types.js';

const withUsers = process.argv.includes('--users');
/**
 * `--tvl-only` requests only the KPIs that need no 24h flow, which is what a
 * hot-set refresher on a 60s cycle actually wants: §4 gives TVL a 300s TTL and
 * the flow KPIs a 600s one, and the per-pool flow lookups are the single most
 * expensive thing `fetchRaw` does. Printed side by side with the full refresh
 * so the cost of the flows is a measured number, not an assertion.
 */
const tvlOnly = process.argv.includes('--tvl-only');
const log = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
const http = createHttpClient({ log });
const now = (): Date => new Date();

const ctx: ConnectorContext = {
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

const usd = (n: number): string =>
  `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const capabilities = tinymanConnector.capabilities();
  const started = Date.now();

  process.stdout.write(`health: ${JSON.stringify(await tinymanConnector.healthCheck(ctx))}\n\n`);

  const snapshot = await tinymanConnector.fetchRaw(ctx, {
    basis: DEFAULT_BASIS,
    kpis: tvlOnly
      ? (['tvl', 'pool_count'] as const)
      : withUsers
        ? capabilities.kpis
        : capabilities.kpis.filter((k) => k !== 'active_users_24h'),
  });

  const fetchSeconds = (Date.now() - started) / 1000;

  const entities = snapshot.entities as TinymanEntity[];
  const pools = entities.filter(isPoolEntity);
  const v1 = pools.filter((e) => e.kind === 'v1_pool');
  const v2 = pools.filter(isV2PoolEntity);
  const onchainFees = pools.filter((e) => e.fee.kind === 'v2_onchain');
  const withFlows = v2.filter((e) => e.flows !== null);

  process.stdout.write(
    [
      '=== ENUMERATION (DATA_SCHEMA.md §3.3, methodology_version 1.1.0) ===',
      `V1.1 pools enumerated : ${v1.length}  (analytics API)`,
      `V2   pools enumerated : ${v2.length}${v2.length === 0 ? '   <-- BROKEN: V2 is most of Tinyman' : '  (indexer account walk)'}`,
      `distinct addresses    : ${new Set(pools.map((e) => (e.kind === 'v1_pool' ? e.pool.address : e.address))).size} (must equal ${pools.length})`,
      `V2 fee state read     : ${onchainFees.length} / ${v2.length} on-chain`,
      `V2 24h flows fetched  : ${withFlows.length} / ${v2.length}  (only pools clearing §3.6)`,
      `sources recorded      : ${snapshot.sources.length}`,
      `partial               : ${snapshot.partial}`,
      `dropped at fetch      : ${snapshot.excludedCount}`,
      `fetchRaw took         : ${fetchSeconds.toFixed(1)}s`,
      '',
    ].join('\n'),
  );

  const priceStarted = Date.now();
  const assetIds = assetIdsFor(snapshot);
  const prices = await ctx.prices.resolve(assetIds);
  const priceSeconds = (Date.now() - priceStarted) / 1000;
  process.stdout.write(
    `=== PRICES (§3.7) ===\nassets requested: ${assetIds.length}   priced: ${Object.keys(prices.prices).length}   unpriced (rank 5): ${assetIds.filter((id) => prices.prices[id] === undefined).length}   resolve took: ${priceSeconds.toFixed(1)}s (cached from the fetch scope)\n\n`,
  );

  const facts = tinymanConnector.toFacts(snapshot, {
    basis: DEFAULT_BASIS,
    kpis: capabilities.kpis,
    prices,
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
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');

  process.stdout.write(`=== FACTS (${facts.length}) ===\n`);
  process.stdout.write(`${line(header)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);

  const users = entities.find(isActiveUsersEntity);
  if (users !== undefined) {
    process.stdout.write(
      `\nactive_users scan: ${users.transactions} txns, rounds ${users.observedMinRound}-${users.observedMaxRound}\n`,
    );
  }

  // ---- DefiLlama divergence check (§3.5: a signal, never a source) --------
  const tvl = facts.find((f) => f.metric === 'tvl')?.value ?? 0;
  const grossFees = facts.find((f) => f.metric === 'gross_fees_24h')?.value ?? 0;
  const llama = (await http
    .getJson('https://api.llama.fi/protocol/tinyman')
    .catch(() => null)) as { currentChainTvls?: Record<string, number> } | null;
  const llamaTvl = llama?.currentChainTvls?.['Algorand'] ?? null;

  process.stdout.write('\n=== CROSS-CHECK: api.llama.fi/protocol/tinyman ===\n');
  if (llamaTvl === null) {
    process.stdout.write('DefiLlama unreachable.\n');
  } else {
    const divergence = (tvl - llamaTvl) / llamaTvl;
    process.stdout.write(
      [
        `ours     : ${usd(tvl)}`,
        `DefiLlama: ${usd(llamaTvl)}`,
        `divergence: ${(divergence * 100).toFixed(1)}%  ${Math.abs(divergence) > 0.2 ? '<-- exceeds ~20%, investigate before shipping' : 'within tolerance'}`,
        `our gross_fees_24h: ${usd(grossFees)}`,
        '',
      ].join('\n'),
    );
  }

  process.stdout.write(
    [
      `=== TIMING (${tvlOnly ? 'TVL-only refresh' : 'full refresh'}; target under 60s) ===`,
      `fetchRaw          : ${fetchSeconds.toFixed(1)}s`,
      `price resolve     : ${priceSeconds.toFixed(1)}s`,
      `end-to-end        : ${((Date.now() - started) / 1000).toFixed(1)}s (includes the DefiLlama cross-check)`,
      '',
    ].join('\n'),
  );
}

await main();
