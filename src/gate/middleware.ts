import type { Context, MiddlewareHandler } from 'hono';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPRequestContext,
} from '@x402/core/server';
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { HonoAdapter } from '@x402/hono';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { bazaarResourceServerExtension } from '@x402/extensions/bazaar';

import { env } from '../config/env.js';
import { activeNetwork, type NetworkConstants } from '../config/x402.js';
import { envelope } from '../errors.js';
import { logger } from '../logger.js';
import { formatUsdc, type RouteSpec } from '../pricing.js';
import { failClosed } from './facilitator.js';
import {
  createRoundClock,
  handlerBudget,
  quotedCapBudget,
  raceDeadline,
  setPaidDeadline,
  type HandlerBudget,
  type RoundClock,
} from './deadline.js';
import { isReplayed, recordPayment } from './ledger.js';
import { identifyPayment, PAYMENT_HEADER, PAYMENT_HEADER_V1, type DecodedPayment } from './payload.js';
import { buildRoutes, matchPaidRoute, priceFor, variantIdFor } from './routes.js';

/**
 * The x402 payment gate — ARCHITECTURE.md §4.1, API_SPEC.md §2.
 *
 * ## The ordering guarantee
 *
 * This is the behaviour the whole file exists to hold:
 *
 *   `/verify` runs BEFORE the handler — we never do unpaid work.
 *   `/settle` runs ONLY after the handler returns 2xx — we never take money
 *   for a failure.
 *
 * ARCHITECTURE.md §3: "It also makes the leaderboard number honest: settled
 * volume equals successfully-served requests." A handler that throws, a 404
 * `KPI_NOT_APPLICABLE`, a 422 `UNROUTABLE_QUESTION` and a 502
 * `UPSTREAM_UNAVAILABLE` all take the same path out of this function, and none
 * of them reaches settle.
 *
 * ## Why this is hand-written rather than `paymentMiddlewareFromConfig`
 *
 * ARCHITECTURE.md §4.1 named `paymentMiddlewareFromConfig` before the packages
 * were read. It implements the same verify/handler/settle order, but three
 * behaviours this project specifies are not reachable through it, and all three
 * are the ones that matter most:
 *
 *  - **Fail closed.** An unreachable `/verify` produces a bare 502 from the
 *    packaged middleware. §5.2 requires 503 with `Retry-After: 5`, and calls
 *    serving data because the facilitator blinked "the one bug that would
 *    invalidate the whole entry". A 502 is not that bug, but it is also not the
 *    documented contract an agent retries against.
 *  - **Do not retract a delivered response.** On a settle failure the packaged
 *    middleware discards the handler's 200 and returns a 402 instead. §5.2 says
 *    the opposite, and says why: "We eat the loss rather than retracting a
 *    delivered response — but we must *know* it happened."
 *  - **409 `payment_replayed`** (API_SPEC.md §2.4) has no hook at all.
 *
 * Everything that is protocol rather than policy still comes from the library:
 * `x402HTTPResourceServer` builds and encodes the requirements, matches routes,
 * decodes the payment header, and calls verify and settle. What is written out
 * here is the sequencing and the error contract — the parts API_SPEC.md §2
 * specifies and the library leaves to the resource server.
 */

const log = logger.child({ component: 'gate' });

/**
 * The Hono adapter, with the v1 header alias actually wired up.
 *
 * API_SPEC.md §2.2 accepts the payment in `PAYMENT-SIGNATURE` (v2) or
 * `X-PAYMENT` (v1 compat). The resource server reads only the v2 name when it
 * decodes the payload, so a v1 client's header would be advertised as supported
 * and then silently ignored — a caller who did everything we documented getting
 * a 402. Aliasing here makes the compatibility claim true at the one place the
 * header is read.
 */
