import { z } from 'zod';

import { KPI_IDS, type KpiId } from './kpis.js';
import {
  ASSET_ID_NOTE_RE,
  COVERAGE_BASES,
  PROTOCOL_CLASSES,
  UNITS,
  type Unit,
} from './types.js';

export { ASSET_ID_NOTE_RE, assetIdNote, readAssetIdNote, UNITS, PROTOCOL_CLASSES } from './types.js';
export type { Basis, CoverageBasis, ProtocolClass, Unit } from './types.js';
export type { KpiId } from './kpis.js';

/**
 * DATA_SCHEMA.md §2 — the `KpiFact` envelope.
 *
 * Every value the API emits — from `/metric`, inside `/compare`, and in
 * `/ask`'s `facts[]` — is this object. There is exactly one shape, and this
 * file is the only place it is defined. TypeScript types are derived with
 * `z.infer`; there is deliberately no hand-written parallel interface to drift
 * out of sync with the validator.
 */

// ---------------------------------------------------------------------------
// §2.1 units / §2.2 classes
// ---------------------------------------------------------------------------

export const UnitSchema = z.enum(UNITS);
export const ProtocolClassSchema = z.enum(PROTOCOL_CLASSES);
export const CoverageBasisSchema = z.enum(COVERAGE_BASES);

// ---------------------------------------------------------------------------
// SourceRef — §2 `source[]`, §1.4 reproducibility
// ---------------------------------------------------------------------------

/** How the number reached us. `derived` means computed from other facts. */
export const SOURCE_KINDS = ['rest', 'onchain', 'derived'] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * One upstream read. §1.4: "Every number is reproducible" — a buyer can take
 * a `SourceRef` and re-derive our number.
 *
 * The `onchain` refinement is load-bearing rather than decorative:
 * CONNECTOR_GUIDE §4.2 states that an on-chain number without a round is not
 * reproducible, and reproducibility is a stated product guarantee. So a
 * `kind: 'onchain'` ref that omits `app_id` or `round` fails validation here
 * rather than being documented and then forgotten.
 */
export const SourceRefSchema = z
  .object({
    /** Short stable label, e.g. "tinyman-analytics", "algod". */
    name: z.string().min(1),
    /** Exact upstream URL read, including query string. */
    url: z.url(),
    kind: SourceKindSchema,
    retrieved_at: z.iso.datetime(),
    /** Algorand application id. Required when `kind` is 'onchain'. */
    app_id: z.number().int().nonnegative().optional(),
    /** Ledger round the state was read at. Required when `kind` is 'onchain'. */
    round: z.number().int().nonnegative().optional(),
  })
  .superRefine((ref, ctx) => {
    if (ref.kind !== 'onchain') return;
    if (ref.app_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['app_id'],
        message: "app_id is required when kind is 'onchain' (CONNECTOR_GUIDE §4.2)",
      });
    }
    if (ref.round === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['round'],
        message:
          "round is required when kind is 'onchain': an on-chain number without a round is not reproducible (CONNECTOR_GUIDE §4.2)",
      });
    }
  });

export type SourceRef = z.infer<typeof SourceRefSchema>;

// ---------------------------------------------------------------------------
// Coverage — §2, populated per §3.6
// ---------------------------------------------------------------------------

/**
 * What the aggregate actually covers. Publishing `entities`/`excluded` is what
 * lets a buyer see that a TVL figure skipped 7 unpriced pools instead of
 * silently valuing them at zero.
 */
export const CoverageSchema = z.object({
  /** Pools / markets included in the aggregate. */
  entities: z.number().int().nonnegative(),
  /** Entities dropped by the §3.6 filters. */
  excluded: z.number().int().nonnegative(),
  basis: CoverageBasisSchema,
});

export type Coverage = z.infer<typeof CoverageSchema>;

// ---------------------------------------------------------------------------
// FactError — the §2 error-fact payload
// ---------------------------------------------------------------------------

/** `code` is stable across versions (API_SPEC §5); `message` is not. */
export const FactErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be UPPER_SNAKE'),
  message: z.string().min(1),
});

export type FactError = z.infer<typeof FactErrorSchema>;

// ---------------------------------------------------------------------------
// KpiFact
// ---------------------------------------------------------------------------

