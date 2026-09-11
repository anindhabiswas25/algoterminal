/**
 * Records the live-data fixtures for the Pact connector
 * (CONNECTOR_GUIDE.md §Step 6).
 *
 *   npx tsx scripts/record-pact-fixtures.ts
 *
 * Writes:
 *
 *   pools-page-{1,2}.json   verbatim pool records from `GET /api/pools`,
 *                           assembled into two pages. The records are
 *                           byte-for-byte what the API returned; only the page
 *                           ENVELOPE (`count`, `limit`, `offset`) is
 *                           synthesised, so the fixture exercises a real
 *                           multi-page walk without carrying all 3,961 pools.
 *   split-pool.json         the ONE synthesised datum in this fixture set. See
 *                           below — it is not a recording and does not pretend
 *                           to be one.
 *
 * The subset is chosen to be REPRESENTATIVE rather than convenient, because a
 * fixture holding only healthy pools lets every `coverage.excluded` branch rot
 * untested while the suite stays green. It carries, deliberately:
 *
 *   - the pools that dominate TVL (where a coverage bug would actually hurt);
 *   - the deprecated `version: 100` pools, including the $298k ALGO/USDC that
 *     is simultaneously the venue's highest-volume pool — §3.6.3's exclusion
 *     has to be visible on something that matters, not only on dust;
 *   - dust below the §3.6.2 $1,000 floor;
 *   - pools whose own record prices a side at `"0.00000000"` (§3.6.1);
 *   - a spread of `fee_bps` values, since the fee split divides by it.
 *
 * ## The page envelope, and why its `limit` is small
 *
 * The recorded pages echo a `limit` far below the 500 the connector asks for.
 * That is not laziness about size: it is the fixture's assertion that the walk
 * strides by the limit the SERVER echoed rather than the one the connector
 * requested. Against the live API those two differ (ask for 1,000, get 500),
 * and a walk that strides by the request silently reads half the catalogue.
 * With a small echoed limit the fixture fails loudly if that regresses.
 *
 * ## `split-pool.json` — the one thing here that is not a recording
 *
 * `pact_fee_bps` is null on all 3,961 live pools, so the branch of §3.4 that
 * runs when Pact DOES publish its cut cannot be recorded from anything. It is
 * also the branch that will start running, without a code change, on the day
 * Pact populates the field — and an untested branch that switches itself on in
 * production is worse than no branch. So one verbatim record is copied and a
 * single field set, the file says so in its own `_synthetic` key, and the test
 * that uses it names it as a what-if rather than as evidence about Pact.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { pino } from 'pino';

import { createHttpClient } from '../src/connectors/http.js';
import { PACT_BASE } from '../src/connectors/pact/enumerate.js';
import { PactPoolSchema, isPriced } from '../src/connectors/pact/schema.js';
import { MIN_TVL_USD } from '../src/standardize/types.js';

const FIXTURES = path.resolve('test/fixtures/pact');
/** Rows per recorded page. Small, >1 page, and NOT the requested limit. */
const PAGE_SIZE = 40;
/** The biggest pools by TVL. */
const TOP_POOLS = 40;
/** A deterministic spread of everything else. */
const SAMPLE_POOLS = 40;

const log = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
const http = createHttpClient({ log });

function write(name: string, value: unknown): void {
  writeFileSync(path.join(FIXTURES, name), `${JSON.stringify(value, null, 2)}\n`);
  log.info({ name }, 'wrote fixture');
}

// ---------------------------------------------------------------------------
// 1. The full live catalogue, walked exactly as the connector walks it
// ---------------------------------------------------------------------------

const first = (await http.getJson(`${PACT_BASE}/pools?limit=500&offset=0`)) as {
  count: number;
  limit: number;
  results: unknown[];
};
const stride = first.limit;
const offsets: number[] = [];
for (let o = stride; o < first.count; o += stride) offsets.push(o);
const rest = await Promise.all(
  offsets.map(async (o) => (await http.getJson(`${PACT_BASE}/pools?limit=500&offset=${o}`)) as { results: unknown[] }),
);
const rows = [first.results, ...rest.map((r) => r.results)].flat();
console.log(`live catalogue: ${rows.length} of ${first.count} pools (server page size ${stride})`);

const parsed = rows.flatMap((row) => {
  const p = PactPoolSchema.safeParse(row);
  return p.success ? [{ raw: row, pool: p.data }] : [];
});
console.log(`parsed: ${parsed.length}`);

