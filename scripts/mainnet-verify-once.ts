/**
 * `npm run mainnet:verify` — the ONE permitted self-originated MainNet payment
 * (DEPLOYMENT.md §5.1, PRD.md §7.1).
 *
 * One call, `GET /metric/tinyman/tvl`, 0.005 USDC. It confirms USDC receipt end
 * to end and triggers Bazaar cataloging, and it is the only payment this
 * project will ever originate on MainNet.
 *
 * ## Why the guardrail is structural
 *
 * §5.1: "The script must be built to hard-refuse a second run... Not because a
 * second call would be catastrophic in itself, but because 'just one more test
 * on mainnet' is exactly how an entry drifts into the pattern the rules
 * disqualify. Make the guardrail structural, not a note in a doc."
 *
 * So there are THREE independent refusals, and any one of them stops the run:
 *
 *  1. **The marker file** (`mainnet-verification.json`, committed). The record
 *     this script writes on success. Cheap, local, and the one a human sees.
 *  2. **On-chain history.** The indexer is asked whether `payer` has EVER sent
 *     USDC to `payTo`. This is the guard that cannot be defeated by deleting a
 *     file or cloning the repo fresh, because it reads the same public ledger
 *     the rules are judged against. It is also why this check is not optional:
 *     it is the only one that is true independently of this machine.
 *  3. **The payments ledger**, when a `MAINNET_DATABASE_URL` is reachable. The
 *     service's own view. Skipped with a warning when unset, because Railway's
 *     Postgres is not reachable from a laptop without a proxy — a guard that
 *     cannot run must say so rather than silently pass.
 *
 * Guard 2 makes guard 1 belt-and-braces rather than load-bearing, which is the
 * right shape: the authoritative record of "did we already do this" is the
 * chain, not a file we control.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import algosdk from 'algosdk';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

// Same placeholder-then-import dance as scripts/mainnet-accounts.ts: importing
// the constants pulls in the server's env validator, and this script is not the
// server. Every value used below is passed explicitly from networkConstants.
const PLACEHOLDER_ENV: Readonly<Record<string, string>> = {
  X402_NETWORK: 'mainnet',
  X402_PAYTO: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
  X402_FACILITATOR_URL: 'https://facilitator.goplausible.xyz',
  ALGOD_URL: 'https://mainnet-api.4160.nodely.dev',
  INDEXER_URL: 'https://mainnet-idx.4160.nodely.dev',
  REDIS_URL: 'redis://localhost:6379',
  DATABASE_URL: 'postgres://localhost:5432/algoterminal',
  METHODOLOGY_VERSION: '0.0.0',
  PUBLIC_BASE_URL: 'http://localhost:3000',
};
for (const [k, v] of Object.entries(PLACEHOLDER_ENV)) {
  if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
}

const { networkConstants } = await import('../src/config/x402.js');
const { priceAtomic } = await import('../src/pricing.js');

const net = networkConstants('mainnet');
const algod = new algosdk.Algodv2('', net.algodUrl, '');

const BASE = (process.env.MAINNET_BASE_URL ?? 'https://api-production-36692.up.railway.app').replace(
  /\/+$/,
  '',
);
const ROUTE = '/metric/tinyman/tvl';
const MARKER = new URL('../mainnet-verification.json', import.meta.url).pathname;
const KEYFILE = process.env.MAINNET_KEYFILE ?? join(homedir(), '.algoterminal', 'mainnet-keys.json');
const EXPECTED_FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
/** The price key in `src/pricing.ts`, so this can never drift from what is charged. */
const EXPECTED_ATOMIC = priceAtomic('/metric/{protocol}/{kpi}');

function refuse(why: string, detail: string): never {
  process.stderr.write(`\nREFUSING to run: ${why}\n\n${detail}\n`);
  process.exit(1);
}

const keys = JSON.parse(readFileSync(KEYFILE, 'utf8')) as Record<
  'payTo' | 'payer',
  { address: string; mnemonic: string }
>;
const payer = algosdk.mnemonicToSecretKey(keys.payer.mnemonic);
const payerAddr = String(payer.addr);
const payToAddr = keys.payTo.address;

