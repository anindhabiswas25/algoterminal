/**
 * The three flagship `/compare` queries, PAID, against a deployed service.
 *
 *   SMOKE_BASE_URL=https://...            the deployed service (required)
 *   TESTNET_PAYER_MNEMONIC=...            a funded TestNet account with USDC
 *   SMOKE_SSH="railway ssh --service Postgres"
 *                                         optional; the argv prefix that runs a
 *                                         shell command inside the database
 *                                         service. Railway's Postgres has no
 *                                         public endpoint, so the ledger is read
 *                                         through the service rather than over a
 *                                         connection string — which is also the
 *                                         stricter check, since it reads the same
 *                                         database the running service writes to.
 *   SMOKE_PSQL_DSN="-U postgres -d railway"   optional; psql connection flags.
 *
 *   npx tsx --env-file-if-exists=.env scripts/compare-smoke.ts
 *
 * Companion to `scripts/testnet-smoke.ts`, which proves the payment mechanics
 * on `/metric`. This one proves the API_SPEC.md §3.2 **settle boundary** on a
 * live deployment: which of these three answers is worth money.
 *
 *   capital_efficiency over all three   -> 200, no exclusions, SETTLED
 *   take_rate over all three            -> 200 partial (pact declines), SETTLED
 *   utilization over the two DEXes      -> 422, NOT SETTLED
 *
 * The payments table is counted before and after, so "not settled" is a
 * measured fact about the ledger rather than an inference from a status code.
 * Full JSON is printed for every response.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import algosdk from 'algosdk';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';
import { wrapFetchWithPayment } from '@x402/fetch';

import { networkConstants } from '../src/config/x402.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    console.error(`Missing required env var ${name}. See the header of this file.`);
    process.exit(1);
  }
  return value;
}

const BASE = (process.env.SMOKE_BASE_URL ?? '').replace(/\/$/, '') || required('SMOKE_BASE_URL');
const PAYER_MNEMONIC = required('TESTNET_PAYER_MNEMONIC');
const net = networkConstants('testnet');

/**
 * How to run one SQL statement against the DEPLOYED ledger.
 *
 * Railway's Postgres has no public endpoint, so this goes through the service
 * rather than over a connection string — which is also the more honest check:
 * it reads the same database the running service writes to, not a copy.
 */
const SSH = (process.env.SMOKE_SSH ?? '').trim();
const PSQL_DSN = (process.env.SMOKE_PSQL_DSN ?? '-U postgres -d railway').trim();
const exec = promisify(execFile);

interface PaymentRow {
  payment_txid: string;
  route: string;
  amount_atomic: string;
  status: string;
  settled_at: string;
}

/**
 * Run one SQL statement in the database service.
 *
 * The statement is passed as a SINGLE trailing argument, already quoted for the
 * remote shell. `railway ssh` joins its arguments into one command line without
 * re-quoting them, so handing it `-c` and the SQL as separate argv entries
 * gives the remote bash an unquoted `select count(*) ...` and a syntax error on
 * the parenthesis. That failure is quiet in the worst way: it writes to stderr,
 * exits non-zero only sometimes, and an empty stdout parses as "the ledger has
 * no rows" — which would have read as proof that nothing was ever charged.
 *
 * So: no double quotes may appear in `sql` (the statements here use single
 * quotes), and a non-empty stderr is surfaced rather than swallowed.
 */
async function query(sql: string): Promise<string | null> {
  if (SSH.length === 0) return null;
  if (sql.includes('"')) throw new Error('SQL must not contain double quotes; it is shell-quoted');

  const parts = SSH.split(/\s+/);
  const remote = `psql ${PSQL_DSN} -tA -c "${sql}"`;
  const { stdout, stderr } = await exec(parts[0] as string, [...parts.slice(1), remote], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const noise = stderr.replace(/^Using SSH key:.*$/gm, '').trim();
  if (noise.length > 0) throw new Error(`ledger query failed: ${noise}`);
  return stdout;
}

/** Every payments row, oldest first — the evidence for "settled" / "not settled". */
async function paymentRows(): Promise<PaymentRow[] | null> {
  const out = await query(
    "SELECT payment_txid || '|' || route || '|' || amount_atomic || '|' || status || '|' || settled_at " +
      'FROM payments ORDER BY settled_at',
  );
  if (out === null) return null;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [payment_txid, route, amount_atomic, status, settled_at] = line.split('|');
      return {
        payment_txid: payment_txid ?? '',
        route: route ?? '',
        amount_atomic: amount_atomic ?? '',
        status: status ?? '',
        settled_at: settled_at ?? '',
      };
    });
}

