/**
 * `npm run mainnet:accounts` — generate and prepare the MainNet accounts
 * DEPLOYMENT.md §2 requires, and report exactly what is still missing.
 *
 * The TestNet twin of this script (`scripts/testnet-accounts.ts`) reads its
 * mnemonics from the environment, because a TestNet key is worth nothing and
 * regenerating one costs a dispenser call. A MainNet key is different in kind:
 * lose it and the funds are gone, leak it and they are stolen, regenerate it
 * after funding and the money is stranded at an address nobody can sign for.
 * So this script OWNS the keys instead of being handed them:
 *
 *  - It generates them once, into a keyfile OUTSIDE the repository
 *    (`~/.algoterminal/mainnet-keys.json` by default, `0600`, in a `0700` dir).
 *  - It REFUSES to overwrite that file. A second `--generate` against an
 *    existing keyfile is the exact mistake that orphans a funded account, so it
 *    is an error, not a prompt.
 *  - It never prints a mnemonic. Addresses go to stdout — which lands in
 *    terminal scrollback, CI logs and pasted screenshots — and the secrets stay
 *    in a file you read deliberately.
 *
 * Two accounts, with different jobs (§2):
 *
 *  - **payTo** receives every payment and is the identity on the leaderboard.
 *    It needs ALGO for its minimum balance and the USDC opt-in, and NO USDC of
 *    its own. It must be opted in to USDC BEFORE the endpoint is reachable: an
 *    account that has not opted in cannot receive the asset, and every payment
 *    to it fails.
 *  - **payer** signs the one permitted MainNet verification payment (§5.1). It
 *    needs ALGO for its own minimum balance and opt-in, plus at least 0.005
 *    USDC to spend. It does NOT need ALGO for the payment's fee: the
 *    facilitator sponsors that, which is the property the round trip proves.
 *
 * Idempotent. Run it, fund whatever it says is unfunded, run it again. The
 * opt-in is sent automatically once an account has the ALGO to afford it.
 *
 *   npm run mainnet:accounts -- --generate    # once, before any funding
 *   npm run mainnet:accounts                  # status + opt-in when funded
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import algosdk from 'algosdk';

/**
 * `src/config/x402.ts` is the ONLY place the CAIP-2 ids, ASA ids and algod URLs
 * are typed by hand, so this script imports them from there rather than
 * retyping two constants that must never drift. The cost of that import is that
 * it pulls in `src/config/env.ts`, which validates the FULL server environment
 * at module load and exits if anything is missing.
 *
 * That is the right behaviour for the server and the wrong behaviour here, for
 * a reason specific to this script: one of the variables it demands is
 * `X402_PAYTO`, and generating `X402_PAYTO` is precisely what this script
 * exists to do. A fresh clone could never run it.
 *
 * So we fill in placeholders for the variables this script does not read,
 * before the import that triggers validation. Nothing downstream consumes them:
 * every network value below comes from `networkConstants('mainnet')`, passed
 * explicitly, never from `activeNetwork()` or from the environment. A real
 * value already present in the environment is left untouched.
 */
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
for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
  if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
}

const { networkConstants } = await import('../src/config/x402.js');

const net = networkConstants('mainnet');
const algod = new algosdk.Algodv2('', net.algodUrl, '');

/**
 * Default keyfile path. Deliberately under `$HOME` and not under the repository:
 * a secret inside the working tree is one `git add -A` away from being public,
 * and `.gitignore` is a convention rather than a guarantee.
 */
const KEYFILE = process.env.MAINNET_KEYFILE ?? join(homedir(), '.algoterminal', 'mainnet-keys.json');

/**
 * Minimum balance to attempt an opt-in: 0.1 ALGO base + 0.1 ALGO for the ASA
 * holding, both of which must still be satisfied AFTER the 0.001 fee is paid,
 * plus margin. Below this, algod rejects the opt-in with an overspend error
 * that reads as a bug rather than as "this account is underfunded".
 */
const MIN_ALGO_MICRO = 210_000;

/** The verification payment in §5.1 is 0.005 USDC. */
const MIN_USDC_ATOMIC = 5_000;

interface Role {
  readonly name: 'payTo' | 'payer';
  /** Does this account need USDC of its own, or only the ability to receive it? */
  readonly needsBalance: boolean;
  readonly purpose: string;
}

const ROLES: readonly Role[] = [
  { name: 'payTo', needsBalance: false, purpose: 'receives every payment; goes in X402_PAYTO' },
  { name: 'payer', needsBalance: true, purpose: 'signs the one verification payment (§5.1)' },
];

type Keyfile = Record<Role['name'], { address: string; mnemonic: string }>;

