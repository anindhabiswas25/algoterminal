/**
 * `npm run testnet:accounts` — prepare the TestNet accounts DEPLOYMENT.md §2
 * requires, and report exactly what is still missing.
 *
 * Two accounts, with different jobs:
 *
 *  - **payTo** receives every payment. Its transaction history becomes the
 *    public evidence of how the entry earned its volume, so §2 wants it fresh
 *    and single-purpose. It must be opted in to USDC before the endpoint is
 *    reachable: an account that has not opted in CANNOT receive the asset, and
 *    every payment to it fails.
 *  - **payer** is the smoke test's client. It needs ALGO for its own minimum
 *    balance and an opt-in, plus USDC to spend. It does NOT need ALGO for fees:
 *    the facilitator sponsors those, which is the property the round trip is
 *    partly there to prove.
 *
 * Idempotent. Run it, fund whatever it says is unfunded, run it again.
 *
 * Mnemonics come from the environment, never from the repo:
 *   TESTNET_PAYTO_MNEMONIC=... TESTNET_PAYER_MNEMONIC=... npm run testnet:accounts
 */
import algosdk from 'algosdk';

import { networkConstants } from '../src/config/x402.js';

const net = networkConstants('testnet');
const algod = new algosdk.Algodv2('', net.algodUrl, '');

const MIN_ALGO_MICRO = 300_000;

interface Role {
  readonly name: string;
  readonly envVar: string;
  /** Does this account need USDC of its own, or only the ability to receive it? */
  readonly needsBalance: boolean;
}

const ROLES: readonly Role[] = [
  { name: 'payTo', envVar: 'TESTNET_PAYTO_MNEMONIC', needsBalance: false },
  { name: 'payer', envVar: 'TESTNET_PAYER_MNEMONIC', needsBalance: true },
];

async function ensure(role: Role): Promise<string[]> {
  const mnemonic = process.env[role.envVar];
  if (mnemonic === undefined || mnemonic.trim() === '') {
    return [`${role.envVar} is not set — nothing to do for ${role.name}.`];
  }

  const account = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const address = String(account.addr);
  const info = await algod.accountInformation(address).do();
  const micro = Number(info.amount);
  const optedIn = (info.assets ?? []).some((a) => Number(a.assetId) === net.usdcAsaId);
  const usdc = (info.assets ?? []).find((a) => Number(a.assetId) === net.usdcAsaId);

  process.stdout.write(
    `${role.name}  ${address}\n` +
      `  ALGO:      ${(micro / 1e6).toFixed(6)}\n` +
      `  USDC opt-in: ${optedIn ? 'yes' : 'NO'}\n` +
      `  USDC:      ${usdc === undefined ? '-' : (Number(usdc.amount) / 1e6).toFixed(6)}\n`,
  );

  const todo: string[] = [];

  if (micro < MIN_ALGO_MICRO) {
    todo.push(
      `${role.name} needs TestNet ALGO (has ${(micro / 1e6).toFixed(6)}). ` +
        `Fund it: algokit dispenser fund -r ${address} -a 1000000`,
    );
    // Without ALGO the opt-in cannot be sent, so stop here rather than fail
    // with a confusing "overspend" from algod.
    return todo;
  }

  if (!optedIn) {
    process.stdout.write(`  opting ${role.name} in to USDC ASA ${net.usdcAsaId}...\n`);
    const params = await algod.getTransactionParams().do();
    // Opt-in is a zero-amount asset transfer to self (DEPLOYMENT.md §2).
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
  }

  if (role.needsBalance && (usdc === undefined || Number(usdc.amount) === 0)) {
    todo.push(
      `${role.name} needs TestNet USDC (ASA ${net.usdcAsaId}). ` +
        `Request it at https://faucet.circle.com for ${address} on Algorand TestNet.`,
    );
  }

  return todo;
}

const todo: string[] = [];
for (const role of ROLES) todo.push(...(await ensure(role)));

if (todo.length === 0) {
  process.stdout.write('\nBoth accounts are ready.\n');
} else {
  process.stdout.write(`\nStill to do:\n${todo.map((t) => `  - ${t}`).join('\n')}\n`);
  process.exitCode = 1;
}
