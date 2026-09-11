import { z } from 'zod';

import { listProtocolIds } from '../connectors/registry.js';
import { ApiError } from '../errors.js';
import { KPI_IDS } from '../standardize/kpis.js';
import { BASES, DEFAULT_BASIS } from '../standardize/types.js';

/**
 * Request parameter schemas — the single declaration of every input the API
 * accepts.
 *
 * API_SPEC.md §4: "the implementation generates the full document from the same
 * zod schemas that validate requests, so spec and behavior cannot diverge."
 * This module is what makes that sentence true rather than aspirational. Each
 * schema below is read twice:
 *
 *   - by the route handler, to validate an incoming request;
 *   - by `src/openapi/document.ts`, to render the parameter's `schema` block.
 *
 * A new allowed `?basis=` value is therefore one edit here and it appears in
 * both the validator and the published spec. The alternative — a hand-written
 * OpenAPI file next to hand-written parsers — is the single most likely place
 * in an API for the documentation to be quietly wrong, because nothing fails
 * when it is.
 *
 * ## Why the parsers are still hand-written around the schemas
 *
 * `zod`'s own error messages are not our error envelope. API_SPEC.md §5 fixes
 * the envelope (`{ error: { code, message, detail } }`) and §3.1 fixes what
 * `detail` must carry: the list of values that would have worked, so a caller
 * can fix its request without a second round trip. So the schema owns the
 * *set* of valid values and the parser owns the *response* to an invalid one.
 * The set is never retyped, which is the property that matters.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** `?basis=` — DATA_SCHEMA.md §3.6 inclusion basis. */
export const BasisSchema = z.enum(BASES);

/**
 * A boolean carried in a query string.
 *
 * `"1"`/`"0"` are accepted alongside `"true"`/`"false"` because they were
 * already accepted before this module existed and an agent that integrated
 * against that behaviour must keep working. They are deliberately NOT
 * advertised in the OpenAPI `enum` — see {@link BooleanQueryOpenApiEnum}.
 */
export const BooleanQuerySchema = z.enum(['true', 'false', '1', '0']);

/**
 * What `/openapi.json` publishes for a boolean query parameter.
 *
 * Narrower than what we accept, on purpose. A published enum is a promise
 * about what an agent should *send*; `"1"` is a legacy spelling we honour but
 * would not recommend, and advertising four spellings for a boolean invites a
 * client to pick one at random. Accept broadly, publish narrowly.
 */
export const BooleanQueryOpenApiEnum = ['true', 'false'] as const;

/** A KPI id from the DATA_SCHEMA.md §4 registry. */
export const KpiIdSchema = z.enum(KPI_IDS);

/**
 * A protocol id, from the LIVE connector registry.
 *
 * Built at call time rather than as a module constant so that registering
 * connector #4 changes `/openapi.json` with no edit here — the same property
 * `/catalog` has (`src/routes/catalog.ts`). The cast is safe because
 * `listProtocolIds()` is non-empty for any registry that passed boot
 * validation; an empty registry is a service that sells nothing, and the guard
 * below turns that into a coherent (if useless) schema rather than a throw at
 * import time.
 */
export function protocolIdSchema(): z.ZodEnum<Record<string, string>> {
  const ids = listProtocolIds();
  return z.enum(ids.length === 0 ? ['__none__'] : (ids as [string, ...string[]]));
}

/** `?protocols=a,b,c` — the raw CSV. Bounds are checked after de-duplication. */
export const ProtocolsCsvSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// /ask (API_SPEC.md §3.3)
// ---------------------------------------------------------------------------

/** §3.3: "> 500 chars" is a 400 `QUESTION_TOO_LONG`. */
export const MAX_QUESTION_CHARS = 500;

/** §3.3 `depth`. Priced: `standard` $0.15, `deep` $0.20 (`src/pricing.ts`). */
export const DEPTHS = ['standard', 'deep'] as const;
export type Depth = (typeof DEPTHS)[number];
export const DepthSchema = z.enum(DEPTHS);

/** §3.3 `format`. `facts[]` is returned under all three (see `src/routes/ask.ts`). */
export const ASK_FORMATS = ['prose', 'facts', 'both'] as const;
export type AskFormat = (typeof ASK_FORMATS)[number];
export const AskFormatSchema = z.enum(ASK_FORMATS);

/** §3.3 `max_facts`: 1-24, default 12. */
export const MIN_MAX_FACTS = 1;
export const MAX_MAX_FACTS = 24;
export const DEFAULT_MAX_FACTS = 12;

/**
 * The `POST /ask` request body, exactly as §3.3 specifies it.
 *
 * `strictObject` rather than `object`: an unknown key is a caller bug we can
 * name for free at the boundary, and silently ignoring `{"depth_": "deep"}`
 * would charge $0.15 for a standard answer to a request that asked for a deep
 * one. This is also the schema `/openapi.json` renders `AskRequest` from.
 *
 * `depth` is present here for schema completeness and is validated against the
 * query parameter the payment was quoted on — see `src/routes/ask.ts`.
 */
export const AskRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  depth: DepthSchema.optional(),
  max_facts: z.number().int().min(MIN_MAX_FACTS).max(MAX_MAX_FACTS).optional(),
  format: AskFormatSchema.optional(),
});

export type AskRequestInput = z.infer<typeof AskRequestSchema>;

// ---------------------------------------------------------------------------
// Parsers — schema-backed, but speaking API_SPEC.md §5's envelope
// ---------------------------------------------------------------------------

/**
 * `?basis=` (§3.1), shared by `/metric` and `/compare` so both reject the same
 * strings with the same message. Whether a given PROTOCOL implements a basis is
 * a separate question, answered per-protocol in `resolveTarget`.
 */
export function parseBasis(raw: string | undefined) {
  if (raw === undefined) return DEFAULT_BASIS;
  const parsed = BasisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_PARAM', `Unknown basis "${raw}".`, {
      param: 'basis',
      provided: raw,
      allowed: [...BASES],
    });
  }
  return parsed.data;
}

/** `?fresh=` (§3.1), shared with `/compare`, where it applies to every leg. */
export function parseFresh(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const parsed = BooleanQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_PARAM', `fresh must be true or false, got "${raw}".`, {
      param: 'fresh',
      provided: raw,
    });
  }
  return parsed.data === 'true' || parsed.data === '1';
}
