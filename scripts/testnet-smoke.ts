/**
 * `npm run testnet:smoke` — the full paid round trip against TestNet
 * (DEPLOYMENT.md §4, check 3).
 *
 * Everything the submission claims about the payment path is asserted here
 * against a live service, a live facilitator and a real chain. Nothing is
 * mocked and nothing is assumed; each step prints what it actually saw, because
 * DEPLOYMENT.md's rule for this runbook is that "a step is done when its check
 * passes, not when the command exits 0".
 *
 * The two checks worth naming:
 *
 *  - **Settle-after-success.** A deliberately failing request
 *    (`/metric/tinyman/nonexistent_kpi`) must return 404 and write NO payments
 *    row. It is the one behaviour worth proving explicitly rather than
 *    assuming, because a bug there is invisible: the caller gets its error, we
 *    get the money, and nothing in the logs looks wrong.
 *  - **The replay guard.** Re-sending a settled `PAYMENT-SIGNATURE` must be a
 *    409. This doubles as an outside-in proof that the settled ledger row
 *    exists, which is why it runs even when the database is not reachable from
 *    here.
 *
 * Configuration:
 *   SMOKE_BASE_URL           the deployed TestNet service (required)
 *   TESTNET_PAYER_MNEMONIC   a funded TestNet account with USDC (required)
 *   SMOKE_DATABASE_URL       optional; a Postgres URL reachable from here.
 *                            When set, payments rows are counted directly
 *                            instead of inferred.
 */
import algosdk from 'algosdk';
import { Pool } from 'pg';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

import { networkConstants } from '../src/config/x402.js';
import { KpiFactSchema } from '../src/standardize/schema.js';
import { priceAtomic } from '../src/pricing.js';

const net = networkConstants('testnet');

const BASE = required('SMOKE_BASE_URL').replace(/\/+$/, '');
const PAYER_MNEMONIC = required('TESTNET_PAYER_MNEMONIC');
const DB_URL = process.env.SMOKE_DATABASE_URL;

const EXPLORER = 'https://testnet.explorer.perawallet.app/tx';
const METRIC_OK = '/metric/tinyman/tvl';
const METRIC_404 = '/metric/tinyman/nonexistent_kpi';
const METRIC_FRESH = '/metric/tinyman/tvl?fresh=true';

/**
 * The sponsor address the facilitator advertises for BOTH Algorand networks
 * (DEPLOYMENT.md §1.1). Asserted as a literal rather than only "is a string":
 * a 402 quoting the wrong fee payer produces a group the facilitator will not
 * sign, and the symptom is a failed payment rather than a failed check.
 * Cross-checked against a live /supported below, so the literal cannot rot
 * silently if the facilitator rotates it.
 */
const EXPECTED_FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';

/**
 * Memoises {@link supportedFeePayer}. Declared here rather than beside that
 * function: `let` is not hoisted, and the checks below run at top level before
 * the helper block is reached, so a declaration down there is in the temporal
 * dead zone when the first call happens.
 */
let cachedFeePayer: string | null | undefined;

/** API_SPEC.md §2.2 — the v2 header the client puts its signed group in. */
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';

