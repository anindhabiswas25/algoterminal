import type { FacilitatorClient } from '@x402/core/server';
import {
  FacilitatorResponseError,
  VerifyError,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from '@x402/core/types';

import { logger } from '../logger.js';

/**
 * A facilitator client that makes the difference between "your payment is bad"
 * and "we could not ask" survive the trip up to the gate.
 *
 * ARCHITECTURE.md §5.2 gives those two outcomes different responses — 402 and
 * 503 — because they are different instructions to the caller: re-sign, versus
 * wait five seconds and retry the same payment. The resource server does not
 * preserve the distinction on its own. `x402HTTPResourceServer.processHTTPRequest`
 * re-throws only `FacilitatorResponseError` and converts everything else into a
 * 402, and `HTTPFacilitatorClient.verify` raises a bare `TypeError` from
 * `fetch` when the host is unreachable and a bare `Error` when the facilitator
 * answers 500 with a non-JSON body. Unwrapped, a facilitator outage therefore
 * presents to an agent as "your payment was rejected" — which sends it into a
 * re-sign loop against a service that is down, and hides the outage from us
 * behind a 402 count that looks like ordinary unpaid traffic.
 *
 * So: every failure that is not the facilitator telling us the payment is
 * invalid is re-thrown as a `FacilitatorResponseError`, which the resource
 * server propagates and the gate turns into the documented 503.
 *
 * This wrapper never converts a failure into a success. Failing closed is the
 * whole point — §5.2: serving unpaid data because our payment provider blinked
 * is "the one bug that would invalidate the whole entry".
 */

const log = logger.child({ component: 'gate.facilitator' });

export class FacilitatorUnavailableError extends FacilitatorResponseError {
  readonly operation: 'verify' | 'settle' | 'supported';

  constructor(operation: 'verify' | 'settle' | 'supported', cause: unknown) {
    super(
      `Facilitator ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'FacilitatorUnavailableError';
    this.operation = operation;
    // Kept on the standard `cause` chain so `getFacilitatorResponseError` and
    // structured logging both find the underlying transport error.
    this.cause = cause;
  }
}

/**
 * Wrap a facilitator client so transport failures are distinguishable.
 *
 * `settle` is passed through unchanged. `processSettlement` already turns every
 * settlement outcome — a `{success:false}` body, a `SettleError`, a timeout —
 * into a result the gate handles identically, and it handles them all the same
 * way for a reason: by the time settle runs, the response has succeeded, and
 * ARCHITECTURE.md §5.2 says we keep it whatever settle does. There is nothing
 * for a classification to change.
 */
export function failClosed(inner: FacilitatorClient): FacilitatorClient {
  return {
    async getSupported(): Promise<SupportedResponse> {
      try {
        return await inner.getSupported();
      } catch (err) {
        throw new FacilitatorUnavailableError('supported', err);
      }
    },

    async verify(
      payload: PaymentPayload,
      requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
      try {
        return await inner.verify(payload, requirements);
      } catch (err) {
        // A `VerifyError` is the facilitator answering, in its own schema, that
        // the payment is invalid — it just arrived with a non-2xx status. That
        // is a verdict, not an outage, so it becomes the ordinary invalid
        // result and a 402 with the reason attached (API_SPEC.md §2.4).
        if (err instanceof VerifyError) {
          return {
            isValid: false,
            invalidReason: err.invalidReason ?? err.message,
            payer: err.payer,
          } as VerifyResponse;
        }
        log.error({ err }, 'facilitator verify failed at the transport level');
        throw new FacilitatorUnavailableError('verify', err);
      }
    },

    settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      return inner.settle(payload, requirements);
    },
  };
}
