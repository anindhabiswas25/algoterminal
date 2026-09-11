import algosdk from 'algosdk';

import { logger } from '../logger.js';

/**
 * Reading the caller's `PAYMENT-SIGNATURE` well enough to identify the payment
 * — and nothing more.
 *
 * This module deliberately does NOT validate a payment. Validation is the
 * facilitator's job (API_SPEC.md §2.4: `/verify` rejecting is what produces
 * `payment_invalid`), and a second, weaker implementation of it here would be a
 * place for the two to disagree. All we extract is the identity of the payment
 * — its transaction id and its payer — because the replay guard has to run
 * BEFORE verify, and the ledger row has to name a payer.
 *
 * Nothing here throws. The header is attacker-controlled input; a malformed one
 * must fall through to the normal 402 path, not become a 500.
 */

const log = logger.child({ component: 'gate.payload' });

/** API_SPEC.md §2.2 — v2 header, with the v1 alias still accepted. */
export const PAYMENT_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_HEADER_V1 = 'X-PAYMENT';

/** The `exact` AVM payload (ARCHITECTURE.md §3 step 3). */
export interface AvmPaymentGroup {
  readonly paymentGroup: readonly string[];
  readonly paymentIndex: number;
}

export interface DecodedPayment {
  /** Transaction id of the caller's signed payment transaction. */
  readonly paymentTxid: string;
  /** Sender of that transaction — the payer, for the ledger. */
  readonly payer: string;
  /**
   * Atomic units actually transferred, when the payment transaction is an ASA
   * transfer. Read locally so a `payment_insufficient` 402 can tell the caller
   * what it sent against what we quoted (API_SPEC.md §2.4) instead of only that
   * the facilitator said no. Null when the transaction is not an asset transfer
   * — which the facilitator rejects for its own reasons.
   */
  readonly paidAtomic: bigint | null;
  /** ASA id transferred, when readable. */
  readonly assetId: bigint | null;
  /**
   * The payment transaction's validity window, in rounds.
   *
   * This is the window that ACTUALLY governs how long we have (§4g item 1).
   * The client fixes it when it builds the group — `@x402/avm` composes through
   * algokit, whose `defaultValidityWindow` is 10, giving `lastValid =
   * firstValid + 10` and a real budget of ~31 s at the measured 2.75 s/round.
   * It is not our `maxTimeoutSeconds`, and a handler that outruns it delivers
   * data we can no longer collect on. Read here so `gate/deadline.ts` can
   * derive the handler's budget from the payment rather than from a constant.
   */
  readonly firstValid: bigint | null;
  readonly lastValid: bigint | null;
  /** `x402Version` as declared in the header, when present. */
  readonly x402Version: number | null;
  /** Network as declared in the header, when present. */
  readonly network: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The AVM payment group inside a decoded `PAYMENT-SIGNATURE` body, or null.
 *
 * Structural checks only, on every field we go on to index: `paymentIndex` is
 * an attacker-supplied array index, and reading `paymentGroup[paymentIndex]`
 * without bounds-checking it is how a header turns into an exception.
 */
export function readPaymentGroup(body: unknown): AvmPaymentGroup | null {
  if (!isRecord(body)) return null;
  const payload = body['payload'];
  if (!isRecord(payload)) return null;

  const group = payload['paymentGroup'];
  const index = payload['paymentIndex'];
  if (!Array.isArray(group) || group.length === 0) return null;
  if (!group.every((t): t is string => typeof t === 'string')) return null;
  if (typeof index !== 'number' || !Number.isInteger(index)) return null;
  if (index < 0 || index >= group.length) return null;

  return { paymentGroup: group, paymentIndex: index };
}

/**
 * Identify the payment carried by a `PAYMENT-SIGNATURE` header value.
 *
 * The transaction id is computed from the SIGNED payment transaction at
 * `paymentIndex`, not taken from anything the caller asserts. It is a hash of
 * the transaction's own bytes — including its group id, which the client fixed
 * before signing — so it is the same id the transaction will carry on chain and
 * the same one a replayed header would produce. That is what makes it usable as
 * the ledger's primary key and as the replay guard's question.
 *
 * Returns null for anything we cannot read. A caller sending nonsense gets the
 * ordinary 402 with a fresh `PAYMENT-REQUIRED`, which is more useful to it than
 * a bespoke error about its encoding.
 */
export function identifyPayment(headerValue: string): DecodedPayment | null {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  const group = readPaymentGroup(body);
  if (group === null) return null;

  try {
    const raw = Buffer.from(group.paymentGroup[group.paymentIndex] as string, 'base64');
    const signed = algosdk.decodeSignedTransaction(new Uint8Array(raw));
    const axfer = signed.txn.assetTransfer;
    return {
      paymentTxid: signed.txn.txID(),
      payer: String(signed.txn.sender),
      firstValid: signed.txn.firstValid,
      lastValid: signed.txn.lastValid,
      paidAtomic: axfer === undefined ? null : axfer.amount,
      assetId: axfer === undefined ? null : axfer.assetIndex,
      x402Version: isRecord(body) && typeof body['x402Version'] === 'number' ? body['x402Version'] : null,
      network: isRecord(body) && typeof body['network'] === 'string' ? body['network'] : null,
    };
  } catch (err) {
    // An unsigned or non-Algorand transaction at paymentIndex. The facilitator
    // will reject it for the same reason; we just cannot name it.
    log.debug({ err }, 'could not identify payment transaction in PAYMENT-SIGNATURE');
    return null;
  }
}