/** API_SPEC.md §5's error envelope, as much of it as the assertions read. */
interface ErrorEnvelope {
  error?: { code?: string; message?: string; detail?: Record<string, unknown> };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required. See the header of scripts/testnet-smoke.ts.`);
  }
  return value.trim();
}

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}\n`);
  if (!ok) failures += 1;
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function b64json(header: string | null): Record<string, unknown> {
  if (header === null) throw new Error('missing header');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

// ---------------------------------------------------------------------------
// Ledger access — exact when the database is reachable, inferred when it is not
// ---------------------------------------------------------------------------

const pool = DB_URL === undefined ? null : new Pool({ connectionString: DB_URL, max: 2 });

async function countPayments(): Promise<number | null> {
  if (pool === null) return null;
  const res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM payments');
  return Number(res.rows[0]?.n ?? 0);
}

async function paymentRow(paymentTxid: string) {
  if (pool === null) return null;
  const res = await pool.query('SELECT * FROM payments WHERE payment_txid = $1', [paymentTxid]);
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------

const account = algosdk.mnemonicToSecretKey(PAYER_MNEMONIC);
const payer = String(account.addr);
const algod = new algosdk.Algodv2('', net.algodUrl, '');

process.stdout.write(
  `AlgoTerminal TestNet smoke\n` +
    `  service:     ${BASE}\n` +
    `  network:     ${net.caip2}\n` +
    `  USDC ASA:    ${net.usdcAsaId}\n` +
    `  payer:       ${payer}\n` +
    `  ledger:      ${pool === null ? 'not reachable (replay guard used instead)' : 'direct'}\n`,
);

// ---------------------------------------------------------------------------
section('0. Free routes require no payment (DEPLOYMENT.md §4 check 1)');

for (const path of ['/health', '/catalog', '/llms.txt']) {
  const res = await fetch(`${BASE}${path}`);
  check(`GET ${path}`, res.status === 200, `${res.status}`);
  check(`  no payment demanded`, res.headers.get('PAYMENT-REQUIRED') === null);
}

// ---------------------------------------------------------------------------
section('1. Unpaid request -> 402 (API_SPEC.md §2.1)');

const unpaid = await fetch(`${BASE}${METRIC_OK}`);
check('status is 402', unpaid.status === 402, `${unpaid.status}`);

const requiredHeader = unpaid.headers.get('PAYMENT-REQUIRED');
check('PAYMENT-REQUIRED present', requiredHeader !== null);
check(
  'X-PAYMENT-REQUIRED v1 alias carries the same bytes',
  unpaid.headers.get('X-PAYMENT-REQUIRED') === requiredHeader,
);

const decodedRequired = b64json(requiredHeader) as {
  x402Version: number;
  accepts: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  }[];
  resource?: { tags?: string[] };
  extensions?: Record<string, unknown>;
};
process.stdout.write(`\n  decoded PAYMENT-REQUIRED:\n${indent(decodedRequired)}\n\n`);

const accept = decodedRequired.accepts[0]!;
check('x402Version is 2', decodedRequired.x402Version === 2);
check('scheme is exact', accept.scheme === 'exact');
check('network is the TestNet CAIP-2 id', accept.network === net.caip2, accept.network);
check('asset is USDC TestNet ASA 10458941', accept.asset === String(net.usdcAsaId), accept.asset);
check(
  'amount is 5000 atomic units for the base route',
  accept.amount === String(priceAtomic('/metric/{protocol}/{kpi}', 'base')),
  accept.amount,
);
check('payTo is our TestNet address', /^[A-Z2-7]{58}$/.test(accept.payTo), accept.payTo);
check(
  'extra.feePayer is the facilitator sponsor from DEPLOYMENT.md §1.1',
  accept.extra?.feePayer === EXPECTED_FEE_PAYER,
  String(accept.extra?.feePayer),
);
check(
  '  and that is still what a live /supported advertises for this network',
  (await supportedFeePayer()) === EXPECTED_FEE_PAYER,
  String(await supportedFeePayer()),
);
check('extra.decimals is 6', accept.extra?.decimals === 6);
check(
  'discovery carries the x402-global-challenge tag',
  decodedRequired.resource?.tags?.includes('x402-global-challenge') === true,
);
check('bazaar discovery extension declared', decodedRequired.extensions?.bazaar !== undefined);

const unpaidBody = (await unpaid.json()) as {
  error: string;
  price: { amount_atomic: string; amount_usdc: string };
  resource: string;
  description: string;
  discovery: { tags: string[] };
};
check('body restates the price in plain JSON', unpaidBody.price.amount_usdc === '0.005', JSON.stringify(unpaidBody.price));
check('body names the resource and description', unpaidBody.resource.endsWith(METRIC_OK) && unpaidBody.description.length > 0);
check('body quotes the same amount as the header', unpaidBody.price.amount_atomic === accept.amount);
check('body discovery carries the challenge tag', unpaidBody.discovery.tags.includes('x402-global-challenge'));

// ---------------------------------------------------------------------------
section('2. Build and send the payment (API_SPEC.md §2.2)');

const before = await countPayments();

// The balance the whole round trip is ultimately about. Read from chain
// before anything is sent, so the delta below is measured, not assumed.
const payTo = accept.payTo;
const payToUsdcBefore = await usdcBalance(payTo);
const payerUsdcBefore = await usdcBalance(payer);
process.stdout.write(
  `  payTo ${payTo}\n` +
    `  payTo USDC before: ${payToUsdcBefore} atomic units\n` +
    `  payer USDC before: ${payerUsdcBefore} atomic units\n\n`,
);
check('payTo is opted in to USDC (a non-opted-in payTo cannot be paid)', payToUsdcBefore !== null);
check('payer holds enough USDC for this run', (payerUsdcBefore ?? 0) >= 25_000, `${payerUsdcBefore}`);

const client = new x402Client().register(
  'algorand:*',
  new ExactAvmScheme(
    toClientAvmSigner(Buffer.from(account.sk).toString('base64')),
    { algodUrl: net.algodUrl },
  ),
);

/** The payment header the client built, captured so we can inspect and replay it. */
let sentPaymentHeader: string | null = null;

/**
 * Capture the payment header on its way out.
 *
 * `@x402/fetch` retries the paid request by constructing a `Request` and
 * passing it as the FIRST argument, with no `init` — so reading `init.headers`
 * alone sees nothing and silently reports that no payment was ever built,
 * even on a round trip that succeeded. Both places are checked, `Request`
 * first, because that is the one the library actually uses.
 */
const payingFetch = wrapFetchWithPayment(async (input, init) => {
  const fromRequest =
    input instanceof Request ? input.headers.get(PAYMENT_SIGNATURE_HEADER) : null;
  const fromInit =
    init?.headers === undefined
      ? null
      : new Headers(init.headers as Record<string, string>).get(PAYMENT_SIGNATURE_HEADER);
  const header = fromRequest ?? fromInit;
  if (header !== null) sentPaymentHeader = header;
  return fetch(input, init);
}, client);

const paid = await payingFetch(`${BASE}${METRIC_OK}`);

check('a payment header was built and sent', sentPaymentHeader !== null);

const sent = b64json(sentPaymentHeader) as {
  x402Version: number;
  payload: { paymentGroup: string[]; paymentIndex: number };
};
const group = sent.payload.paymentGroup;
check('atomic group has 2 transactions', group.length === 2, String(group.length));
check('paymentIndex is 1', sent.payload.paymentIndex === 1);

// A signed transaction msgpack has a top-level `sig`/`msig`/`lsig` key; an
// unsigned one is the bare transaction. Decoding each is how we prove the
// fee-payer slot was left for the facilitator rather than signed by us.
const feePayerTxn = algosdk.decodeUnsignedTransaction(Buffer.from(group[0]!, 'base64'));
check(
  'index 0 is the UNSIGNED fee-payer transaction',
  !Buffer.from(group[0]!, 'base64').includes(Buffer.from([0xa3, 0x73, 0x69, 0x67])),
  `sender ${String(feePayerTxn.sender)}`,
);
// The note is `x402-fee-payer-<nonce>`: the scheme appends a uniquifier so two
// payments built in the same round cannot produce identical fee-payer
// transactions. Matched by prefix for that reason — an equality check here
// fails against every real payment the library builds.
const feePayerNote = Buffer.from(feePayerTxn.note ?? []).toString();
check(
  'fee-payer is a 0-amount self-payment with the x402 note',
  String(feePayerTxn.sender) === String(feePayerTxn.payment?.receiver) &&
    Number(feePayerTxn.payment?.amount ?? -1) === 0 &&
    feePayerNote.startsWith('x402-fee-payer'),
  feePayerNote,
);
check(
  'the fee payer is the facilitator sponsor, not us',
  String(feePayerTxn.sender) === EXPECTED_FEE_PAYER,
  String(feePayerTxn.sender),
);
check('fee-payer fee covers the group (>= 2000 uALGO)', Number(feePayerTxn.fee) >= 2000, String(feePayerTxn.fee));

const transferSigned = algosdk.decodeSignedTransaction(new Uint8Array(Buffer.from(group[1]!, 'base64')));
const paymentTxid = transferSigned.txn.txID();
check('index 1 is the SIGNED USDC transfer', transferSigned.sig !== undefined);
check(
  `transfer is ${accept.amount} units of ASA ${net.usdcAsaId} to payTo`,
  String(transferSigned.txn.assetTransfer?.amount) === accept.amount &&
    Number(transferSigned.txn.assetTransfer?.assetIndex) === net.usdcAsaId &&
    String(transferSigned.txn.assetTransfer?.receiver) === accept.payTo,
);
check('sender is the payer, who spent no ALGO on fees', String(transferSigned.txn.sender) === payer);

// ---------------------------------------------------------------------------
section('3. Paid response (API_SPEC.md §2.3)');

check('status is 200', paid.status === 200, `${paid.status}`);
const fact = await paid.json();
const parsed = KpiFactSchema.safeParse(fact);
check('body is a schema-valid KpiFact', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));
process.stdout.write(`\n  KpiFact:\n${indent(fact)}\n\n`);