function printLedger(label: string, rows: Awaited<ReturnType<typeof paymentRows>>): void {
  console.log(`\n--- payments table ${label} ---`);
  if (rows === null) {
    console.log('  (SMOKE_SSH not set — ledger check skipped)');
    return;
  }
  console.log(`  ${rows.length} row(s)`);
  for (const row of rows.slice(-8)) {
    console.log(
      `    ${row.settled_at} ${row.route.padEnd(26)} ${String(row.amount_atomic).padStart(7)} ${row.status}` +
        `  ${row.payment_txid.slice(0, 12)}…`,
    );
  }
}

const account = algosdk.mnemonicToSecretKey(PAYER_MNEMONIC);
const payer = String(account.addr);
const algod = new algosdk.Algodv2('', net.algodUrl, '');

async function usdcBalance(): Promise<number | null> {
  try {
    const info = (await algod.accountInformation(payer).do()) as unknown as {
      assets?: { 'asset-id'?: number; assetId?: number | bigint; amount: number | bigint }[];
    };
    const row = info.assets?.find(
      (a) => Number(a['asset-id'] ?? a.assetId) === Number(net.usdcAsaId),
    );
    return row === undefined ? 0 : Number(row.amount);
  } catch {
    return null;
  }
}

const client = new x402Client().register(
  'algorand:*',
  new ExactAvmScheme(toClientAvmSigner(Buffer.from(account.sk).toString('base64')), {
    algodUrl: net.algodUrl,
  }),
);
const payingFetch = wrapFetchWithPayment(fetch, client);

interface Outcome {
  label: string;
  path: string;
  expect: string;
  status: number;
  settled: boolean;
  body: unknown;
}

const QUERIES = [
  {
    label: 'capital_efficiency across all three — the flagship',
    path: '/compare?protocols=tinyman,pact,folks&metric=capital_efficiency',
    expect: '200, no exclusions, SETTLED',
  },
  {
    label: 'take_rate across all three — pact declines',
    path: '/compare?protocols=tinyman,pact,folks&metric=take_rate',
    expect: '200 partial, pact excluded, SETTLED',
  },
  {
    label: 'utilization across the two DEXes — applies to neither',
    path: '/compare?protocols=tinyman,pact&metric=utilization',
    expect: '422 KPI_NOT_APPLICABLE_TO_ANY, NOT SETTLED',
  },
];

async function main(): Promise<void> {
  console.log(`\n=== /compare paid smoke — ${BASE} ===`);
  console.log(`payer: ${payer}`);

  const usdcBefore = await usdcBalance();
  const rowsBefore = await paymentRows();
  console.log(`\npayer USDC before: ${usdcBefore} atomic units`);
  printLedger('BEFORE', rowsBefore);

  const outcomes: Outcome[] = [];

  for (const query of QUERIES) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(query.label);
    console.log(`GET ${query.path}`);
    console.log(`expect: ${query.expect}`);
    console.log('='.repeat(100));

    const before = (await paymentRows())?.length ?? null;
    const t0 = Date.now();

    // The client emits the 402, builds the payment and retries. The retry's
    // response is returned whatever its status, so a 422 arrives here as a
    // normal response — which is the case that matters: the caller PAID a
    // valid payment and must still not be charged for it.
    let status: number;
    let body: unknown;
    let settlementHeader: string | null = null;
    try {
      const res = await payingFetch(`${BASE}${query.path}`);
      status = res.status;
      settlementHeader = res.headers.get('PAYMENT-RESPONSE');
      body = await res.json();
    } catch (err) {
      status = -1;
      body = { client_error: err instanceof Error ? err.message : String(err) };
    }

    const elapsed = Date.now() - t0;
    // The ledger needs a moment: settle happens after the response is written.
    await new Promise((r) => setTimeout(r, 3_000));
    const after = (await paymentRows())?.length ?? null;
    const settled = before !== null && after !== null && after > before;

    console.log(
      `\nHTTP ${status}   [${elapsed}ms]   new payments rows: ${
        before === null ? 'unknown' : (after as number) - before
      }   PAYMENT-RESPONSE: ${settlementHeader === null ? 'absent' : 'present'}`,
    );
    console.log('\nfull JSON:');
    console.log(JSON.stringify(body, null, 2));

    outcomes.push({ label: query.label, path: query.path, expect: query.expect, status, settled, body });
  }

  const usdcAfter = await usdcBalance();
  const rowsAfter = await paymentRows();
  printLedger('AFTER', rowsAfter);

  console.log(`\npayer USDC: ${usdcBefore} -> ${usdcAfter} atomic units`);
  if (usdcBefore !== null && usdcAfter !== null) {
    console.log(`spent: ${usdcBefore - usdcAfter} atomic units`);
  }
  if (rowsBefore !== null && rowsAfter !== null) {
    console.log(`new payments rows: ${rowsAfter.length - rowsBefore.length}`);
  }

  console.log('\n=== summary ===');
  for (const o of outcomes) {
    console.log(`  ${String(o.status).padEnd(4)} settled=${String(o.settled).padEnd(5)} ${o.label}`);
  }

}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
