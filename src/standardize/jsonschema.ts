import { z } from 'zod';

import { env } from '../config/env.js';
import {
  ASSET_ID_NOTE_RE,
  CoverageSchema,
  FactErrorSchema,
  KpiFactSchema,
  SourceRefSchema,
} from './schema.js';

/**
 * The `KpiFact` envelope as a standalone, versioned JSON Schema document.
 *
 * DATA_SCHEMA.md §2 defines the envelope; `standardize/schema.ts` is the zod
 * that enforces it; this module is the same object rendered into the one
 * format every other language can read. It exists because **the envelope is
 * the product.** PRD.md §4: "every metric arrives in the same envelope … so a
 * comparison is a field access, not a research project." That promise is only
 * worth something if a buyer can hold us to it mechanically, and a buyer
 * writing an agent in Go, Rust or Python has no way to hold zod to anything.
 *
 * ## Why this is a schema and not a client library
 *
 * PRD.md §8 rules out an SDK, and this is deliberately not one. A schema is a
 * contract artefact: it generates types in any language, validates a response
 * a bot has already received, and costs us nothing per language because there
 * is exactly one of it. A client library would be N libraries, each a place
 * the contract could rot, for a problem x402 already solved on the client
 * side. The distinction matters enough to be worth stating in code: we publish
 * what a response *is*, never how to fetch one.
 *
 * ## Why it is generated, never hand-written
 *
 * The same argument `openapi/document.ts` makes. A hand-written JSON Schema
 * would be a second definition of the envelope, and the failure mode is silent
 * — it drifts, a buyer generates types from it, and their deserializer breaks
 * on a field we added or a refinement we tightened. `test/standardize/
 * jsonschema.test.ts` fails if the emitted document stops matching the
 * checked-in artefact, so drift is a red build rather than a buyer's bug
 * report.
 */

type JsonObject = Record<string, unknown>;

/**
 * The path this document is served from. Stable, free, and never versioned in
 * the URL.
 *
 * A versioned path (`/schema/kpi-fact-1.2.0.json`) was the obvious alternative
 * and is rejected: it would make every buyer's integration name a version they
 * then have to remember to bump, and it would advertise archived documents we
 * do not actually keep. The version travels *inside* the document instead —
 * see {@link SCHEMA_VERSION_KEY} — so a copy saved to disk still says which
 * methodology it describes, and §7 of DATA_SCHEMA.md governs what a bump may
 * change. One URL that is always current is a promise we can keep; a shelf of
 * archived URLs is one we cannot.
 */
export const KPI_FACT_SCHEMA_PATH = '/schema/kpi-fact.json';

/**
 * The extension keyword carrying `methodology_version`.
 *
 * `x-` prefixed because JSON Schema 2020-12 ignores unknown keywords but
 * OpenAPI tooling conventionally understands the prefix, and because an
 * un-prefixed `version` would collide with nothing today and something later.
 */
export const SCHEMA_VERSION_KEY = 'x-methodology-version';

/**
 * The base URL baked into the checked-in artefact at {@link ARTEFACT_PATH}.
 *
 * Pinned so the snapshot does not change when a developer's `PUBLIC_BASE_URL`
 * does — a drift test that fails because someone ran it with a different
 * environment is a test people learn to ignore. The SERVED document always
 * carries the real base URL of the deployment serving it.
 */
export const SCHEMA_ARTEFACT_BASE_URL = 'https://api-testnet-production-a3ec.up.railway.app';

/** The checked-in copy, repo-relative. Written by `npm run schema:emit`. */
export const ARTEFACT_PATH = 'docs/kpi-fact.schema.json';

/**
 * The definitions the envelope refers to, rendered as `$defs`.
 *
 * `KpiFact` is the entry point; the other three are only ever reached through
 * it. Emitting them as `$defs` of one self-contained document rather than as
 * four retrievable URLs keeps the artefact a single file a buyer can vendor,
 * which is what a code generator wants and what an offline validator needs.
 */
const DEFS = {
  SourceRef: SourceRefSchema,
  Coverage: CoverageSchema,
  FactError: FactErrorSchema,
} as const satisfies Record<string, z.ZodType>;

/**
 * Render the zod tree to JSON Schema draft 2020-12.
 *
 * A registry, for the same reason `openapi/document.ts` uses one: it makes
 * `KpiFact` reference `#/$defs/SourceRef` instead of inlining the whole
 * SourceRef object at every use site, which is both smaller and what a
 * generator needs to emit one named type rather than four anonymous ones.
 *
 * `io: 'output'` is load-bearing. The envelope is something we *emit*, so the
 * document must describe what a caller will receive. On an input rendering zod
 * would describe what it will accept, and for schemas carrying defaults or
 * transforms those are different documents — publishing the wrong one would
 * hand a buyer a validator that rejects our own responses.
 */
function render(): { root: JsonObject; defs: Record<string, JsonObject> } {
  const registry = z.registry<{ id: string }>();
  registry.add(KpiFactSchema, { id: 'KpiFact' });
  for (const [id, schema] of Object.entries(DEFS)) registry.add(schema, { id });

  const rendered = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io: 'output',
    uri: (id) => (id === 'KpiFact' ? '#' : `#/$defs/${id}`),
  }).schemas as Record<string, JsonObject>;

  const strip = (schema: JsonObject): JsonObject => {
    // `$schema` and `$id` are set once on the document below; leaving zod's
    // copies on every subschema would re-declare the dialect three times and
    // announce `$id`s that resolve to nothing.
    const { $schema, $id, ...rest } = schema;
    void $schema;
    void $id;
    return rest;
  };

  const { KpiFact, ...others } = rendered;
  // The registry was populated with KpiFact two lines above, so this is
  // unreachable — but it is the assertion that says so, rather than a `!`.
  if (KpiFact === undefined) throw new Error('zod did not render KpiFact into the registry');
  return {
    root: strip(KpiFact),
    defs: Object.fromEntries(Object.entries(others).map(([id, s]) => [id, strip(s)])),
  };
}