check('X-AlgoTerminal-Cache header present', paid.headers.get('X-AlgoTerminal-Cache') !== null, String(paid.headers.get('X-AlgoTerminal-Cache')));
check('X-AlgoTerminal-Methodology header present', paid.headers.get('X-AlgoTerminal-Methodology') !== null);
check('settlement did not fail', paid.headers.get('X-AlgoTerminal-Settlement') === null);

const receipt = b64json(paid.headers.get('PAYMENT-RESPONSE')) as {
  success: boolean;
  transaction: string;
  txid?: string;
  network: string;
  payer?: string;
};
process.stdout.write(`  decoded PAYMENT-RESPONSE:\n${indent(receipt)}\n\n`);
check('PAYMENT-RESPONSE says success', receipt.success === true);
check('receipt carries a txid', typeof receipt.transaction === 'string' && receipt.transaction.length > 0);
check('txid alias matches the protocol field', receipt.txid === receipt.transaction);

const settlementTxid = receipt.transaction;
process.stdout.write(`  explorer: ${EXPLORER}/${settlementTxid}\n\n`);

// ---------------------------------------------------------------------------
section('4. The settlement is real, on chain');

const confirmed = await confirmOnChain(settlementTxid);
check('txid is confirmed on TestNet', confirmed !== null, confirmed === null ? 'not found' : `round ${confirmed}`);
check(
  'the payment transaction and the settlement receipt name the same txid',
  settlementTxid === paymentTxid,
  `receipt=${settlementTxid} payment=${paymentTxid}`,
);

