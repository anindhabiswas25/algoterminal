/**
 * AlgoTerminal quickstart — one paid /metric call and one paid /compare call,
 * against the TestNet deployment, settling real TestNet USDC over x402.
 *
 *     npm install
 *     cp .env.example .env     # then paste a funded TestNet mnemonic in
 *     npm start
 *
 * Nothing here is AlgoTerminal-specific except the two URLs at the bottom. The
 * client is stock `@x402/fetch` + `@x402/avm`, so the same twenty lines work
 * against any x402 endpoint on Algorand.
 *
 * Deliberately plain ESM with no build step and no framework: the point of this
 * file is that you can read all of it in two minutes and paste the parts you
 * need into your own agent.
 */
import process from 'node:process';

import algosdk from 'algosdk';
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The TestNet deployment. Free TestNet USDC; nothing here costs real money. */
const BASE = (process.env.ALGOTERMINAL_BASE_URL ?? 'https://api-testnet-production-a3ec.up.railway.app').replace(/\/+$/, '');

/**
 * Algod, for building the payment transaction — NOT for reading AlgoTerminal's
 * data. The data is Algorand MainNet; the payment settles on TestNet. Those are
 * two different chains and this is the one the payment is on.
 */
const ALGOD_URL = process.env.ALGOD_URL ?? 'https://testnet-api.4160.nodely.dev';

const EXPLORER = 'https://testnet.explorer.perawallet.app/tx';