// ---------------------------------------------------------------------------
// 2. The deliberate subset
// ---------------------------------------------------------------------------

const byTvl = [...parsed].sort((a, b) => Number(b.pool.tvl_usd) - Number(a.pool.tvl_usd));
const chosen = new Map<number, unknown>();
const take = (label: string, entries: Array<{ raw: unknown; pool: { id: number } }>): void => {
  let added = 0;
  for (const e of entries) {
    if (chosen.has(e.pool.id)) continue;
    chosen.set(e.pool.id, e.raw);
    added++;
  }
  console.log(`  + ${added.toString().padStart(3)} ${label}`);
};

take('top pools by TVL', byTvl.slice(0, TOP_POOLS));
take(
  'deprecated pools (§3.6.3) — including the venue\'s highest-volume pool',
  parsed.filter((e) => e.pool.is_deprecated),
);
take(
  'pools the source itself prices at 0 on a side (§3.6.1)',
  parsed.filter(
    (e) =>
      Number(e.pool.tvl_usd) >= MIN_TVL_USD &&
      (!isPriced(e.pool.primary_asset) || !isPriced(e.pool.secondary_asset)),
  ),
);
// One pool per distinct fee_bps: the split divides by this field, so every
// value it actually takes should appear at least once.
const seenFee = new Set<number>();
take(
  'one pool per distinct fee_bps',
  byTvl.filter((e) => {
    if (seenFee.has(e.pool.fee_bps)) return false;
    seenFee.add(e.pool.fee_bps);
    return true;
  }),
);
// Dust, sampled deterministically across the catalogue rather than from its head.
const dust = parsed.filter((e) => Number(e.pool.tvl_usd) < MIN_TVL_USD);
const step = Math.max(1, Math.floor(dust.length / SAMPLE_POOLS));
take(
  `dust below the $${MIN_TVL_USD} floor (§3.6.2)`,
  dust.filter((_, i) => i % step === 0).slice(0, SAMPLE_POOLS),
);

const subset = [...chosen.values()];
console.log(`\nchosen: ${subset.length} pools`);

// ---------------------------------------------------------------------------
// 3. The pages. Records verbatim; only the envelope is ours.
// ---------------------------------------------------------------------------

// Every page carries exactly PAGE_SIZE rows except the last, which is what the
// live API does and what the connector's stride assumes. A page holding more
// rows than its own echoed `limit` is the shape the connector treats as a lying
// envelope, so the fixture must not accidentally be one.
const pages: unknown[][] = [];
for (let i = 0; i < subset.length; i += PAGE_SIZE) pages.push(subset.slice(i, i + PAGE_SIZE));
const count = subset.length;

pages.forEach((results, i) => {
  write(`pools-page-${i + 1}.json`, { count, limit: PAGE_SIZE, offset: i * PAGE_SIZE, results });
});

// ---------------------------------------------------------------------------
// 4. The synthetic split pool — see the header
// ---------------------------------------------------------------------------

const donor = byTvl.find((e) => e.pool.fee_bps === 30 && !e.pool.is_deprecated);
if (donor === undefined) throw new Error('no 30bps donor pool to base the synthetic record on');
write('split-pool.json', {
  _synthetic: {
    what: 'A verbatim live pool record with ONE field changed: pact_fee_bps, which is null on all 3,961 live pools, is set to 5.',
    why: 'DATA_SCHEMA.md §3.4 defines a protocol_share = pact_fee_bps / fee_bps branch that no live pool can exercise today, and that will begin running with no code change on the day Pact populates the field. This file exists so that branch is tested rather than merely written.',
    not: 'This is NOT evidence about Pact. Nothing in the connector reads it; only the test does, and it is labelled there as a what-if.',
    recorded: new Date().toISOString().slice(0, 10),
  },
  pool: { ...(donor.raw as Record<string, unknown>), pact_fee_bps: 5 },
});

console.log(
  `\npages: ${pages.map((p) => p.length).join(' + ')} rows, envelope count=${count} limit=${PAGE_SIZE}`,
);
const feeBps = [...new Set(subset.map((r) => (r as { fee_bps: number }).fee_bps))].sort((a, b) => a - b);
console.log(`fee_bps values covered: ${feeBps.join(', ')}`);
