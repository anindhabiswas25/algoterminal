import { z } from 'zod';

import { KPI_IDS } from '../standardize/kpis.js';
import { KpiFactSchema } from '../standardize/schema.js';
import { ASK_FORMATS, DEPTHS } from '../routes/params.js';
import { CacheStateSchema } from '../standardize/schema.js';

/**
 * `POST /ask` — the schemas for API_SPEC.md §3.3.
 *
 * Split from the route handler because three separate things read them: the
 * handler (to shape and validate what it returns), `src/openapi/document.ts`
 * (to publish `AskRequest` / `AskResponse`), and the synthesis call itself,
 * whose structured output is constrained by {@link SynthesisOutputSchema}.
 *
 * The division of labour between the two synthesis schemas is the important
 * part of this file:
 *
 *   {@link SynthesisOutputSchema}  what the MODEL is allowed to produce.
 *                                  Prose, citations, caveats. No numbers as
 *                                  data, no facts, no confidence arithmetic.
 *   {@link AskResponseSchema}      what the CALLER receives. The model's prose
 *                                  plus `facts[]`, `plan`, `confidence` and
 *                                  `methodology_version`, all of which we
 *                                  computed and none of which the model can
 *                                  influence.
 *
 * A model that fabricates a fact envelope, a confidence score or a methodology
 * version therefore cannot: it is never asked for one, and the fields do not
 * exist in the schema it fills.
 */

/**
 * The error code for a deployment with no `ANTHROPIC_API_KEY`.
 *
 * A distinct code rather than a generic 500 so an integrator can tell "this
 * deployment does not offer /ask" from "/ask is broken" — the first is a
 * permanent property of that base URL and the second is worth retrying.
 */
export const ROUTER_NOT_CONFIGURED = 'ASK_NOT_CONFIGURED';

// ---------------------------------------------------------------------------
// The plan (the router's output)
// ---------------------------------------------------------------------------

/**
 * What KIND of question this is, which determines how the synthesis is framed.
 *
 * A small closed set on purpose. It is not a taxonomy of questions, it is the
 * set of answer shapes the data can support: one number, a ranking of the same
 * number across protocols, a ranking that spans protocol classes (the case
 * DATA_SCHEMA.md §3 exists for, and the one that needs the comparability
 * caveat), or several different KPIs about one protocol.
 */
export const COMPARISON_TYPES = [
  'single_metric_lookup',
  'multi_metric_profile',
  'cross_protocol_ranking',
  'cross_class_comparison',
] as const;
export type ComparisonType = (typeof COMPARISON_TYPES)[number];
export const ComparisonTypeSchema = z.enum(COMPARISON_TYPES);

/**
 * The routed plan — §3.3's `plan` block.
 *
 * `protocols` and `kpis` are enums drawn from the registry rather than free
 * strings. That is the cost guard and the anti-hallucination guard in one:
 * the router is given this as a tool-use schema with `strict: true`, so a plan
 * naming a protocol we do not cover is rejected by the API before it reaches
 * us, and the same schema then re-validates it here in case a future model or
 * a relaxed `strict` lets one through. Belt and braces, because the braces are
 * a network hop away and the belt costs a microsecond.
 */
export const PlanSchema = z.strictObject({
  protocols: z.array(z.string().min(1)).min(1),
  kpis: z.array(z.enum(KPI_IDS)).min(1),
  comparison_type: ComparisonTypeSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

// ---------------------------------------------------------------------------
// The synthesis output (what the model is allowed to write)
// ---------------------------------------------------------------------------

/**
 * One claim in the prose, tied to the fact it rests on.
 *
 * `fact_index` indexes `facts[]` in the response. It is validated against the
 * array's length before the response goes out: a citation pointing past the
 * end of `facts[]` is a citation to nothing, which is worse than no citation
 * because it looks checkable.
 */
export const CitationSchema = z.strictObject({
  claim: z.string().min(1),
  fact_index: z.number().int().min(0),
});
export type Citation = z.infer<typeof CitationSchema>;

/**
 * The structured output the synthesis call is constrained to.
 *
 * Note what is absent: `facts`, `confidence`, `methodology_version`,
 * `timestamp`, `plan`. Every one of those is ours, and a schema that let the
 * model write them would eventually get a plausible-looking
 * `"confidence": 0.95` on an answer built from a 0.4 fact.
 */
export const SynthesisOutputSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(CitationSchema),
  caveats: z.array(z.string()),
});
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

// ---------------------------------------------------------------------------
// The response (§3.3)
// ---------------------------------------------------------------------------

/** Which model played which role. Published so an answer is attributable. */
export const AskModelsSchema = z.strictObject({
  router: z.string().min(1),
  synthesizer: z.string().min(1),
});

export const AskResponseSchema = z.strictObject({
  question: z.string().min(1),
  /**
   * The prose. Empty string when `format: "facts"` — the caller asked for the
   * data without the narrative, and `""` says that unambiguously where a
   * missing key would look like a bug.
   */
  answer: z.string(),
  /**
   * Every fact the answer is grounded in, as full §2 envelopes.
   *
   * ALWAYS present, including under `format: "prose"` (§3.3). The prose is a
   * convenience layer over the data, never a substitute for it, and an agent
   * that wants to ignore our narrative and read the numbers must never have to
   * make a second paid call to do it.
   */
  facts: z.array(KpiFactSchema),
  plan: PlanSchema,
  citations: z.array(CitationSchema),
  /** §5 composite rule: the MINIMUM across the facts, never the mean. */
  confidence: z.number().min(0).max(1),
  caveats: z.array(z.string()),
  methodology_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  model: AskModelsSchema,
  timestamp: z.iso.datetime(),
  /** Echoed so a caller can see which price it paid and what it asked for. */
  depth: z.enum(DEPTHS),
  format: z.enum(ASK_FORMATS),
  /**
   * The worst cache state across the underlying facts, or `hit` when the whole
   * synthesis came from the §6 `/ask` cache.
   *
   * Reported for the same reason every other route reports it: freshness is
   * part of the response contract, not something in our logs.
   */
  cache: CacheStateSchema,
});

export type AskResponse = z.infer<typeof AskResponseSchema>;