export const CACHE_STATES = ['hit', 'miss', 'stale'] as const;
export const CacheStateSchema = z.enum(CACHE_STATES);
export type CacheState = (typeof CACHE_STATES)[number];

/**
 * Fields present on every fact, successful or not. The §2 error-fact variant
 * carries exactly these plus `error`; a successful fact carries these plus the
 * full provenance block, and the refinements below enforce that split.
 */
const CommonFactShape = {
  /** KPI id, from the registry in §4. */
  metric: z.enum(KPI_IDS),
  /** Protocol id, from the connector registry. */
  protocol: z.string().min(1),
  /** number | null. `null` ONLY with an `error` field. */
  value: z.number().finite().nullable(),
  /** §2.1. `null` only on an error fact, where there is no value to carry one. */
  unit: UnitSchema.nullable(),
  /** When WE computed it. */
  timestamp: z.iso.datetime(),
  confidence: z.number().min(0).max(1),
  methodology_version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be semver, e.g. 1.0.0'),
} as const;

/**
 * The canonical validator for anything shaped like a fact — success or error.
 *
 * The provenance fields are declared optional here and then *required by
 * refinement* when `error` is absent, because that is the only way to express
 * §2's two variants in one schema while still producing a precise message for
 * each violated rule instead of a union's pile of branch errors.
 */
export const KpiFactSchema = z
  .strictObject({
    ...CommonFactShape,
    /** Present only on the error variant. Its presence is what makes it one. */
    error: FactErrorSchema.optional(),

    /** What moment the DATA describes (as opposed to when we computed it). */
    as_of: z.iso.datetime().optional(),
    /** Provenance, one entry per upstream read. Never empty on a real value. */
    source: z.array(SourceRefSchema).optional(),
    /** §1.2 — anything not directly reported by the source. */
    is_estimated: z.boolean().optional(),
    /** Required non-empty string when `is_estimated` is true; else null. */
    estimation_method: z.string().nullable().optional(),
    cache: CacheStateSchema.optional(),
    stale: z.boolean().optional(),
    coverage: CoverageSchema.optional(),
    /** Human/agent-readable caveats. Present (possibly empty) on every value. */
    notes: z.array(z.string()).optional(),
  })
  .superRefine((fact, ctx) => {
    const require = (path: string, ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message });
    };

    // §2: "value: number | null. null ONLY with an error field." A null value
    // with no error is the "plausible-looking zero" §1.5 exists to forbid,
    // wearing a different hat — it must not be representable.
    if (fact.value === null && fact.error === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'value is null, which is permitted only on a fact carrying an error object (§2)',
      });
    }

    if (fact.error !== undefined) {
      // The error variant: no value, no unit, no confidence in a non-number.
      require('value', fact.value === null, 'a fact with an error must have value null (§2)');
      require('unit', fact.unit === null, 'a fact with an error must have unit null (§2)');
      require(
        'confidence',
        fact.confidence === 0,
        'a fact with an error must have confidence 0.0 (§2)',
      );
      return;
    }

    // ---- from here down: the successful variant ----
    require('unit', fact.unit !== null, 'unit is required on a fact with a value (§2.1)');
    require('as_of', fact.as_of !== undefined, 'as_of is required on a fact with a value (§2)');
    require(
      'source',
      fact.source !== undefined && fact.source.length > 0,
      'at least one source is required: every number must be reproducible (§1.4)',
    );
    require('cache', fact.cache !== undefined, 'cache is required on a fact with a value (§2)');
    require('stale', fact.stale !== undefined, 'stale is required on a fact with a value (§2)');
    require(
      'coverage',
      fact.coverage !== undefined,
      'coverage is required on a fact with a value (§2)',
    );
    require('notes', fact.notes !== undefined, 'notes is required (use [] when there are none) (§2)');
    require(
      'is_estimated',
      fact.is_estimated !== undefined,
      'is_estimated is required on a fact with a value (§1.2)',
    );

    // §1.2 — "Never launder an estimate." Anything not directly reported by the
    // source is is_estimated: true WITH a documented estimation_method. Making
    // the pair inseparable in the schema is what turns that principle from a
    // convention a connector can forget into something structurally impossible.
    if (fact.is_estimated === true) {
      require(
        'estimation_method',
        typeof fact.estimation_method === 'string' && fact.estimation_method.trim().length > 0,
        'is_estimated is true, so a non-empty estimation_method is required: an estimate must never be laundered as a reported value (§1.2)',
      );
    } else if (fact.is_estimated === false) {
      require(
        'estimation_method',
        fact.estimation_method === null || fact.estimation_method === undefined,
        'estimation_method must be null when is_estimated is false (§2)',
      );
    }

    // §2.1 representation rules. `value` is already typed `number`, so a RATIO
    // can never arrive as the "0.036882" string an upstream source would hand
    // us; the assertion below is the belt to that braces, and catches the
    // non-finite results (0/0, x/0) that ratio arithmetic actually produces.
    if (fact.value !== null) {
      if (fact.unit === 'RATIO') {
        require(
          'value',
          typeof fact.value === 'number' && Number.isFinite(fact.value),
          'a RATIO value must be a finite number, never a string and never a percent: 0.0369 means 3.69% (§2.1)',
        );
      }
      if (fact.unit === 'COUNT') {
        require(
          'value',
          Number.isInteger(fact.value) && fact.value >= 0,
          'a COUNT value must be a non-negative integer (§2.1)',
        );
      }
      if (fact.unit === 'ASSET_UNITS') {
        require(
          'notes',
          (fact.notes ?? []).some((n) => ASSET_ID_NOTE_RE.test(n)),
          'an ASSET_UNITS fact must name its asset: notes must contain an "asset_id: <id>" entry (§2.1)',
        );
      }
    }
  });