class GateAdapter extends HonoAdapter {
  /**
   * The canonical public URL of this request, not the one the socket saw.
   *
   * The resource server puts this into the 402's `resource.url`, which is the
   * URL the Bazaar indexes and an agent retries against. Behind Railway's proxy
   * the request arrives over plain HTTP, so the unmodified adapter reports an
   * `http://` origin — and a directory listing pointing at `http://` for a
   * service that only answers on HTTPS is a listing that does not work.
   * `PUBLIC_BASE_URL` is already the validated canonical origin and is already
   * what the 402 body reports, so using it here also makes the header and the
   * body agree rather than differ by a scheme.
   */
  override getUrl(): string {
    const { pathname, search } = new URL(super.getUrl());
    return `${env.PUBLIC_BASE_URL}${pathname}${search}`;
  }

  override getHeader(name: string): string | undefined {
    const direct = super.getHeader(name);
    if (direct !== undefined) return direct;
    return name.toLowerCase() === PAYMENT_HEADER.toLowerCase()
      ? super.getHeader(PAYMENT_HEADER_V1)
      : undefined;
  }
}

/** §2.4 — how long a caller should wait before retrying a fail-closed 503. */
export const RETRY_AFTER_SECONDS = 5;

export interface GateDeps {
  readonly facilitator: FacilitatorClient;
  readonly net: NetworkConstants;
  /** Injected so a test can assert what was written without a database. */
  readonly isReplayed: (paymentTxid: string) => Promise<boolean>;
  readonly recordPayment: typeof recordPayment;
  /**
   * The payment chain's round, for the §4g-1 handler deadline.
   *
   * Injected for the same reason the facilitator and the ledger are: the
   * deadline is a revenue-integrity invariant, and a test that has to move a
   * real chain forward to exercise it is a test nobody runs.
   */
  readonly roundClock: RoundClock;
}

export function defaultGateDeps(): GateDeps {
  return {
    facilitator: new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }),
    net: activeNetwork(),
    isReplayed,
    recordPayment,
    // The PAYMENT chain's algod, from `config/x402.ts` — not `env.ALGOD_URL`,
    // which points at the chain the connectors read protocols from. They are
    // different chains and DEPLOYMENT.md §3 records what confusing them costs.
    roundClock: createRoundClock({ algodUrl: activeNetwork().algodUrl }),
  };
}

/**
 * The configured resource server.
 *
 * `initialize()` fetches `/supported` from the facilitator, which is where
 * `extra.feePayer` on every 402 comes from — DEPLOYMENT.md §1 makes confirming
 * that response the first step of the whole deployment. It is awaited on the
 * first paid request rather than at import, and retried on the next request if
 * it fails, so a facilitator that is down at boot delays payments instead of
 * preventing the process from starting and taking `/health` down with it.
 */
export function createResourceServer(deps: GateDeps): x402HTTPResourceServer {
  const server = new x402ResourceServer(failClosed(deps.facilitator))
    .register(deps.net.caip2 as Network, new ExactAvmScheme())
    // DEPLOYMENT.md §6.1 — the discovery declaration on each route is only
    // validated and forwarded if the extension is registered.
    .registerExtension(bazaarResourceServerExtension);

  return new x402HTTPResourceServer(server, buildRoutes(deps.net));
}

// ---------------------------------------------------------------------------
// §2.4 error responses
// ---------------------------------------------------------------------------

/**
 * Map a facilitator `invalidReason` onto the API_SPEC.md §2.4 code.
 *
 * The reasons are the AVM scheme's own ids (`invalid_exact_avm_*`). They are
 * matched by substring rather than by an exhaustive table on purpose: a
 * facilitator that adds a reason we have never seen must still produce a
 * sensible §2.4 code, and the verbatim reason travels in `detail` either way,
 * which is what §2.4 asks for ("`detail` carries the facilitator's reason").
 */
export function classifyInvalidReason(reason: string | undefined): 'payment_invalid' | 'payment_insufficient' | 'payment_expired' {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('expired') || r.includes('timeout') || r.includes('last_valid')) {
    return 'payment_expired';
  }
  if (r.includes('amount') || r.includes('insufficient')) return 'payment_insufficient';
  return 'payment_invalid';
}