process.stdout.write(
  `MainNet verification payment (DEPLOYMENT.md §5.1)\n` +
    `  base   : ${BASE}\n  route  : ${ROUTE}\n` +
    `  amount : ${EXPECTED_ATOMIC} atomic (${(EXPECTED_ATOMIC / 1e6).toFixed(6)} USDC)\n` +
    `  payer  : ${payerAddr}\n  payTo  : ${payToAddr}\n\n`,
);

// ---- Guard 1: the marker file -------------------------------------------
if (existsSync(MARKER)) {
  refuse(
    'the marker file already exists',
    `${MARKER}\n\nThis payment has already been made. It is the ONLY self-originated\n` +
      'MainNet payment this project makes (PRD.md §7.1).',
  );
}

// ---- Guard 2: on-chain history (authoritative) ---------------------------
process.stdout.write('checking the chain for a prior payment...\n');
/**
 * Ask the indexer for the payer's USDC transfers and match in code.
 *
 * The obvious query — `/accounts/{payer}/transactions?address={payTo}
 * &address-role=receiver` — does NOT mean "transfers from payer to payTo". It
 * returned two matches here on a pair of accounts that had never transacted
 * with each other: an unrelated third-party `appl` call, and the payer's own
 * zero-amount USDC OPT-IN. Both would have tripped the guard and permanently
 * blocked the one payment this script exists to make.
 *
 * So the filter that matters is applied locally and is explicit about all three
 * conditions a real payment satisfies: it is an `axfer` of the USDC ASA, its
 * receiver is payTo, and its amount is greater than zero. The last clause is
 * what excludes the opt-in, which is an `axfer` of exactly this asset and is
 * guaranteed to exist before this script can ever run.
 */
interface IndexerTxn {
  readonly id?: string;
  readonly 'tx-type'?: string;
  readonly sender?: string;
  readonly 'asset-transfer-transaction'?: { receiver?: string; amount?: number };
}

const priorPayments: IndexerTxn[] = [];
let next: string | undefined;
do {
  const url =
    `${net.indexerUrl}/v2/accounts/${payerAddr}/transactions` +
    `?asset-id=${net.usdcAsaId}&tx-type=axfer&limit=1000` +
    (next === undefined ? '' : `&next=${encodeURIComponent(next)}`);
  const res = await fetch(url);
  if (!res.ok) {
    refuse(
      'the indexer could not be queried',
      `${url} -> ${res.status}\n\nThis guard is not optional: it is the only check that is\n` +
        'true independently of this machine. Fix indexer access and re-run.',
    );
  }
  const page = (await res.json()) as { transactions?: IndexerTxn[]; 'next-token'?: string };
  for (const t of page.transactions ?? []) {
    const xfer = t['asset-transfer-transaction'];
    if (
      t['tx-type'] === 'axfer' &&
      xfer?.receiver === payToAddr &&
      Number(xfer?.amount ?? 0) > 0
    ) {
      priorPayments.push(t);
    }
  }
  next = page['next-token'];
} while (next !== undefined);

if (priorPayments.length > 0) {
  refuse(
    'the chain already shows a USDC payment from payer to payTo',
    priorPayments.map((t) => `  ${t.id}`).join('\n') +
      '\n\nThe permitted payment has already been made (PRD.md §7.1).',
  );
}
process.stdout.write('  no prior payment on chain\n');

// ---- Guard 3: the payments ledger, when reachable ------------------------
const dbUrl = process.env.MAINNET_DATABASE_URL;
if (dbUrl === undefined || dbUrl === '') {
  process.stdout.write(
    '  WARNING: MAINNET_DATABASE_URL unset — the payments-ledger guard did NOT run.\n' +
      '           Guards 1 and 2 did. Set it to check the service\'s own view too.\n',
  );
} else {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payments WHERE network = 'mainnet' AND payer = $1",
      [payerAddr],
    );
    if (Number(rows[0]?.n ?? 0) > 0) {
      refuse('the payments ledger already has a mainnet row for this payer', `rows: ${rows[0]?.n}`);
    }
    process.stdout.write('  payments ledger clean\n');
  } finally {
    await pool.end();
  }
}

