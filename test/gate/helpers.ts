import algosdk from 'algosdk';
import type {
  FacilitatorClient,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';

import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA } from '../../src/config/x402.js';
import type { RoundClock } from '../../src/gate/deadline.js';
import type { GateDeps } from '../../src/gate/middleware.js';
import type { PaymentRow } from '../../src/gate/ledger.js';
import { networkConstants } from '../../src/config/x402.js';

/** The fee payer GoPlausible advertises on `/supported` for Algorand. */
export const FEE_PAYER = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA';

export interface FakeFacilitator extends FacilitatorClient {
  readonly verifyCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[];
  readonly settleCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[];
  verifyResult: VerifyResponse | (() => VerifyResponse | Promise<VerifyResponse>);
  settleResult: SettleResponse | (() => SettleResponse | Promise<SettleResponse>);
}

/**
 * A facilitator that answers from memory and counts its calls.
 *
 * The point of the gate's tests is the ORDER of verify, handler and settle and
 * what happens on each failure — none of which needs a real chain. A fake makes
 * "settle was called exactly once" and "settle was never called" assertable,
 * which is the settle-after-success guarantee stated as a test rather than as
 * a paragraph.
 */
export function fakeFacilitator(overrides: Partial<FakeFacilitator> = {}): FakeFacilitator {
  const f: FakeFacilitator = {
    verifyCalls: [],
    settleCalls: [],
    verifyResult: { isValid: true },
    settleResult: {
      success: true,
      transaction: 'TESTTXID0000000000000000000000000000000000000000000000',
      network: ALGORAND_TESTNET_CAIP2,
      payer: 'PAYER',
    },
    async getSupported(): Promise<SupportedResponse> {
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: ALGORAND_TESTNET_CAIP2,
            extra: { feePayer: FEE_PAYER },
          },
        ],
        extensions: [],
      } as SupportedResponse;
    },
    async verify(payload, requirements) {
      f.verifyCalls.push({ payload, requirements });
      return typeof f.verifyResult === 'function' ? await f.verifyResult() : f.verifyResult;
    },
    async settle(payload, requirements) {
      f.settleCalls.push({ payload, requirements });
      return typeof f.settleResult === 'function' ? await f.settleResult() : f.settleResult;
    },
    ...overrides,
  };
  return f;
}

export interface FakeLedger {
  readonly rows: PaymentRow[];
  replayed: Set<string>;
}

export function fakeLedger(): FakeLedger {
  return { rows: [], replayed: new Set<string>() };
}

/**
 * A round clock fixed at a chosen round.
 *
 * The §4g-1 deadline is derived from `lastValid − currentRound`, so the two
 * numbers a test needs to control are the payment's window ({@link
 * buildPayment}'s `validity`) and the chain's position in it. Neither should
 * require a real chain: a revenue-integrity invariant that can only be
 * exercised against live TestNet is one that gets exercised once.
 */
export function fixedRoundClock(round: number | null): RoundClock {
  return { current: async () => round };
}

export function gateDeps(
  facilitator: FacilitatorClient,
  ledger: FakeLedger,
  roundClock: RoundClock = fixedRoundClock(FIRST_VALID),
): GateDeps {
  return {
    facilitator,
    net: networkConstants('testnet'),
    isReplayed: async (txid) => ledger.replayed.has(txid),
    recordPayment: async (row) => {
      ledger.rows.push(row);
      return true;
    },
    roundClock,
  };
}

// ---------------------------------------------------------------------------
// Building a payment header
// ---------------------------------------------------------------------------

const GENESIS_HASH = new Uint8Array(
  Buffer.from('SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=', 'base64'),
);

/**
 * The round the test chain sits at, and the default window built on it.
 *
 * A 1000-round window is what these helpers used before the deadline existed,
 * and it is kept as the default on purpose: every test that is not ABOUT the
 * deadline should have a budget so generous that the deadline is invisible to
 * it, so the ordering assertions still assert ordering rather than timing.
 * {@link buildPayment}'s `validity` option is how a test buys a tight one.
 */
export const FIRST_VALID = 1;
export const DEFAULT_VALIDITY_ROUNDS = 1000;

function suggestedParams(validityRounds: number): algosdk.SuggestedParams {
  return {
    fee: 1000,
    minFee: 1000,
    firstValid: FIRST_VALID,
    lastValid: FIRST_VALID + validityRounds,
    genesisID: 'testnet-v1.0',
    genesisHash: GENESIS_HASH,
    flatFee: true,
  };
}

/** Decode the `PAYMENT-REQUIRED` header a 402 carried. */
export function decodePaymentRequired(header: string | null): {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
  resource?: { url?: string; description?: string; tags?: string[] };
  extensions?: Record<string, unknown>;
} {
  if (header === null) throw new Error('no PAYMENT-REQUIRED header');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

export function decodePaymentResponse(header: string | null): Record<string, unknown> {
  if (header === null) throw new Error('no PAYMENT-RESPONSE header');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

export interface BuiltPayment {
  header: string;
  paymentTxid: string;
  payer: string;
}

/**
 * Build a `PAYMENT-SIGNATURE` header for the requirements a 402 quoted.
 *
 * Mirrors what a real client does (API_SPEC.md §2.2): an atomic group with the
 * unsigned fee-payer transaction at index 0 and the signed USDC transfer at
 * index 1, and `accepted` echoing the requirement chosen. The transactions are
 * real and really signed — that is what makes the derived `payment_txid`, and
 * therefore the replay guard and the ledger row, the same values production
 * would compute.
 */
export function buildPayment(
  requirements: PaymentRequirements,
  opts: { amount?: number; validity?: number } = {},
): BuiltPayment {
  const account = algosdk.generateAccount();
  const params = suggestedParams(opts.validity ?? DEFAULT_VALIDITY_ROUNDS);

  const feePayer = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: FEE_PAYER,
    receiver: FEE_PAYER,
    amount: 0,
    note: new TextEncoder().encode('x402-fee-payer'),
    suggestedParams: { ...params, fee: 2000, flatFee: true },
  });

  const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: requirements.payTo,
    amount: opts.amount ?? Number(requirements.amount),
    assetIndex: Number(requirements.asset ?? USDC_TESTNET_ASA),
    suggestedParams: params,
  });

  algosdk.assignGroupID([feePayer, transfer]);
  const signed = transfer.signTxn(account.sk);

  const body = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      paymentGroup: [
        Buffer.from(feePayer.toByte()).toString('base64'),
        Buffer.from(signed).toString('base64'),
      ],
      paymentIndex: 1,
    },
  };

  return {
    header: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
    paymentTxid: transfer.txID(),
    payer: String(account.addr),
  };
}