// The assertion the entire round trip exists to make: the money arrived, and
// exactly the quoted amount of it. A settle that reports success while moving
// nothing would pass every check above this line.
const payToUsdcAfter = await usdcBalance(payTo);
const delta = (payToUsdcAfter ?? 0) - (payToUsdcBefore ?? 0);
check(
  `payTo USDC increased by exactly ${accept.amount} atomic units`,
  delta === Number(accept.amount),
  `${payToUsdcBefore} -> ${payToUsdcAfter} (delta ${delta})`,
);

const payerUsdcAfterPaid = await usdcBalance(payer);
check(
  `the buyer paid exactly ${accept.amount} atomic units`,
  (payerUsdcBefore ?? 0) - (payerUsdcAfterPaid ?? 0) === Number(accept.amount),
  `${payerUsdcBefore} -> ${payerUsdcAfterPaid}`,
);

// ---------------------------------------------------------------------------
section('5. Exactly one payments row, status settled');

const afterPaid = await countPayments();
if (before !== null && afterPaid !== null) {
  check('exactly one row was written', afterPaid === before + 1, `${before} -> ${afterPaid}`);
  const row = await paymentRow(paymentTxid);
  check('row exists for this payment', row !== null);
  check('row status is settled', row?.status === 'settled', String(row?.status));
  check('row records the settlement txid', row?.txid === settlementTxid);
  check('row records the amount charged', String(row?.amount_atomic) === accept.amount);
  process.stdout.write(`\n  payments row:\n${indent(row)}\n\n`);
}

// The outside-in proof, which runs whether or not the database is reachable:
// the replay guard reads the row we just wrote.
const settledPaymentHeader = sentPaymentHeader;
if (settledPaymentHeader === null) {
  check('replaying the settled payment is a 409', false, 'no payment header was captured');
} else {
  const replay = await fetch(`${BASE}${METRIC_OK}`, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: settledPaymentHeader },
  });
  check('replaying the settled payment is a 409', replay.status === 409, `${replay.status}`);
  const replayBody = (await replay.json()) as ErrorEnvelope;
  check(
    'and it says payment_replayed',
    replayBody.error?.detail?.['error'] === 'payment_replayed',
    String(replayBody.error?.code),
  );
}

// ---------------------------------------------------------------------------
section('6. Settle-after-success: a 404 writes NO payments row');

const beforeFail = await countPayments();
sentPaymentHeader = null;
const failed = await payingFetch(`${BASE}${METRIC_404}`);
const failedPaymentHeader = sentPaymentHeader as string | null;

check('status is 404', failed.status === 404, `${failed.status}`);
check('the request WAS paid for — a payment was built and verified', failedPaymentHeader !== null);