const mnemonic = (process.env.TESTNET_PAYER_MNEMONIC ?? '').trim();
if (mnemonic === '') {
  console.error(
    'TESTNET_PAYER_MNEMONIC is not set.\n\n' +
      'You need a TestNet account holding TestNet USDC (ASA 10458941):\n' +
      '  1. Create an account and fund it with ALGO: https://bank.testnet.algorand.network\n' +
      '  2. Opt it in to ASA 10458941, then get TestNet USDC from\n' +
      '     https://faucet.circle.com (choose Algorand TestNet).\n' +
      '  3. Put its 25-word mnemonic in .env as TESTNET_PAYER_MNEMONIC.\n\n' +
      'This run costs 0.055 TestNet USDC — $0.005 for /metric and $0.05 for /compare.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The x402 client — this is the whole integration
// ---------------------------------------------------------------------------

const account = algosdk.mnemonicToSecretKey(mnemonic);

const client = new x402Client().register(
  // `algorand:*` registers the scheme for both Algorand networks, so the same
  // client works against the MainNet endpoint with no code change: the 402
  // itself names the chain, the asset and the amount, and the client obeys it.
  'algorand:*',
  new ExactAvmScheme(toClientAvmSigner(Buffer.from(account.sk).toString('base64')), {
    algodUrl: ALGOD_URL,
  }),
);

/**
 * A `fetch` that pays. On a 402 it reads the payment requirements, builds and
 * signs the atomic group, and retries the request with a `PAYMENT-SIGNATURE`
 * header — so every call below looks like an ordinary fetch.
 */
const pay = wrapFetchWithPayment(fetch, client);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function heading(title) {
  console.log(`\n${title}\n${'─'.repeat(title.length)}`);
}

/** The settlement receipt the service returns alongside the data. */
function settlement(res) {
  const header = res.headers.get('PAYMENT-RESPONSE');
  if (header === null) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function reportSettlement(res) {
  const receipt = settlement(res);
  if (receipt?.transaction === undefined) {
    console.log('  (no settlement receipt on this response)');
    return;
  }
  console.log(`  paid · txid ${receipt.transaction}`);
  console.log(`  ${EXPLORER}/${receipt.transaction}`);
}

/** One KpiFact, printed the way you would actually want to read it. */
function printFact(fact, indent = '  ') {
  if (fact.error !== undefined && fact.error !== null) {
    console.log(`${indent}${fact.protocol}/${fact.metric}: unavailable — ${fact.error}`);
    return;
  }
  const value =
    fact.unit === 'USD'
      ? `$${Number(fact.value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : String(fact.value);
  console.log(`${indent}${fact.protocol}/${fact.metric} = ${value} ${fact.unit}`);
  console.log(
    `${indent}  confidence ${fact.confidence}` +
      `${fact.is_estimated ? ' (ESTIMATED)' : ''}` +
      ` · ${fact.cache}${fact.stale ? ' STALE' : ''}` +
      ` · as_of ${fact.as_of}` +
      ` · methodology ${fact.methodology_version}`,
  );
  for (const note of fact.notes ?? []) console.log(`${indent}  note: ${note}`);
}

// ---------------------------------------------------------------------------
// 0. Look before you pay — /catalog is free
// ---------------------------------------------------------------------------

heading('0. What is for sale (free — no payment)');

const catalog = await (await fetch(`${BASE}/catalog`)).json();
console.log(`  ${catalog.service}, methodology ${catalog.methodology_version}, ${catalog.network}`);
for (const p of catalog.protocols) {
  console.log(`  ${p.id.padEnd(8)} ${p.class.padEnd(8)} ${p.kpis.length} KPIs`);
  // A declined KPI is a fact about the source, not a gap in coverage — and it
  // is readable here, for free, before you spend anything.
  for (const [kpi, reason] of Object.entries(p.declined ?? {})) {
    console.log(`           declines ${kpi}: ${reason.slice(0, 100)}…`);
  }
}
for (const route of catalog.routes) {
  // `available: false` means this deployment cannot serve the route (today,
  // /ask without an ANTHROPIC_API_KEY). It is still listed with its price, so
  // check the flag rather than assuming a listed route is callable.
  console.log(
    `  ${route.method.padEnd(4)} ${route.path.padEnd(32)} $${route.price_usdc}` +
      `${route.available ? '' : '   (not available on this deployment)'}`,
  );
}

// ---------------------------------------------------------------------------
// 1. The 402, unpaid — what a payment demand actually looks like
// ---------------------------------------------------------------------------

heading('1. The price quote (still free — we just do not pay it)');

const quote = await fetch(`${BASE}/metric/tinyman/tvl`);
console.log(`  HTTP ${quote.status}`);
const requirements = JSON.parse(
  Buffer.from(quote.headers.get('payment-required'), 'base64').toString('utf8'),
);
const accepts = requirements.accepts[0];
console.log(`  ${accepts.amount} atomic units of ASA ${accepts.asset} on ${accepts.network}`);
console.log(`  to ${accepts.payTo}, within ${accepts.maxTimeoutSeconds}s`);
console.log(`  network fee sponsored by ${accepts.extra?.feePayer ?? '(nobody — you pay it)'}`);

// ---------------------------------------------------------------------------
// 2. One paid /metric call
// ---------------------------------------------------------------------------

heading('2. GET /metric/tinyman/tvl — $0.005');

const metricRes = await pay(`${BASE}/metric/tinyman/tvl`);
if (!metricRes.ok) {
  console.error(`  failed: HTTP ${metricRes.status} ${await metricRes.text()}`);
  process.exit(1);
}
const fact = await metricRes.json();
printFact(fact);
// Provenance is per-fetch, so a fact built from 400 pools carries hundreds of
// SourceRefs. Distinct names is what a human wants; the full array is in the
// response if you want to audit it.
const sourceNames = [...new Set(fact.source.map((s) => s.name))];
console.log(`  sources: ${sourceNames.join(', ')} (${fact.source.length} refs)`);
reportSettlement(metricRes);

// ---------------------------------------------------------------------------
// 3. One paid /compare call
// ---------------------------------------------------------------------------

heading('3. GET /compare — capital efficiency across all three — $0.05');

const compareRes = await pay(
  `${BASE}/compare?protocols=tinyman,pact,folks&metric=capital_efficiency`,
);
if (!compareRes.ok) {
  console.error(`  failed: HTTP ${compareRes.status} ${await compareRes.text()}`);
  process.exit(1);
}
const comparison = await compareRes.json();

console.log(`  metric: ${comparison.metric} (${comparison.unit})`);
for (const row of comparison.ranking) {
  console.log(`  #${row.rank} ${row.protocol.padEnd(8)} ${row.value}`);
}
console.log(
  `  spread: ${comparison.spread.min} … ${comparison.spread.max}` +
    `${comparison.spread.ratio === null ? '' : ` (${comparison.spread.ratio}x)`}`,
);
console.log(`  ranking basis: ${comparison.ranking_basis}`);

// The caveats are the part worth reading: they name legs on a different basis,
// legs that are estimates, and legs below the 0.7 confidence line.
console.log(`  comparability: ${comparison.comparability.confidence} (the MINIMUM across legs)`);
for (const caveat of comparison.comparability.caveats ?? []) console.log(`    caveat: ${caveat}`);

heading('  every leg, including any that failed');
for (const leg of comparison.facts) printFact(leg, '  ');

reportSettlement(compareRes);

// ---------------------------------------------------------------------------
// 4. Errors are free — the guarantee worth testing yourself
// ---------------------------------------------------------------------------

heading('4. A KPI Pact declines — 404, and NOT charged');

const declined = await pay(`${BASE}/metric/pact/take_rate`);
const body = await declined.json();
console.log(`  HTTP ${declined.status} ${body.error?.code}`);
console.log(`  ${body.error?.message ?? ''}`);
console.log(
  `  settlement receipt: ${settlement(declined) === null ? 'none — you were not charged' : 'PRESENT (unexpected!)'}`,
);

console.log(`\nDone. Total spent: 0.055 TestNet USDC.`);
console.log(`Payments to ${accepts.payTo} are public: ${EXPLORER.replace('/tx', '/address')}/${accepts.payTo}\n`);
