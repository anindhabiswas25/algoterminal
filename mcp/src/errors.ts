/**
 * Mapping AlgoTerminal's errors onto something a calling model can act on.
 *
 * The service's billing rule is unusual and worth stating plainly every time it
 * applies: **payment settles only after a 2xx**. A 404, a 422, a 502, a 504 —
 * none of them are charged. That means "retry" is genuinely free advice here in
 * a way it is not for most paid APIs, and a model that assumes otherwise will
 * hedge or give up when it should just call again.
 *
 * So every error this module renders answers three questions in order:
 *   1. What went wrong (the service's own code and message, verbatim).
 *   2. Were you charged? (essentially always: no.)
 *   3. What should you do instead?
 *
 * The codes below are the ones the service actually emits, taken from its
 * `/openapi.json` responses and its error module — not a defensive guess at
 * codes it might emit one day.
 */
import type { ErrorEnvelope } from './types.js';

export interface MappedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly detail: Record<string, unknown>;
  /** Whether the user's wallet was debited. Non-2xx is never charged. */
  readonly charged: boolean;
  /** Is calling again, unchanged, likely to work? */
  readonly retryable: boolean;
  readonly guidance: string;
}

interface CodeRule {
  readonly retryable: boolean;
  readonly guidance: string;
}

const BY_CODE: Record<string, CodeRule> = {
  KPI_NOT_APPLICABLE: {
    retryable: false,
    guidance:
      'This protocol does not publish this KPI. The reason below is the answer — report it. ' +
      'Do NOT substitute zero, do NOT fall back to a similar-sounding KPI, and do NOT describe ' +
      'this as missing data: a declined KPI is a fact about what the source discloses. ' +
      '`available_kpis` lists what this protocol does publish.',
  },
  KPI_NOT_APPLICABLE_TO_ANY: {
    retryable: false,
    guidance:
      'None of the protocols you named publish this KPI, so nothing was computed and nothing could have been. ' +
      'Call algoterminal_catalog to see which protocols publish it, then compare those.',
  },
  KPI_NOT_FOUND: {
    retryable: false,
    guidance: 'No such KPI. Call algoterminal_catalog (free) for the live list before spending again.',
  },
  PROTOCOL_NOT_FOUND: {
    retryable: false,
    guidance: 'No such protocol. Call algoterminal_catalog (free) for the live list of protocol ids.',
  },
  INVALID_PARAM: {
    retryable: false,
    guidance: 'Fix the parameter and call again. Nothing was computed, so nothing was charged.',
  },
  TOO_FEW_PROTOCOLS: {
    retryable: false,
    guidance: 'A comparison needs at least 2 protocols. Name another, or use algoterminal_get_metric for one.',
  },
  TOO_MANY_PROTOCOLS: {
    retryable: false,
    guidance: 'A comparison takes at most 5 protocols. Split it into two comparisons, or drop some legs.',
  },
  INSUFFICIENT_DATA: {
    retryable: true,
    guidance:
      'Fewer than two legs resolved, or the answer failed the service\'s own grounding checks. ' +
      'A one-way comparison is not the product, so it declined rather than sell one — and did not charge for it. ' +
      'Retrying shortly may succeed once the upstream connector recovers; check algoterminal_catalog first.',
  },
  UPSTREAM_UNAVAILABLE: {
    retryable: true,
    guidance:
      'Every source tier for this KPI is exhausted, so the service declined rather than serve a number it ' +
      'cannot bound the error on. You were not charged. Retry in a few minutes.',
  },
  OUT_OF_SCOPE: {
    retryable: false,
    guidance:
      'AlgoTerminal is descriptive only: no forecasts, no price targets, no trading advice. ' +
      'Rephrase as a question about a measured quantity. This probe was free.',
  },
  UNROUTABLE_QUESTION: {
    retryable: false,
    guidance:
      'The question could not be mapped onto the published coverage. The detail lists the protocols and KPIs ' +
      'that do exist. Probing is deliberately free here — rephrase and ask again.',
  },
  QUESTION_TOO_LONG: {
    retryable: false,
    guidance: 'Questions are capped at 500 characters. Shorten it and ask again; this was not charged.',
  },
  INVALID_BODY: { retryable: false, guidance: 'Malformed request body. Nothing was charged.' },
  DEPTH_MISMATCH: {
    retryable: false,
    guidance:
      '`depth` is a priced query parameter, so it must match what was quoted. Set it in the tool argument only, ' +
      'and let the server quote the price.',
  },
  PAYMENT_WINDOW_EXPIRED: {
    retryable: true,
    guidance:
      'The signed payment outlived its validity window before the service could settle it. Nothing was settled, ' +
      'so nothing was spent. Call again — a fresh payment will be signed.',
  },
  PAYMENT_REPLAYED: {
    retryable: true,
    guidance:
      'That payment had already been used. Nothing extra was spent. Call again to sign a fresh one.',
  },
  FACILITATOR_UNAVAILABLE: {
    retryable: true,
    guidance:
      'The GoPlausible facilitator could not be reached to settle. Nothing was charged. Retry in a minute.',
  },
  DOCUMENT_UNAVAILABLE: {
    retryable: false,
    guidance: 'The markdown methodology document is not deployed here. Request the JSON form instead.',
  },
};