const failedBody = (await failed.json()) as ErrorEnvelope;
process.stdout.write(`\n  404 body:\n${indent(failedBody)}\n\n`);
check('code is KPI_NOT_FOUND', failedBody.error?.code === 'KPI_NOT_FOUND', String(failedBody.error?.code));
check('body lists the KPIs we do publish', Array.isArray(failedBody.error?.detail?.['available_kpis']));
check('no settlement receipt on a failed request', failed.headers.get('PAYMENT-RESPONSE') === null);

const afterFail = await countPayments();
if (beforeFail !== null && afterFail !== null) {
  check('payments row count is unchanged', afterFail === beforeFail, `${beforeFail} -> ${afterFail}`);
}

// The same guarantee read from the chain rather than from our own ledger.
// The buyer built and signed a payment for this request; because the handler
// 404'd, that group was never submitted, so no USDC left the buyer.
const payerUsdcAfterFail = await usdcBalance(payer);
check(
  "the buyer's USDC balance is unchanged — the signed group was never submitted",
  payerUsdcAfterFail === payerUsdcAfterPaid,
  `${payerUsdcAfterPaid} -> ${payerUsdcAfterFail}`,
);

// The proof that holds without database access, and is arguably the better one:
// ask the ledger itself. Re-sending the same payment is a 409 if and only if a
// row exists for it. Step 5 showed a settled payment answering 409; the same
// header against the failed request must answer 404 again, because nothing was
// ever written for it.
if (failedPaymentHeader !== null) {
  const recheck = await fetch(`${BASE}${METRIC_404}`, {
    headers: { [PAYMENT_SIGNATURE_HEADER]: failedPaymentHeader },
  });
  check(
    'the ledger has no row for it — replaying the same payment is 404, not 409',
    recheck.status === 404,
    `${recheck.status}${recheck.status === 409 ? ' (a row WAS written for a failed request)' : ''}`,
  );
}

// ---------------------------------------------------------------------------
section('7. Underpayment is refused by the real facilitator (API_SPEC.md §2.4)');

// The real shape of an underpayment, which is subtler than it first looks.
//
// Building the group against lowered requirements AND declaring those lowered
// requirements gets rejected earlier, by the resource server, as "No matching
// payment requirements" — correct, but it is the route-matching path, not the
// insufficient-funds path, and it never reaches the facilitator.
//
// A client that actually underpays declares the requirements it was QUOTED
// (5000) and sends a group that moves less (1000). So: build the group against
// the lowered amount, then present it under the advertised requirements. Now
// the server matches the route, forwards to /verify, and the facilitator is
// the thing that catches the shortfall — which is what §2.4 specifies and what
// has only ever been mocked until now.
const underpaidAtomic = 1_000;
const underpaidScheme = new ExactAvmScheme(
  toClientAvmSigner(Buffer.from(account.sk).toString('base64')),
  { algodUrl: net.algodUrl },
);
const underpaidResult = await underpaidScheme.createPaymentPayload(
  2,
  { ...accept, amount: String(underpaidAtomic) } as never,
);
const underpaidHeader = Buffer.from(
  JSON.stringify({ x402Version: 2, accepted: accept, payload: underpaidResult.payload }),
).toString('base64');

const underpaid = await fetch(`${BASE}${METRIC_OK}`, {
  headers: { [PAYMENT_SIGNATURE_HEADER]: underpaidHeader },
});
check('status is 402', underpaid.status === 402, `${underpaid.status}`);
const underpaidBody = (await underpaid.json()) as {
  error?: string;
  required?: string;
  provided?: string;
  detail?: Record<string, unknown>;
};
process.stdout.write(`\n  underpaid 402 body:\n${indent(underpaidBody)}\n\n`);
check('error is payment_insufficient', underpaidBody.error === 'payment_insufficient', String(underpaidBody.error));
check(
  `required is the quoted ${accept.amount}`,
  underpaidBody.required === accept.amount,
  String(underpaidBody.required),
);
check(
  `provided is the ${underpaidAtomic} we actually sent`,
  underpaidBody.provided === String(underpaidAtomic),
  String(underpaidBody.provided),
);
check(
  'the facilitator gave its own reason',
  typeof underpaidBody.detail?.['facilitator_reason'] === 'string',
  String(underpaidBody.detail?.['facilitator_reason']),
);

const afterUnderpaid = await countPayments();
if (afterFail !== null && afterUnderpaid !== null) {
  check('a refused payment writes no row', afterUnderpaid === afterFail, `${afterFail} -> ${afterUnderpaid}`);
}

// ---------------------------------------------------------------------------
section('8. ?fresh=true is quoted AND charged at the higher price (API_SPEC.md §1)');