// ---- Pre-flight on the two accounts -------------------------------------
const payToInfo = await algod.accountInformation(payToAddr).do();
const payToOptedIn = (payToInfo.assets ?? []).some((a) => Number(a.assetId) === net.usdcAsaId);
if (!payToOptedIn) refuse('payTo is not opted in to USDC', `${payToAddr} cannot receive the asset.`);

const payerInfo = await algod.accountInformation(payerAddr).do();
const payerUsdc = Number(
  (payerInfo.assets ?? []).find((a) => Number(a.assetId) === net.usdcAsaId)?.amount ?? 0,
);
if (payerUsdc < EXPECTED_ATOMIC) {
  refuse('payer does not hold enough USDC', `has ${payerUsdc}, needs ${EXPECTED_ATOMIC} atomic.`);
}
process.stdout.write(`  payTo opted in, payer holds ${payerUsdc} atomic USDC\n\n`);

if (process.argv.includes('--dry-run')) {
  process.stdout.write(
    'DRY RUN: every guard and pre-flight check passed and NOTHING was paid.\n' +
      'Re-run without --dry-run to make the one permitted payment.\n',
  );
  process.exit(0);
}

// ---- The payment ---------------------------------------------------------
const client = new x402Client().register(
  'algorand:*',
  new ExactAvmScheme(toClientAvmSigner(Buffer.from(payer.sk).toString('base64')), {
    algodUrl: net.algodUrl,
  }),
);

let sentHeader: string | null = null;
const payingFetch = wrapFetchWithPayment(async (input, init) => {
  const fromRequest = input instanceof Request ? input.headers.get(PAYMENT_SIGNATURE_HEADER) : null;
  const fromInit =
    init?.headers === undefined
      ? null
      : new Headers(init.headers as Record<string, string>).get(PAYMENT_SIGNATURE_HEADER);
  sentHeader = fromRequest ?? fromInit ?? sentHeader;
  return fetch(input, init);
}, client);

process.stdout.write(`paying ${BASE}${ROUTE} ...\n`);
const res = await payingFetch(`${BASE}${ROUTE}`);
const body = (await res.json()) as Record<string, unknown>;

if (!res.ok) {
  process.stderr.write(`\nFAILED: ${res.status}\n${JSON.stringify(body, null, 2)}\n`);
  process.exit(1);
}

// The settlement txid comes back on `PAYMENT-RESPONSE`, which is the header
// `createSettlementHeaders` emits in @x402/core (server/index). It is NOT
// `PAYMENT-RECEIPT`: guessing that name is why the first real run recorded a
// txid of "unknown" against a settlement that had in fact succeeded on chain.
const receipt = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('payment-response');
let txid = 'unknown';
if (receipt !== null) {
  try {
    txid = (JSON.parse(Buffer.from(receipt, 'base64').toString()) as { transaction?: string })
      .transaction ?? 'unknown';
  } catch {
    /* receipt shape is the facilitator's; an unparsed one is not fatal here */
  }
}

process.stdout.write(
  `\nPAID. HTTP ${res.status}\n` +
    `  protocol : ${String(body.protocol)}\n  metric   : ${String(body.metric)}\n` +
    `  value    : ${String(body.value)}\n  confidence: ${String(body.confidence)}\n` +
    `  txid     : ${txid}\n  explorer : https://explorer.perawallet.app/tx/${txid}\n` +
    `  feePayer : expected ${EXPECTED_FEE_PAYER}\n`,
);

const record = {
  date: new Date().toISOString(),
  route: `GET ${ROUTE}`,
  amount_usdc: (EXPECTED_ATOMIC / 1e6).toFixed(6),
  amount_atomic: EXPECTED_ATOMIC,
  asa: net.usdcAsaId,
  payer: payerAddr,
  payTo: payToAddr,
  txid,
  base_url: BASE,
  purpose: 'submission requirement — confirm USDC receipt and trigger Bazaar cataloging',
  note: 'This is the ONLY self-originated mainnet payment for this project.',
};
writeFileSync(MARKER, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`\nmarker written: ${MARKER}\nCommit it, and paste this into docs/LAUNCH_LOG.md.\n`);
