/**
 * The paying HTTP client.
 *
 * `@x402/fetch` turns a 402 into a signed retry, so a paid call reads like an
 * ordinary `fetch`. What this file adds around it is the part that makes it safe
 * to hand to a language model:
 *
 *  - **A veto before the signature.** `onBeforePaymentCreation` fires with the
 *    requirements the server actually quoted, before any key touches any bytes.
 *    That is where the caps are enforced, and it is the only place they can be
 *    enforced honestly: a price from `/catalog` or from a tool description is
 *    advisory, and a cap that guards an advisory number guards nothing. Aborting
 *    here means no transaction is built, no signature is made, and nothing
 *    reaches the chain.
 *  - **An asset check.** The client refuses to sign for any asset or chain other
 *    than the one it was configured for. A misconfigured `ALGOTERMINAL_NETWORK`
 *    should fail loudly rather than sign a MainNet payment someone expected to
 *    be play money.
 *  - **One payment at a time.** MCP tool calls can arrive concurrently. Two
 *    calls checking a shared budget in parallel can both pass a check that only
 *    one of them should. The mutex makes check-then-spend atomic.
 *  - **Recording settlement, not intent.** The ledger is credited from the
 *    settlement receipt after a 2xx, because that is when the service actually
 *    takes the money.
 */
import algosdk from 'algosdk';
import { x402Client } from '@x402/core/client';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { toClientAvmSigner } from '@x402/avm';
import { wrapFetchWithPayment } from '@x402/fetch';

import type { Config } from './config.js';
import { SpendLedger, SpendLimitError, type Settlement } from './spend.js';

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigError';
  }
}

/**
 * The paying half of the client, as an interface.
 *
 * `Payer` is the real implementation and signs with a real key. The interface
 * exists so the test suite can exercise a settled payment end to end without a
 * key, a node, or a chain — the alternative being a suite that never covers the
 * success path, which is the path that spends money.
 */
export interface PaymentBackend {
  readonly address: string;
  pay(url: string, init: RequestInit, label: string): Promise<PaidResult>;
}

export interface PaidResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  /** The amount the server quoted, in atomic USDC. Null if no 402 was issued. */
  readonly quotedAtomic: bigint | null;
  /** Present only when the payment settled. */
  readonly settlement: Settlement | null;
}

interface CallState {
  label: string;
  quotedAtomic: bigint | null;
  settleTxid: string | null;
  settleAmount: bigint | null;
  spendError: SpendLimitError | null;
  assetError: PaymentConfigError | null;
}

/** Decode the base64 `PAYMENT-RESPONSE` settlement receipt, if there is one. */
function readSettlementHeader(res: Response): { transaction?: string; amount?: string } | null {
  const header = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE');
  if (header === null) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { transaction?: string; amount?: string };
  } catch {
    return null;
  }
}