const freshUnpaid = await fetch(`${BASE}${METRIC_FRESH}`);
check('status is 402', freshUnpaid.status === 402, `${freshUnpaid.status}`);
const freshRequired = b64json(freshUnpaid.headers.get('PAYMENT-REQUIRED')) as {
  accepts: { amount: string }[];
};
const freshAccept = freshRequired.accepts[0]!;
const freshPrice = String(priceAtomic('/metric/{protocol}/{kpi}', 'fresh'));
check(
  `quoted amount is ${freshPrice}, not ${accept.amount}`,
  freshAccept.amount === freshPrice,
  freshAccept.amount,
);

const freshPayToBefore = await usdcBalance(payTo);
sentPaymentHeader = null;
const freshPaid = await payingFetch(`${BASE}${METRIC_FRESH}`);
check('status is 200', freshPaid.status === 200, `${freshPaid.status}`);

const freshSent = b64json(sentPaymentHeader) as {
  payload: { paymentGroup: string[]; paymentIndex: number };
};
const freshTransfer = algosdk.decodeSignedTransaction(
  new Uint8Array(Buffer.from(freshSent.payload.paymentGroup[1]!, 'base64')),
);
check(
  `the transfer actually moves ${freshPrice} units — quoted high, charged high`,
  String(freshTransfer.txn.assetTransfer?.amount) === freshPrice,
  String(freshTransfer.txn.assetTransfer?.amount),
);

const freshReceipt = b64json(freshPaid.headers.get('PAYMENT-RESPONSE')) as { transaction: string };
process.stdout.write(`  explorer: ${EXPLORER}/${freshReceipt.transaction}\n`);
check('fresh settlement confirmed on chain', (await confirmOnChain(freshReceipt.transaction)) !== null);

const freshPayToAfter = await usdcBalance(payTo);
check(
  `payTo USDC increased by exactly ${freshPrice}`,
  (freshPayToAfter ?? 0) - (freshPayToBefore ?? 0) === Number(freshPrice),
  `${freshPayToBefore} -> ${freshPayToAfter}`,
);

// ---------------------------------------------------------------------------
section('9. /health reports the facilitator');

const health = (await (await fetch(`${BASE}/health`)).json()) as {
  status: string;
  facilitator: { status: string | null; settle_failures_1h: number | null };
};
process.stdout.write(`  facilitator: ${JSON.stringify(health.facilitator)}\n`);
check('settle failures are counted, not guessed', health.facilitator.settle_failures_1h !== null);

// ---------------------------------------------------------------------------

await pool?.end();

process.stdout.write(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;

// ---------------------------------------------------------------------------

function indent(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * A single account's USDC holding in atomic units, or `null` when the account
 * is not opted in. Null is a distinct answer from 0: an account that has not
 * opted in CANNOT receive the asset (DEPLOYMENT.md §2.3), which is a different
 * failure from one that simply holds nothing.
 */
async function usdcBalance(address: string): Promise<number | null> {
  const info = await algod.accountInformation(address).do();
  const holding = (info.assets ?? []).find((a) => Number(a.assetId) === net.usdcAsaId);
  return holding === undefined ? null : Number(holding.amount);
}

/**
 * The fee payer a live `/supported` advertises for this network.
 *
 * Read from the facilitator rather than trusted from our own 402, so the
 * literal in `EXPECTED_FEE_PAYER` is checked against the only authority on
 * whose address sponsors the fee (DEPLOYMENT.md §1.1).
 */
async function supportedFeePayer(): Promise<string | null> {
  if (cachedFeePayer !== undefined) return cachedFeePayer;
  const url = (process.env.SMOKE_FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz').replace(/\/+$/, '');
  const res = await fetch(`${url}/supported`);
  const body = (await res.json()) as {
    kinds?: { network?: string; scheme?: string; extra?: { feePayer?: string } }[];
  };
  const kind = (body.kinds ?? []).find((k) => k.network === net.caip2 && k.scheme === net.scheme);
  cachedFeePayer = kind?.extra?.feePayer ?? null;
  return cachedFeePayer;
}

/** Poll algod for the transaction. ~3.3s finality, so a few rounds is plenty. */
async function confirmOnChain(txid: string): Promise<number | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const info = await algod.pendingTransactionInformation(txid).do();
      const round = Number(info.confirmedRound ?? 0);
      if (round > 0) return round;
    } catch {
      // Dropped from the pending pool once confirmed and expired; fall through
      // to the indexer-free retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return null;
}