/**
 * A fact as it goes out over the wire. Derived from the zod schema — never
 * hand-written, so the validator and the type cannot disagree.
 */
export type KpiFact = z.infer<typeof KpiFactSchema>;

/**
 * The §2 error-fact variant, narrowed. Used inside `/compare` so one bad
 * protocol doesn't fail the whole call.
 */
export const ErrorFactSchema = z.strictObject({
  metric: z.enum(KPI_IDS),
  protocol: z.string().min(1),
  value: z.null(),
  unit: z.null(),
  timestamp: z.iso.datetime(),
  error: FactErrorSchema,
  confidence: z.literal(0),
  methodology_version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export type ErrorFact = z.infer<typeof ErrorFactSchema>;

/** A fact carrying an actual value: every §2 provenance field is present. */
export type SuccessFact = KpiFact & {
  value: number;
  unit: Unit;
  as_of: string;
  source: SourceRef[];
  is_estimated: boolean;
  cache: CacheState;
  stale: boolean;
  coverage: Coverage;
  notes: string[];
};

/** Narrow a validated fact to its error variant. */
export function isErrorFact(fact: KpiFact): fact is KpiFact & { error: FactError; value: null } {
  return fact.error !== undefined;
}

/** Narrow a validated fact to its success variant. */
export function isSuccessFact(fact: KpiFact): fact is SuccessFact {
  return fact.error === undefined;
}

/**
 * Build the §2 error-fact shape.
 *
 * `confidence` is 0 by construction rather than by argument: there is no number
 * here to be confident about, and letting a caller pass one would eventually
 * produce a 0.9-confidence failure.
 */
export function makeErrorFact(args: {
  metric: KpiId;
  protocol: string;
  code: string;
  message: string;
  methodologyVersion: string;
  /** Injected so callers stay deterministic and testable (CONNECTOR_GUIDE §1). */
  timestamp: string;
}): ErrorFact {
  return ErrorFactSchema.parse({
    metric: args.metric,
    protocol: args.protocol,
    value: null,
    unit: null,
    timestamp: args.timestamp,
    error: { code: args.code, message: args.message },
    confidence: 0,
    methodology_version: args.methodologyVersion,
  });
}

/** Parse-and-throw. Use at the boundary where a malformed fact must not escape. */
export function parseKpiFact(input: unknown): KpiFact {
  return KpiFactSchema.parse(input);
}

/** Non-throwing variant, for validating a batch without losing the good ones. */
export function safeParseKpiFact(input: unknown) {
  return KpiFactSchema.safeParse(input);
}