function generate(): never {
  if (existsSync(KEYFILE)) {
    process.stderr.write(
      `REFUSING to overwrite an existing keyfile:\n  ${KEYFILE}\n\n` +
        'If those accounts hold funds, regenerating strands them at an address\n' +
        'nobody can sign for. Move the file aside deliberately if you really mean\n' +
        'to start over.\n',
    );
    process.exit(1);
  }

  mkdirSync(dirname(KEYFILE), { recursive: true, mode: 0o700 });

  const keyfile = Object.fromEntries(
    ROLES.map((role) => {
      const account = algosdk.generateAccount();
      return [
        role.name,
        { address: String(account.addr), mnemonic: algosdk.secretKeyToMnemonic(account.sk) },
      ];
    }),
  ) as Keyfile;

  // Write, then tighten. Writing at 0600 directly would still race on some
  // platforms where the file is created before the mode is applied.
  writeFileSync(KEYFILE, `${JSON.stringify(keyfile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(KEYFILE, 0o600);

  process.stdout.write(
    `Generated 2 MainNet accounts.\n\n` +
      `  Keyfile: ${KEYFILE}  (mode 0600 — back this up offline)\n\n` +
      ROLES.map((r) => `  ${r.name.padEnd(6)} ${keyfile[r.name].address}\n    ${r.purpose}\n`).join(
        '\n',
      ) +
      `\nThe mnemonics are in the keyfile and were deliberately NOT printed here.\n` +
      `Back them up offline now, before you send anything to these addresses.\n\n` +
      `Next: fund the addresses above, then re-run without --generate.\n`,
  );
  process.exit(0);
}

function load(): Keyfile {
  if (!existsSync(KEYFILE)) {
    process.stderr.write(
      `No keyfile at ${KEYFILE}.\nRun with --generate first:\n` +
        `  npm run mainnet:accounts -- --generate\n`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(KEYFILE, 'utf8')) as Keyfile;
}

async function ensure(role: Role, entry: Keyfile[Role['name']]): Promise<string[]> {
  const account = algosdk.mnemonicToSecretKey(entry.mnemonic);
  const address = String(account.addr);

  // A generated-but-unfunded account does not exist on chain yet, and algod
  // answers 404 rather than returning a zero balance. That is the normal state
  // before the first transfer, not an error worth a stack trace.
  let micro = 0;
  let assets: { assetId: bigint | number; amount: bigint | number }[] = [];
  try {
    const info = await algod.accountInformation(address).do();
    micro = Number(info.amount);
    assets = (info.assets ?? []) as typeof assets;
  } catch (err) {
    if (!String(err).includes('404')) throw err;
  }

  const usdc = assets.find((a) => Number(a.assetId) === net.usdcAsaId);
  const optedIn = usdc !== undefined;

  process.stdout.write(
    `${role.name}  ${address}\n` +
      `  ALGO:        ${(micro / 1e6).toFixed(6)}\n` +
      `  USDC opt-in: ${optedIn ? 'yes' : 'NO'}\n` +
      `  USDC:        ${usdc === undefined ? '-' : (Number(usdc.amount) / 1e6).toFixed(6)}\n`,
  );

  const todo: string[] = [];

  if (micro < MIN_ALGO_MICRO) {
    todo.push(
      `${role.name} needs ALGO (has ${(micro / 1e6).toFixed(6)}, needs ` +
        `${(MIN_ALGO_MICRO / 1e6).toFixed(3)} to opt in). Send ~1 ALGO to ${address}`,
    );
    // Without the balance the opt-in cannot be sent; stop here rather than
    // surfacing an overspend error that hides the real cause.
    return todo;
  }

  if (!optedIn) {
    process.stdout.write(`  opting ${role.name} in to USDC ASA ${net.usdcAsaId}...\n`);
    const params = await algod.getTransactionParams().do();
    // Opt-in is a zero-amount asset transfer to self (DEPLOYMENT.md §2.3).
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      receiver: account.addr,
      amount: 0,
      assetIndex: net.usdcAsaId,
      suggestedParams: params,
    });
    const { txid } = await algod.sendRawTransaction(txn.signTxn(account.sk)).do();
    await algosdk.waitForConfirmation(algod, txid, 6);
    process.stdout.write(`  opted in: ${txid}\n`);
    process.stdout.write(`  https://explorer.perawallet.app/tx/${txid}\n`);
  }

  if (role.needsBalance && Number(usdc?.amount ?? 0) < MIN_USDC_ATOMIC) {
    todo.push(
      `${role.name} needs at least ${(MIN_USDC_ATOMIC / 1e6).toFixed(3)} USDC ` +
        `(ASA ${net.usdcAsaId}) to make the §5.1 verification payment. Send it to ${address}`,
    );
  }

  return todo;
}

if (process.argv.includes('--generate')) generate();

const keyfile = load();
const todo: string[] = [];
for (const role of ROLES) todo.push(...(await ensure(role, keyfile[role.name])));

process.stdout.write(`\nX402_PAYTO=${keyfile.payTo.address}\n`);

if (todo.length === 0) {
  process.stdout.write('\nBoth accounts are ready for MainNet.\n');
} else {
  process.stdout.write(`\nStill to do:\n${todo.map((t) => `  - ${t}`).join('\n')}\n`);
  process.exitCode = 1;
}