export class Payer implements PaymentBackend {
  readonly address: string;
  readonly #fetch: (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response>;
  #state: CallState | null = null;
  /** Serializes paid calls so the budget check and the spend that follows it cannot interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    readonly ledger: SpendLedger,
    baseFetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (config.mnemonic === null) {
      throw new PaymentConfigError('Payer constructed without a mnemonic; callers must check config.mnemonic first.');
    }

    let account: algosdk.Account;
    try {
      account = algosdk.mnemonicToSecretKey(config.mnemonic);
    } catch (cause) {
      throw new PaymentConfigError(
        `The mnemonic supplied via ${config.keySource} is not a valid 25-word Algorand mnemonic ` +
          `(${cause instanceof Error ? cause.message : String(cause)}). The key itself is never logged.`,
      );
    }
    this.address = String(account.addr);

    const client = new x402Client()
      // `algorand:*` registers both Algorand chains, so pointing the server at a
      // MainNet deployment later needs no code change: the 402 itself names the
      // chain, the asset and the amount, and the client obeys it. The asset check
      // in the hook below is what keeps that flexibility from being a footgun.
      .register(
        'algorand:*',
        new ExactAvmScheme(toClientAvmSigner(Buffer.from(account.sk).toString('base64')), {
          algodUrl: config.network.algodUrl,
        }),
      )
      // `@x402/fetch` has its own spend controls, and they are deliberately NOT
      // used. They run BEFORE the hook below and, when they reject, they reject
      // by filtering every requirement out — which surfaces as "All payment
      // requirements were rejected by spendControls.maxAmountPerPayment",
      // advice aimed at whoever wrote the client. The caller here is a language
      // model relaying a refusal to a person who wants to know what it would
      // have cost and which env var to change. Two enforcement points would mean
      // the worse message wins whenever both apply, so there is one: the hook,
      // which sees the same amount and can explain itself.
      .setSpendControls(false)
      .onBeforePaymentCreation(async (ctx) => {
        const state = this.#state;
        const req = ctx.selectedRequirements;

        // Refuse to sign for anything but the asset and chain this server was
        // configured for. A `ALGOTERMINAL_NETWORK` that disagrees with the
        // deployment should fail loudly here rather than sign a MainNet payment
        // someone believed was play money.
        if (req.asset !== config.network.usdcAsaId) {
          const err = new PaymentConfigError(
            `REFUSED: the service asked to be paid in asset ${req.asset}, but this server is configured for ` +
              `${config.network.usdcAsaId} (USDC on ${config.network.id}). Nothing was signed and nothing was ` +
              'spent. Check ALGOTERMINAL_NETWORK against the deployment at ALGOTERMINAL_BASE_URL.',
          );
          if (state !== null) state.assetError = err;
          return { abort: true, reason: err.message };
        }

        if (req.network !== config.network.caip2) {
          const err = new PaymentConfigError(
            `REFUSED: the service asked to be paid on chain ${req.network}, but this server is configured for ` +
              `${config.network.caip2} (${config.network.id}). Nothing was signed and nothing was spent. ` +
              'Check ALGOTERMINAL_NETWORK against the deployment at ALGOTERMINAL_BASE_URL.',
          );
          if (state !== null) state.assetError = err;
          return { abort: true, reason: err.message };
        }

        const quoted = BigInt(req.amount);
        if (state !== null) state.quotedAtomic = quoted;

        const label = state?.label ?? 'this call';
        try {
          this.ledger.assertAllowed(quoted, label);
        } catch (cause) {
          if (cause instanceof SpendLimitError) {
            if (state !== null) state.spendError = cause;
            return { abort: true, reason: cause.message };
          }
          throw cause;
        }
        return undefined;
      })
      .onPaymentResponse(async (ctx) => {
        const state = this.#state;
        if (state === null) return;
        if (ctx.settleResponse?.success === true) {
          state.settleTxid = ctx.settleResponse.transaction;
          if (ctx.settleResponse.amount !== undefined) state.settleAmount = BigInt(ctx.settleResponse.amount);
        }
      });

    this.#fetch = wrapFetchWithPayment(baseFetch, client);
  }

  /**
   * Make one paid request.
   *
   * Throws `SpendLimitError` when a cap refused the call — before any signature,
   * so nothing was spent. Returns normally for every HTTP outcome including
   * errors, because an AlgoTerminal error is information the caller needs and
   * not, notably, a charge.
   */
  async pay(url: string, init: RequestInit, label: string): Promise<PaidResult> {
    const run = async (): Promise<PaidResult> => {
      const state: CallState = {
        label,
        quotedAtomic: null,
        settleTxid: null,
        settleAmount: null,
        spendError: null,
        assetError: null,
      };
      this.#state = state;

      let res: Response;
      try {
        res = await this.#fetch(url, init);
      } catch (cause) {
        // An abort from the hook surfaces here as an opaque wrapper error. Our
        // own reason is the useful one, so it wins.
        if (state.spendError !== null) throw state.spendError;
        if (state.assetError !== null) throw state.assetError;
        throw cause;
      } finally {
        this.#state = null;
      }

      const body = await res
        .clone()
        .json()
        .catch(async () => await res.text().catch(() => null));

      let settlement: Settlement | null = null;
      if (res.ok && state.quotedAtomic !== null) {
        const receipt = readSettlementHeader(res);
        const txid = state.settleTxid ?? receipt?.transaction ?? null;
        // A 2xx on a paid route means the service settled: it settles only after
        // a successful response, and it has just produced one. Record the spend
        // whether or not the receipt header made it back, so the counter never
        // under-reports what the wallet actually paid.
        const amount =
          state.settleAmount ??
          (receipt?.amount !== undefined ? BigInt(receipt.amount) : null) ??
          state.quotedAtomic;
        settlement = this.ledger.record(label, amount, txid);
      }

      return {
        status: res.status,
        ok: res.ok,
        body,
        quotedAtomic: state.quotedAtomic,
        settlement,
      };
    };

    // Chain onto the queue so only one paid call is in flight at a time, and a
    // failure in one does not poison the queue for the next.
    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }
}
