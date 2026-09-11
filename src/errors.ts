import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

/**
 * The single error envelope from API_SPEC.md §5:
 *   { "error": { "code": "UPPER_SNAKE", "message": "...", "detail": {...} } }
 * Codes are stable across versions; messages are not.
 */
/**
 * The envelope, as zod.
 *
 * Added with `/openapi.json`: the published `ErrorEnvelope` component is
 * generated from this, and a test asserts that every error this service
 * actually emits parses under it. §5 promises that error *codes* are stable
 * across versions, and a promise about a shape nothing checks is a promise
 * about a shape that will change.
 */
export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    /** UPPER_SNAKE, stable across versions. */
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** Human-readable. NOT stable across versions; do not match on it. */
    message: z.string(),
    detail: z.record(z.string(), z.unknown()),
  }),
});

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function envelope(
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): ErrorEnvelope {
  return { error: { code, message, detail } };
}

export function errorResponse(c: Context, err: ApiError) {
  return c.json(envelope(err.code, err.message, err.detail), err.status);
}