/**
 * The §2 cross-field rules, as JSON Schema conditionals.
 *
 * **This block is hand-written, and it has to be.** `z.toJSONSchema` renders
 * the object's SHAPE — field names, types, enums, patterns — and silently drops
 * every `superRefine`, because a refinement is arbitrary TypeScript and JSON
 * Schema has no way to express one in general. Everything the refinements in
 * `schema.ts` enforce therefore vanishes: that a `null` value is legal only
 * beside an `error`, that an estimate always carries its `estimation_method`,
 * that a fact with a value always carries its provenance block.
 *
 * Those are not incidental validations. They are DATA_SCHEMA.md §1.2 ("never
 * launder an estimate") and §1.5 ("never a plausible-looking zero") — the
 * honesty guarantees that are the reason to buy this data rather than compute
 * it badly for free. A published schema that omitted them would describe an
 * envelope strictly weaker than the one we actually emit, and would tell a
 * buyer that `{value: null}` with no error is a response we might send. It is
 * not, and the schema must not say it is.
 *
 * The cost of hand-writing them is that they could drift from the zod. That is
 * bought off in `test/standardize/jsonschema.test.ts`, which runs the same
 * corpus of valid and deliberately-invalid facts through BOTH the zod and this
 * document and requires the two to agree on every one. Drift becomes a red
 * build rather than a difference nobody notices.
 *
 * What is deliberately NOT expressed here: `Number.isFinite`. JSON has no
 * Infinity or NaN literal, so a value that survives transport is finite by
 * construction and a keyword for it would be noise.
 */
const INVARIANTS: readonly JsonObject[] = [
  {
    $comment:
      "§2: value is null ONLY on a fact carrying an error. A null with no error is the " +
      'plausible-looking zero §1.5 exists to forbid, and it must not be representable.',
    if: { properties: { value: { type: 'null' } }, required: ['value'] },
    then: { required: ['error'] },
  },
  {
    $comment:
      'The error variant: no value, no unit, and confidence exactly 0 — there is no number ' +
      'here to be confident about.',
    if: { required: ['error'] },
    then: {
      properties: {
        value: { type: 'null' },
        unit: { type: 'null' },
        confidence: { const: 0 },
      },
    },
    else: {
      $comment:
        'The success variant: every §2 provenance field is present, and `source` is non-empty ' +
        'because §1.4 makes every number reproducible.',
      required: [
        'unit',
        'as_of',
        'source',
        'cache',
        'stale',
        'coverage',
        'notes',
        'is_estimated',
      ],
      properties: {
        unit: { not: { type: 'null' } },
        source: { minItems: 1 },
      },
    },
  },
  {
    $comment:
      '§1.2 — an estimate is never laundered as a reported value: is_estimated true and a ' +
      'documented estimation_method are inseparable.',
    if: { properties: { is_estimated: { const: true } }, required: ['is_estimated'] },
    then: {
      required: ['estimation_method'],
      properties: {
        // `\\S` rather than `minLength: 1`: the zod requires
        // `.trim().length > 0`, so a method of "   " is not a documented
        // method. The two must agree, and the corpus in the test proves it.
        estimation_method: { type: 'string', pattern: '\\S' },
      },
    },
  },
  {
    $comment: '§2 — and the converse: a reported value must not carry an estimation_method.',
    if: { properties: { is_estimated: { const: false } }, required: ['is_estimated'] },
    then: { properties: { estimation_method: { type: 'null' } } },
  },
  {
    $comment: '§2.1 — a COUNT is a non-negative integer.',
    if: { properties: { unit: { const: 'COUNT' } }, required: ['unit'] },
    then: { properties: { value: { type: 'integer', minimum: 0 } } },
  },
  {
    $comment:
      '§2.1 — an ASSET_UNITS fact must name its asset, because a raw asset amount without ' +
      'its asset id is not a number anyone can use.',
    if: { properties: { unit: { const: 'ASSET_UNITS' } }, required: ['unit'] },
    then: {
      properties: {
        notes: { contains: { type: 'string', pattern: ASSET_ID_NOTE_RE.source } },
      },
      required: ['notes'],
    },
  },
];

/**
 * The published document.
 *
 * `baseUrl` is a parameter so a test can assert the shape without the emitted
 * `$id` depending on which deployment ran it — the same reason `buildRoutes`
 * and `buildCatalog` take their network.
 */
export function buildKpiFactJsonSchema(
  baseUrl: string = env.PUBLIC_BASE_URL,
  methodologyVersion: string = env.METHODOLOGY_VERSION,
): JsonObject {
  const { root, defs } = render();

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${baseUrl}${KPI_FACT_SCHEMA_PATH}`,
    title: 'KpiFact',
    description:
      'The single envelope every AlgoTerminal number arrives in — from /metric, inside /compare, ' +
      "and in /ask's facts[]. A fact carries either a value with its full provenance block or an " +
      'error with value null, and the `allOf` conditionals enforce that split along with the '
      + 'rest of the DATA_SCHEMA.md §2 rules. ' +
      'RATIO values are decimal fractions, never percentages: 0.0369 means 3.69%. See ' +
      `${baseUrl}/methodology for what each field means and §7 for what a version bump may change.`,
    [SCHEMA_VERSION_KEY]: methodologyVersion,
    ...root,
    allOf: INVARIANTS,
    $defs: defs,
  };
}
