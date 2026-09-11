/**
 * `algoterminal_spend` — FREE.
 *
 * Cumulative spend, the caps, and the payer account, on demand. The receipt at
 * the bottom of every paid result already reports the running total, but a model
 * deciding whether a sweep of eight comparisons is affordable should be able to
 * check the budget without buying something to find out.
 *
 * It also reads the payer's on-chain USDC balance and opt-in status, because the
 * single most common way an x402 integration fails is an account that is not
 * opted in to the asset. An Algorand account that has not opted in CANNOT hold
 * the ASA, so every payment to or from it fails — and the resulting error looks
 * like a service problem rather than a wallet one. Better to say it here.
 */
import algosdk from 'algosdk';

import { text, type ToolContext, type ToolResult } from './shared.js';
import { atomicToUsdc } from '../config.js';

export const SPEND_DESCRIPTION =
  'FREE — costs nothing, makes no payment. Reports how much USDC this session has spent on AlgoTerminal so ' +
  'far, the per-call and per-session caps, an itemized receipt of every settled payment with its Algorand ' +
  'transaction id, and the payer account\'s address, USDC balance and opt-in status. Call this before a ' +
  'series of paid calls to check the budget, or after a payment failure to see whether the wallet is the ' +
  'cause.';

export async function spendTool(ctx: ToolContext, payerAddress: string | null): Promise<ToolResult> {
  const s = ctx.ledger.summary();
  const net = ctx.config.network;

  const lines: string[] = [
    'ALGOTERMINAL SPEND — this session',
    `  spent:        ${s.spentUsdc} USDC across ${s.callCount} settled payment(s)`,
    `  session cap:  ${s.sessionCapUsdc} USDC   (ALGOTERMINAL_MAX_SPEND_USDC)`,
    `  remaining:    ${s.remainingUsdc} USDC`,
    `  per-call cap: ${s.perCallCapUsdc} USDC   (ALGOTERMINAL_MAX_PER_CALL_USDC)`,
    '',
    'A call that would exceed either cap is REFUSED outright — never truncated, never partially made. ' +
      'Raising a cap means changing the MCP server config and restarting; it cannot be done from a tool call.',
    '',
    `Payment chain: ${net.id} · USDC ASA ${net.usdcAsaId} · service ${ctx.config.baseUrl}`,
  ];

  if (payerAddress === null) {
    lines.push(
      '',
      'PAYER: none configured. The paid tools will refuse to run. Set ALGOTERMINAL_MNEMONIC or ' +
        'ALGOTERMINAL_KEYFILE to the user\'s own account; this server never pays on anyone\'s behalf.',
    );
  } else {
    lines.push('', `PAYER: ${payerAddress}`, `  ${net.explorerAddressBase}/${payerAddress}`);
    try {
      const algod = new algosdk.Algodv2('', net.algodUrl, '');
      const info = (await algod.accountInformation(payerAddress).do()) as {
        amount: number | bigint;
        assets?: { assetId: number | bigint; amount: number | bigint }[];
      };
      const holding = (info.assets ?? []).find((a) => String(a.assetId) === net.usdcAsaId);
      lines.push(`  ALGO balance:  ${atomicToUsdc(BigInt(info.amount))} (microALGO shown at 6dp)`);
      if (holding === undefined) {
        lines.push(
          `  USDC opt-in:   NO — this account is NOT opted in to ASA ${net.usdcAsaId}.`,
          '  An Algorand account that is not opted in to an asset cannot hold it, and every payment fails.',
          '  Fix: send a zero-amount transfer of that ASA to itself, then fund it with USDC.',
          `  Verify on chain: curl -s "${net.algodUrl}/v2/accounts/${payerAddress}" | jq '.assets[] | select(."asset-id" == ${net.usdcAsaId})'`,
          '  A record with "amount": 0 is the pass condition; empty output means not opted in.',
        );
      } else {
        const balance = BigInt(holding.amount);
        lines.push(
          `  USDC opt-in:   yes`,
          `  USDC balance:  ${atomicToUsdc(balance)} USDC`,
          balance === 0n
            ? '  The account is opted in but holds no USDC, so every paid call will fail at settlement. Fund it.'
            : `  That funds roughly ${balance / 5_000n} more cache-backed get_metric calls at $0.005 each, ` +
              'subject to the caps above.',
        );
      }
      lines.push(
        '',
        'The facilitator sponsors the Algorand network fee, so this account needs USDC only — no ALGO for gas. ' +
          'It still needs a little ALGO for its own minimum balance requirement.',
      );
    } catch (cause) {
      lines.push(
        `  (could not read the account from ${net.algodUrl}: ${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }

  if (s.settlements.length > 0) {
    lines.push('', 'SETTLED PAYMENTS');
    for (const r of s.settlements) {
      lines.push(
        `  ${r.at}  ${atomicToUsdc(r.atomic)} USDC  ${r.label}`,
        r.txid === null ? '    (no settlement receipt returned)' : `    ${net.explorerTxBase}/${r.txid}`,
      );
    }
  }

  return text(lines.join('\n'));
}
