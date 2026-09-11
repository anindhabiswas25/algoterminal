/**
 * The four `/ask` questions from the build brief, PAID, against a deployed
 * service.
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
 *   npx tsx --env-file-if-exists=.env scripts/ask-smoke.ts
 *
 * Companion to `testnet-smoke.ts` (payment mechanics on /metric) and
 * `compare-smoke.ts` (the partial-settle boundary). This one proves the
 * API_SPEC.md §3.3 contract on a live deployment, and the question it answers
 * is not "did it return prose" — it is:
 *
 *   1. Are the three answerable questions grounded? Every number in each
 *      answer is checked against the `facts[]` the same response carries,
 *      using the SAME rule the service enforces internally
 *      (`src/ask/grounding.ts`), re-run here against the wire response. A
 *      service that shipped an ungrounded number would fail here even if its
 *      own check had been bypassed.
 *   2. Does the take-rate question handle Pact's decline, or silently omit it?
 *   3. Does the forecast question 422 OUT_OF_SCOPE — and is it genuinely NOT
 *      charged, measured against the payments table and the payer's USDC
 *      balance rather than inferred from a status code?
 *
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
import {
  buildGroundingPayload,
  groundingViolations,
  lowConfidenceViolations,
  silentOmissionViolations,
  toGroundedFact,
  type GroundedFact,
} from '../src/ask/grounding.js';
import { isSuccessFact, type KpiFact } from '../src/standardize/schema.js';
import type { Plan } from '../src/ask/schema.js';

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
  question: string;
  expect: string;
  status: number;
  settled: boolean;
  grounded: boolean | null;
  body: unknown;
}

const QUESTIONS = [
  {
    label: 'the flagship ratio, asked in words',
    question: 'Which Algorand DeFi protocol generates the most fee revenue per dollar of TVL?',
    expect: '200, grounded, SETTLED at 150000',
  },
  {
    label: 'a two-way comparison with a "why"',
    question: 'Is Tinyman or Folks capturing more protocol revenue, and why?',
    expect: '200, grounded, SETTLED at 150000',
  },
  {
    label: "a KPI Pact declines — must say so, not omit it",
    question: 'Which protocol has the highest take rate?',
    expect: '200, names Pact\'s decline, SETTLED at 150000',
  },
  {
    label: 'a forecast — descriptive-only policy',
    question: 'Will ALGO go up next week?',
    expect: '422 OUT_OF_SCOPE, NOT SETTLED',
  },
];

/**
 * Re-run the service's own grounding rule against the response it returned.
 *
 * Deliberately not a weaker check than the internal one: it imports the same
 * functions. The point is *where* it runs — on the wire response, from outside
 * the process — so it would catch an ungrounded number that reached a caller
 * for any reason at all, including the checks having been disabled.
 *
 * It can only be run on a 200, and only using `facts[]` as returned. The
 * `unavailable` list is not on the wire (it is an internal detail of the
 * synthesis payload), so the silent-omission check is reconstructed from the
 * question's own expectations rather than from the response.
 */
function checkGrounding(
  body: Record<string, unknown>,
  declinedProtocols: { protocol: string; protocol_name: string; metric: string; reason: string }[],
): { ok: boolean; violations: string[] } {
  const facts = (body.facts as KpiFact[]).filter(isSuccessFact);
  const grounded: GroundedFact[] = facts.map((fact, index) =>
    toGroundedFact(fact, index, fact.protocol, 'dex'),
  );
  const payload = buildGroundingPayload({
    question: String(body.question),
    plan: body.plan as Plan,
    facts: grounded,
    unavailable: declinedProtocols.map((d) => ({ ...d, declined: true })),
  });

  const answer = String(body.answer ?? '');
  const violations = [
    ...groundingViolations(answer, payload),
    ...lowConfidenceViolations(answer, payload),
    ...silentOmissionViolations(answer, payload),
  ];
  return { ok: violations.length === 0, violations: violations.map((v) => `${v.kind}: ${v.detail}`) };
}

/**
 * What we expect to be declined, per question, so the omission check has
 * something to check against. Only the take-rate question has one: Pact
 * publishes no fee split (DATA_SCHEMA.md §3.4).
 */
const DECLINES: Record<string, { protocol: string; protocol_name: string; metric: string; reason: string }[]> = {
  'Which protocol has the highest take rate?': [
    {
      protocol: 'pact',
      protocol_name: 'Pact',
      metric: 'take_rate',
      reason: 'Pact does not publish its fee split.',
    },
  ],
};

async function main(): Promise<void> {
  console.log(`\n=== /ask paid smoke — ${BASE} ===`);
  console.log(`payer: ${payer}`);

  const usdcBefore = await usdcBalance();
  const rowsBefore = await paymentRows();
  console.log(`\npayer USDC before: ${usdcBefore} atomic units`);
  printLedger('BEFORE', rowsBefore);

  const outcomes: Outcome[] = [];

  for (const query of QUESTIONS) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(query.label);
    console.log(`POST /ask  ${JSON.stringify({ question: query.question })}`);
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
      const res = await payingFetch(`${BASE}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: query.question }),
      });
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

    let grounded: boolean | null = null;
    if (status === 200) {
      const check = checkGrounding(body as Record<string, unknown>, DECLINES[query.question] ?? []);
      grounded = check.ok;
      console.log(`\ngrounding re-check (run here, on the wire response): ${check.ok ? 'PASS' : 'FAIL'}`);
      for (const violation of check.violations) console.log(`  - ${violation}`);
      console.log('\nthe prose, on its own:');
      console.log(`  ${String((body as Record<string, unknown>).answer)}`);
    }

    outcomes.push({
      label: query.label,
      question: query.question,
      expect: query.expect,
      status,
      settled,
      grounded,
      body,
    });
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
    console.log(
      `  ${String(o.status).padEnd(4)} settled=${String(o.settled).padEnd(5)} ` +
        `grounded=${String(o.grounded).padEnd(5)} ${o.label}`,
    );
  }

  // The two claims this script exists to measure, stated as pass/fail rather
  // than left for a reader to derive from the tables above.
  const paid = outcomes.filter((o) => o.status === 200);
  const refused = outcomes.filter((o) => o.status === 422);
  const expectedSpend = paid.length * 150_000;
  console.log(
    `\n  answered: ${paid.length}, all grounded: ${paid.every((o) => o.grounded === true)}`,
  );
  console.log(`  refused (422, must be unsettled): ${refused.length}, settled: ${refused.filter((o) => o.settled).length}`);
  if (usdcBefore !== null && usdcAfter !== null) {
    const spent = usdcBefore - usdcAfter;
    console.log(`  USDC spent: ${spent} atomic; expected ${expectedSpend} (${paid.length} x 150000)`);
    console.log(`  MATCH: ${spent === expectedSpend}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