const BY_STATUS: Record<number, CodeRule> = {
  400: { retryable: false, guidance: 'Malformed request. Nothing was charged.' },
  402: {
    retryable: false,
    guidance:
      'The payment itself was rejected. The usual causes, in order of likelihood: the payer account holds too ' +
      'little USDC; the payer account is not opted in to the USDC ASA (an account that is not opted in cannot ' +
      'hold the asset, and every payment fails); or ALGOTERMINAL_NETWORK does not match the deployment. ' +
      'Call algoterminal_spend to check the payer address and balance.',
  },
  404: { retryable: false, guidance: 'Not found. Nothing was charged.' },
  409: { retryable: true, guidance: 'Payment state conflict. Nothing was settled; call again.' },
  422: { retryable: false, guidance: 'The request could not be answered as asked. Nothing was charged.' },
  429: { retryable: true, guidance: 'Rate limited. Wait and retry; nothing was charged.' },
  500: { retryable: true, guidance: 'Server error. Nothing was charged. Retry.' },
  502: { retryable: true, guidance: 'The service could not produce an answer it stands behind. Nothing was charged.' },
  503: {
    retryable: false,
    guidance:
      'This route is not available on this deployment. Call algoterminal_catalog (free) and check ' +
      '`routes[].available` — a listed route is not necessarily a callable one.',
  },
  504: {
    retryable: true,
    guidance:
      'The handler outlived the payment window — a slow upstream, usually on a `fresh=true` or an ' +
      '`active_users_24h` call. The payment was never settled, so this cost nothing. Retry; if it happens ' +
      'again, drop `fresh` and take the cached number.',
  },
};

const FALLBACK: CodeRule = {
  retryable: false,
  guidance: 'Unrecognized error. Nothing was charged, because the service settles payment only after a 2xx.',
};

export function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const err = (body as { error?: unknown }).error;
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

export function mapError(status: number, body: unknown): MappedError {
  const envelope = isErrorEnvelope(body) ? body.error : null;
  const code = envelope?.code ?? `HTTP_${status}`;
  const message =
    envelope?.message ??
    (typeof body === 'string' && body !== '' ? body : `The service returned HTTP ${status} with no error envelope.`);

  const rule = BY_CODE[code] ?? BY_STATUS[status] ?? FALLBACK;

  return {
    status,
    code,
    message,
    detail: envelope?.detail ?? {},
    // AlgoTerminal settles payment only after a successful response (API_SPEC §2.3).
    // A non-2xx is therefore never billed, whatever went wrong.
    charged: false,
    retryable: rule.retryable,
    guidance: rule.guidance,
  };
}

/** The human-facing rendering of a mapped error. */
export function renderError(err: MappedError): string {
  const lines: string[] = [
    `ERROR ${err.status} ${err.code}`,
    '',
    err.message,
    '',
    'YOU WERE NOT CHARGED. AlgoTerminal settles payment only after a successful response, so this ' +
      'request cost 0.000000 USDC.',
    '',
    `WHAT TO DO: ${err.guidance}`,
  ];

  const reason = err.detail.reason;
  if (typeof reason === 'string' && reason !== '') {
    lines.push('', 'THE SERVICE\'S STATED REASON (report this verbatim; it is the answer, not an excuse):', reason);
  }

  const available = err.detail.available_kpis;
  if (Array.isArray(available) && available.length > 0) {
    lines.push('', `KPIs this protocol does publish: ${available.join(', ')}`);
  }

  const reasons = err.detail.reasons;
  if (typeof reasons === 'object' && reasons !== null && !Array.isArray(reasons)) {
    const entries = Object.entries(reasons as Record<string, unknown>);
    if (entries.length > 0) {
      lines.push('', 'PER-PROTOCOL REASONS:');
      for (const [protocol, why] of entries) lines.push(`  ${protocol}: ${String(why)}`);
    }
  }

  const otherDetail = Object.fromEntries(
    Object.entries(err.detail).filter(([k]) => k !== 'reason' && k !== 'available_kpis' && k !== 'reasons'),
  );
  if (Object.keys(otherDetail).length > 0) {
    lines.push('', `DETAIL: ${JSON.stringify(otherDetail)}`);
  }

  return lines.join('\n');
}