interface PaymentErrorBody {
  error: string;
  detail: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The body for a 402 that is not the plain "no payment" case.
 *
 * The library builds these 402s with an empty body — correct for the protocol
 * (everything is in `PAYMENT-REQUIRED`), and useless to an operator reading
 * logs or to an agent without an x402 library. §2.4 specifies a code per case
 * and `required`/`provided` on `payment_insufficient` specifically, so the body
 * is composed here from the facilitator's reason and what we quoted.
 */
export function paymentErrorBody(
  reason: string | undefined,
  quotedAtomic: number,
  payment: DecodedPayment | null,
  base: Record<string, unknown>,
): PaymentErrorBody {
  const code = classifyInvalidReason(reason);
  const body: PaymentErrorBody = {
    ...base,
    error: code,
    detail: { facilitator_reason: reason ?? null },
  };

  if (code === 'payment_insufficient') {
    body.required = String(quotedAtomic);
    body.required_usdc = formatUsdc(quotedAtomic);
    // Null rather than absent when we could not read it: "we do not know what
    // you sent" is a different statement from "you sent nothing", and an agent
    // debugging its own client needs to tell them apart.
    body.provided = payment?.paidAtomic == null ? null : String(payment.paidAtomic);
  }
  return body;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function paymentGate(deps: GateDeps = defaultGateDeps()): MiddlewareHandler {
  let server: x402HTTPResourceServer | null = null;
  let initialized: Promise<void> | null = null;

  async function ready(): Promise<x402HTTPResourceServer> {
    server ??= createResourceServer(deps);
    if (initialized === null) {
      initialized = server.initialize().catch((err: unknown) => {
        // Cleared so the NEXT paid request retries. A facilitator that was
        // down for one request must not gate the process forever.
        initialized = null;
        throw err;
      });
    }
    await initialized;
    return server;
  }

  return async (c, next) => {
    const route = matchPaidRoute(c.req.path, c.req.method);
    // A free route is never gated (API_SPEC.md §1). This is the first branch in
    // the function so that /health and /catalog cannot be made to depend on the
    // facilitator being reachable.
    if (route === undefined) return next();

    const context: HTTPRequestContext = {
      adapter: new GateAdapter(c),
      path: c.req.path,
      method: c.req.method,
      paymentHeader: c.req.header(PAYMENT_HEADER) ?? c.req.header(PAYMENT_HEADER_V1),
    };

    const payment =
      context.paymentHeader === undefined ? null : identifyPayment(context.paymentHeader);

    // ---- 409 payment_replayed (§2.4) --------------------------------------
    // Before verify and before any work: a replay must cost us one indexed
    // lookup, not a facilitator round-trip and a cache read.
    if (payment !== null && (await deps.isReplayed(payment.paymentTxid))) {
      log.warn({ payment_txid: payment.paymentTxid, path: c.req.path }, 'replayed payment rejected');
      return c.json(
        envelope('PAYMENT_REPLAYED', 'This payment has already been recorded.', {
          error: 'payment_replayed',
          payment_txid: payment.paymentTxid,
        }),
        409,
      );
    }

    // ---- verify (before the handler) --------------------------------------
    let processed;
    try {
      const httpServer = await ready();
      processed = await httpServer.processHTTPRequest(context);
    } catch (err) {
      // §5.2: "/verify unreachable -> 503, Retry-After: 5. We do NOT fail
      // open." Everything that can throw out of processHTTPRequest is a
      // facilitator problem — an unreachable /supported at initialize, a
      // timeout, a non-JSON response. None of them is evidence that the caller
      // paid, so none of them may serve data.
      log.error({ err, path: c.req.path }, 'facilitator unreachable; failing closed');
      c.header('Retry-After', String(RETRY_AFTER_SECONDS));
      return c.json(
        envelope(
          'FACILITATOR_UNAVAILABLE',
          'The payment facilitator could not be reached. No data is served without a verified payment.',
          { error: 'facilitator_unavailable', retry_after_seconds: RETRY_AFTER_SECONDS },
        ),
        503,
      );
    }

    if (processed.type === 'no-payment-required') return next();

    if (processed.type === 'payment-error') {
      return respondPaymentError(c, processed.response, route, context, payment);
    }

    // ---- the handler, on a deadline (§4g item 1) --------------------------
    const { paymentPayload, paymentRequirements, declaredExtensions } = processed;

    const budget = await budgetFor(deps, payment);
    setPaidDeadline(c, Date.now() + budget.ms);

    // Already inside the settle headroom. The data would be unbillable before
    // it was computed, so computing it would be pure loss — refuse for free.
    if (budget.ms === 0) return expired(c, route, payment, budget, 0);

    // The handler's own promise must never reject: it is about to lose a race,
    // and a rejection losing a race is an unhandled rejection on a request we
    // have already answered. The error is captured and rethrown below instead.
    let handlerError: unknown;
    const running = next().then(
      () => undefined,
      (err: unknown) => {
        handlerError = err;
      },
    );

    const startedAt = Date.now();
    const overran = await raceDeadline(running, budget.ms);

    if (overran) {
      // The handler is still going. It is not cancellable — `getFact` and the
      // connectors below it take no AbortSignal — so it is left to finish into
      // the cache, where the next caller gets the benefit of the work. What
      // must not happen is settling for it, and returning here is what
      // guarantees that: `settleAndRecord` is below this line.
      void running.then(() => {
        log.info(
          { path: c.req.path, elapsed_ms: Date.now() - startedAt, errored: handlerError !== undefined },
          'handler finished after its payment window had already been abandoned',
        );
      });
      return expired(c, route, payment, budget, Date.now() - startedAt);
    }

    if (handlerError !== undefined) {
      // The handler threw. NO settle: the caller is not charged for an error
      // (§5.2). Rethrown so app.onError renders the standard envelope.
      log.warn({ err: handlerError, path: c.req.path }, 'handler threw after verify; skipping settle');
      throw handlerError;
    }

    // A 4xx or 5xx from the handler — 404 KPI_NOT_APPLICABLE, 422
    // UNROUTABLE_QUESTION, 502 UPSTREAM_UNAVAILABLE — is a failure we do not
    // charge for. This one line is the settle-after-success guarantee.
    if (c.res.status >= 400) {
      log.info(
        { status: c.res.status, path: c.req.path },
        'handler did not succeed; payment not settled',
      );
      return;
    }

    // ---- settle (only now) ------------------------------------------------
    await settleAndRecord(c, await ready(), {
      deps,
      route,
      context,
      payment,
      paymentPayload,
      paymentRequirements,
      declaredExtensions,
    });
  };
}

// ---------------------------------------------------------------------------
// The handler deadline (§4g item 1)
// ---------------------------------------------------------------------------

/**
 * This request's handler budget, derived from the payment's own validity
 * window rather than from our quoted `maxTimeoutSeconds`.
 *
 * A failure to read the chain round is not a failure of the request: the
 * budget falls back to the payment's window length and then to the quoted cap,
 * so there is always SOME deadline. "No deadline" is the state this whole
 * change exists to remove, and it must not be reachable by an algod blip.
 */
async function budgetFor(deps: GateDeps, payment: DecodedPayment | null): Promise<HandlerBudget> {
  try {
    return handlerBudget(payment, await deps.roundClock.current());
  } catch (err) {
    log.warn({ err }, 'round clock threw; falling back to the quoted timeout as the deadline');
    return quotedCapBudget();
  }
}

/**
 * 504 — the handler outlived the payment. Not settled, and not charged.
 *
 * ARCHITECTURE.md §5.2 says we eat the loss rather than retract a DELIVERED
 * response, and that still holds: nothing has been delivered here. This is the
 * case §5.2 could not describe, because until now the handler could not be
 * stopped — data was always delivered, and the only question was whether we
 * could bill for it. Failing before delivery is strictly better than
 * delivering something we cannot bill for: the caller pays nothing, keeps
 * nothing, and is told to retry.
 *
 * It is logged at WARN with the payment identified, because a rising rate here
 * is the same signal `settle_failures_1h` was: work we are doing and not
 * getting paid for. It is simply the cheap version of it.
 */
function expired(
  c: Context,
  route: RouteSpec,
  payment: DecodedPayment | null,
  budget: HandlerBudget,
  elapsedMs: number,
) {
  log.warn(
    {
      path: c.req.path,
      route: route.path,
      payment_txid: payment?.paymentTxid ?? null,
      payer: payment?.payer ?? null,
      budget_ms: budget.ms,
      elapsed_ms: elapsedMs,
      basis: budget.basis,
      last_valid: budget.lastValid,
      current_round: budget.currentRound,
    },
    'handler deadline reached before the payment window closed; returning 504 and NOT settling',
  );

  return c.json(
    envelope(
      'PAYMENT_WINDOW_EXPIRED',
      'This request could not be completed inside the validity window of the payment it arrived ' +
        'with, so it was abandoned before the data was produced. You have not been charged and no ' +
        'settlement was attempted. Retry with a new payment; if this route is being called with ' +
        '?fresh=true, the base price serves the same number from cache and is the faster path.',
      {
        error: 'payment_window_expired',
        budget_ms: budget.ms,
        elapsed_ms: elapsedMs,
        budget_basis: budget.basis,
        payment_last_valid_round: budget.lastValid,
        settled: false,
        charged: false,
      },
    ),
    504,
  );
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

interface ResponseInstructions {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}

/**
 * Write a 402 (or 403) built by the resource server.
 *
 * Two things are added to what the library produced:
 *
 *  - `X-PAYMENT-REQUIRED`, the v1 compatibility alias for `PAYMENT-REQUIRED`
 *    that API_SPEC.md §2.1 requires, carrying the same base64. A v1 client
 *    reads one header, a v2 client the other, and they are the same bytes.
 *  - The §2.4 body for the failure cases. The library emits `{}` there, having
 *    already said everything in the header.
 */
function respondPaymentError(
  c: Context,
  response: ResponseInstructions,
  route: RouteSpec,
  context: HTTPRequestContext,
  payment: DecodedPayment | null,
) {
  for (const [key, value] of Object.entries(response.headers)) c.header(key, value);

  const required = response.headers['PAYMENT-REQUIRED'];
  if (required !== undefined) c.header('X-PAYMENT-REQUIRED', required);

  if (response.isHtml === true) {
    return c.html(String(response.body ?? ''), response.status as 402);
  }

  const body = response.body;
  const isEmpty = body === undefined || (typeof body === 'object' && body !== null && Object.keys(body).length === 0);

  // A non-empty body is the unpaidResponseBody callback's §2.1 restatement:
  // that is the "no payment supplied" case and it is already correct.
  if (!isEmpty) return c.json(body as object, response.status as 402);

  // An empty body means the payment was supplied and rejected. Decode what we
  // told the caller and restate it as a §2.4 error.
  let reason: string | undefined;
  try {
    const decoded = JSON.parse(Buffer.from(required ?? '', 'base64').toString('utf8')) as {
      error?: string;
    };
    reason = decoded.error;
  } catch {
    reason = undefined;
  }

  return c.json(
    paymentErrorBody(reason, priceFor(route, context), payment, {
      resource: `${env.PUBLIC_BASE_URL}${context.path}`,
      variant: variantIdFor(route, context),
    }),
    response.status as 402,
  );
}

interface SettleArgs {
  deps: GateDeps;
  route: RouteSpec;
  context: HTTPRequestContext;
  payment: DecodedPayment | null;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  declaredExtensions?: Record<string, unknown>;
}

/**
 * Settle a verified payment for a response that already succeeded, and write
 * the ledger row either way.
 *
 * The response body is never touched here. On success we add
 * `PAYMENT-RESPONSE`; on failure we add the facilitator's own failure receipt
 * and keep the 200 — ARCHITECTURE.md §5.2: "We have already returned the data
 * ... We eat the loss rather than retracting a delivered response — but we must
 * *know* it happened, because an unnoticed settle-failure rate is silent
 * revenue loss and a leaderboard discrepancy." Knowing is the ERROR log, the
 * `settle_failed` row carrying the payload, and `/health`.
 */
async function settleAndRecord(
  c: Context,
  httpServer: x402HTTPResourceServer,
  args: SettleArgs,
): Promise<void> {
  const { deps, route, context, payment, paymentPayload, paymentRequirements } = args;
  const amountAtomic = Number(paymentRequirements.amount);

  let settle: (SettleResponse & { success: boolean }) | null = null;
  let thrown: unknown;

  try {
    settle = await httpServer.processSettlement(
      paymentPayload,
      paymentRequirements,
      args.declaredExtensions,
      { request: context },
    );
  } catch (err) {
    // Only a facilitator transport failure reaches here; processSettlement
    // turns every settlement-level failure into a result.
    thrown = err;
  }

  const succeeded = settle !== null && settle.success;
  const errorReason = succeeded
    ? null
    : ((settle as { errorReason?: string } | null)?.errorReason ??
      (thrown instanceof Error ? thrown.message : 'settlement failed'));

  // §2.3 — the settlement receipt. `txid` is added alongside the protocol's
  // own `transaction` field: API_SPEC.md §2.3 documents the header as
  // `{ success, txid, network, payer }`, while the x402 wire type calls that
  // field `transaction`. Emitting both keeps a stock x402 client and our own
  // documented shape reading the same receipt.
  const receipt: SettleResponse & { txid?: string | null } = succeeded
    ? { ...(settle as SettleResponse), txid: (settle as SettleResponse).transaction }
    : {
        success: false,
        transaction: '',
        txid: null,
        network: paymentRequirements.network,
        payer: payment?.payer,
        errorReason: errorReason ?? 'settlement failed',
      };

  for (const [key, value] of Object.entries(httpServer.createSettlementHeaders(receipt))) {
    c.res.headers.set(key, value);
  }

  if (!succeeded) {
    log.error(
      {
        path: c.req.path,
        route: route.path,
        payment_txid: payment?.paymentTxid ?? null,
        payer: payment?.payer ?? null,
        amount_atomic: amountAtomic,
        error_reason: errorReason,
        err: thrown,
      },
      'SETTLE FAILED after a successful response — data delivered, payment not collected',
    );
    c.res.headers.set('X-AlgoTerminal-Settlement', 'failed');
  }

  // A payment we could not identify cannot be recorded: `payment_txid` is the
  // ledger's primary key. It is also a payment the facilitator accepted, so
  // this is a real gap rather than a tidy one, and it is logged as such.
  if (payment === null) {
    log.error(
      { path: c.req.path, settled: succeeded },
      'settled a payment we could not identify; no ledger row written',
    );
    return;
  }

  await deps.recordPayment({
    paymentTxid: payment.paymentTxid,
    txid: succeeded ? ((settle as SettleResponse).transaction ?? null) : null,
    payer: (settle as SettleResponse | null)?.payer ?? payment.payer,
    amountAtomic,
    assetId: Number(paymentRequirements.asset),
    route: route.path,
    network: paymentRequirements.network,
    status: succeeded ? 'settled' : 'settle_failed',
    // §5.2 requires the payload on a failure row, for reconciliation. Not kept
    // on a settled row: there the settlement txid is the receipt, and storing
    // every signed group would be a large blob nothing reads.
    payload: succeeded ? undefined : paymentPayload,
    errorReason,
  });
}
