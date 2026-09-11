import { env } from '../config/env.js';
import {
  CONFIDENCE_DIRECTIONAL,
  CONFIDENCE_SAFE_TO_ACT,
  confidenceTier,
} from '../standardize/confidence.js';
import { getKpi, type KpiId } from '../standardize/kpis.js';
import { isSuccessFact, type KpiFact, type SuccessFact } from '../standardize/schema.js';
import type { Citation, Plan, SynthesisOutput } from './schema.js';
import type { UnavailablePair } from './capabilities.js';

/**
 * Grounding — the part of `/ask` that is enforced rather than prompted.
 *
 * API_SPEC.md §3.3 makes four guarantees about the prose. A system prompt can
 * *ask* for all four; none of them is a guarantee until something fails when
 * they are broken. This module is that something, and the route treats a
 * violation as a reason to retry once and then return 502 unpaid — we would
 * rather deliver nothing and take no money than sell a paragraph containing a
 * number we cannot point at.
 *
 * | §3.3 guarantee | Enforced by |
 * |---|---|
 * | Every numeric claim corresponds to a `KpiFact` | {@link groundingViolations} |
 * | `facts[]` always returned | the response schema, not this file |
 * | No forecasting / advice | the router's `decline` tool, before we spend |
 * | `confidence < 0.7` explicitly caveated in prose | {@link lowConfidenceViolations} |
 *
 * Plus one this project added, because Pact made it necessary:
 * a KPI a protocol *declines* must be named in the answer, not omitted
 * ({@link silentOmissionViolations}).
 *
 * ## The rule the number check actually implements
 *
 * > Every number in the prose must appear somewhere in the JSON we handed the
 * > model, or be a documented rendering of a fact's value.
 *
 * "Somewhere in the JSON" is deliberate and broad: it covers a metric id that
 * contains `24`, a timestamp that contains `2026`, a coverage count, a
 * confidence score, and the `365` inside `capital_efficiency`'s own
 * definition. Those are all numbers we *gave* the model, and a rule that
 * rejected them would fail on correct prose, which is the fastest way to get a
 * guard switched off.
 *
 * "A documented rendering" is deliberately narrow: a rounding, a percentage, a
 * thousands/millions/basis-points scaling, or the ratio between two facts of
 * the same metric. Those are the transformations a reader expects prose to
 * make. Sums, differences and averages are NOT included, and the system prompt
 * forbids them, so "Tinyman earned $300 more than Pact" fails even though both
 * operands are present.
 */

// ---------------------------------------------------------------------------
// The payload the synthesizer sees — and the exact basis for the number rule
// ---------------------------------------------------------------------------

export interface GroundedFact {
  /** Index into `facts[]`, which is what `citations[].fact_index` points at. */
  readonly index: number;
  readonly protocol: string;
  readonly protocol_name: string;
  readonly protocol_class: string;
  readonly metric: KpiId;
  readonly definition: string;
  readonly value: number;
  readonly unit: string;
  /** A pre-formatted rendering, so the easy path is also the correct one. */
  readonly display: string;
  readonly confidence: number;
  readonly confidence_tier: string;
  readonly is_estimated: boolean;
  readonly estimation_method: string | null;
  readonly as_of: string;
  readonly cache: string;
  readonly stale: boolean;
  readonly coverage: { entities: number; excluded: number; basis: string } | null;
  readonly notes: readonly string[];
}

export interface UnavailableEntry {
  readonly protocol: string;
  readonly protocol_name: string;
  readonly metric: string;
  readonly reason: string;
  readonly declined: boolean;
}

export interface GroundingPayload {
  readonly question: string;
  readonly plan: Plan;
  readonly methodology: {
    readonly version: string;
    readonly url: string;
    readonly confidence_ladder: {
      readonly safe_to_act: string;
      readonly directional: string;
      readonly informational: string;
    };
  };
  readonly facts: readonly GroundedFact[];
  readonly unavailable: readonly UnavailableEntry[];
}

/** Thousands separators, matching the `display` strings we hand the model. */
function withSeparators(n: number, fractionDigits: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * How a value should read in prose.
 *
 * Provided per fact so that copying the `display` string verbatim is both the
 * least effort and the correct behaviour. A guard that is easy to satisfy
 * correctly gets satisfied correctly.
 */
export function displayValue(value: number, unit: string): string {
  if (unit === 'USD') return `$${withSeparators(value, 2)}`;
  if (unit === 'RATIO') {
    const pct = Math.round(value * 100 * 100) / 100;
    return `${value} (${pct}%)`;
  }
  if (unit === 'COUNT') return withSeparators(value, 0);
  return String(value);
}

export function toGroundedFact(
  fact: SuccessFact,
  index: number,
  protocolName: string,
  protocolClass: string,
): GroundedFact {
  return {
    index,
    protocol: fact.protocol,
    protocol_name: protocolName,
    protocol_class: protocolClass,
    metric: fact.metric,
    definition: getKpi(fact.metric).description,
    value: fact.value,
    unit: fact.unit,
    display: displayValue(fact.value, fact.unit),
    confidence: fact.confidence,
    confidence_tier: confidenceTier(fact.confidence),
    is_estimated: fact.is_estimated,
    estimation_method: fact.estimation_method ?? null,
    as_of: fact.as_of,
    cache: fact.cache,
    stale: fact.stale,
    coverage: fact.coverage ?? null,
    notes: [...fact.notes],
  };
}

export function buildGroundingPayload(args: {
  question: string;
  plan: Plan;
  facts: readonly GroundedFact[];
  unavailable: readonly UnavailableEntry[];
}): GroundingPayload {
  return {
    question: args.question,
    plan: args.plan,
    methodology: {
      version: env.METHODOLOGY_VERSION,
      url: `${env.PUBLIC_BASE_URL}/methodology`,
      confidence_ladder: {
        safe_to_act: `>= ${CONFIDENCE_SAFE_TO_ACT} — safe to act on`,
        directional: `${CONFIDENCE_DIRECTIONAL} to ${CONFIDENCE_SAFE_TO_ACT} — directionally sound; check notes`,
        informational: `< ${CONFIDENCE_DIRECTIONAL} — informational only, and you MUST caveat it in prose`,
      },
    },
    facts: args.facts,
    unavailable: args.unavailable,
  };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A number token in prose: an optional sign, digits with optional thousands
 * separators, an optional fraction.
 *
 * `-?` is included so "-6.6%" is checked rather than read as "6.6". Currency
 * symbols, `%` and `x` are not part of the token — they are formatting around
 * a number we still have to account for.
 */
const NUMBER_TOKEN = /-?\d[\d,]*(?:\.\d+)?/g;

/** Every number written in a piece of prose, in order. */
export function extractNumbers(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (Number.isFinite(value)) found.push(value);
  }
  return found;
}

/**
 * Round to a fixed grid so that `0.0754 * 100` and the literal `7.54` are the
 * same member of the allowed set.
 *
 * Without this, every derived value would carry float noise
 * (`7.540000000000001`) and never match a number a human or model would write.
 */
function canonical(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

const ROUNDING_PLACES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The scalings prose is allowed to apply to a value.
 *
 * Percent and basis points for ratios; thousands, millions and billions for
 * money. All of them are *renderings of one value*, not arithmetic across
 * values, which is the line this whole module draws.
 */
const SCALINGS = [1, 100, 10_000, 1 / 1_000, 1 / 1_000_000, 1 / 1_000_000_000];

function addRenderings(allowed: Set<number>, value: number): void {
  for (const scale of SCALINGS) {
    const scaled = value * scale;
    allowed.add(canonical(scaled));
    for (const places of ROUNDING_PLACES) {
      const factor = 10 ** places;
      allowed.add(canonical(Math.round(scaled * factor) / factor));
    }
  }
}

/** Every number appearing anywhere in a JSON-able value, including inside strings. */
function harvest(value: unknown, into: Set<number>): void {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.add(canonical(value));
    return;
  }
  if (typeof value === 'string') {
    for (const n of extractNumbers(value)) into.add(canonical(n));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) harvest(item, into);
  }
}

/**
 * Every number the prose is permitted to contain.
 *
 * Three sources, in the order they matter:
 *
 *  1. **Everything in the payload**, including inside strings. These are
 *     numbers we handed the model; repeating one back is quotation, not
 *     invention.
 *  2. **Renderings of each fact's value** — roundings, percent, bps, k/M/B.
 *  3. **Ratios between two facts of the SAME metric**, and their roundings.
 *     "3.9x" is the one derived quantity a comparison genuinely needs, and it
 *     is what `/compare` already publishes as `spread.ratio`. Cross-metric
 *     ratios are excluded: dividing a TVL by a take rate produces a number
 *     with no meaning, and allowing it would open the door the rule closes.
 *
 * Sums, differences and averages are deliberately absent.
 */
export function allowedNumbers(payload: GroundingPayload): Set<number> {
  const allowed = new Set<number>();
  harvest(payload, allowed);

  for (const fact of payload.facts) addRenderings(allowed, fact.value);

  const byMetric = new Map<string, number[]>();
  for (const fact of payload.facts) {
    const list = byMetric.get(fact.metric) ?? [];
    list.push(fact.value);
    byMetric.set(fact.metric, list);
  }
  for (const values of byMetric.values()) {
    for (const a of values) {
      for (const b of values) {
        if (b === 0) continue;
        addRenderings(allowed, a / b);
      }
    }
  }

  // The sizes of the thing we are describing: "across 3 protocols".
  allowed.add(payload.facts.length);
  allowed.add(payload.unavailable.length);
  allowed.add(payload.plan.protocols.length);
  allowed.add(payload.plan.kpis.length);

  return allowed;
}

export interface Violation {
  readonly kind: 'ungrounded_number' | 'uncaveated_low_confidence' | 'silent_omission' | 'bad_citation';
  readonly detail: string;
}

/**
 * Numbers in the prose that are not in the allowed set.
 *
 * This is the check API_SPEC.md §3.3 calls "no number is generated", and it is
 * the one that must fail CI when a model invents a figure.
 */
export function groundingViolations(answer: string, payload: GroundingPayload): Violation[] {
  const allowed = allowedNumbers(payload);
  const offenders = [...new Set(extractNumbers(answer).map(canonical))].filter(
    (n) => !allowed.has(n),
  );
  return offenders.map((n) => ({
    kind: 'ungrounded_number' as const,
    detail:
      `The number ${n} in your answer does not appear in the facts you were given and is not a ` +
      'rounding, percentage or same-metric ratio of one. Remove it or replace it with a value ' +
      'from facts[].',
  }));
}

/**
 * The literal marker a low-confidence fact must carry in prose.
 *
 * §3.3 requires that any fact below the §5 `directional` line is "explicitly
 * caveated in prose". "Explicitly" has to mean something checkable, so the
 * system prompt mandates this exact phrase and this function looks for it. A
 * softer check — "does the paragraph mention confidence somewhere" — would
 * pass an answer that caveats one fact and quietly ships another.
 *
 * Note the strict `<`: a fact at exactly 0.70 is `directional` on the §5
 * ladder and does not require the marker. That boundary is live — Tinyman's
 * `capital_efficiency` currently grades 0.70 — so it is asserted in the tests
 * in both directions rather than left to be discovered in production.
 */
export function lowConfidenceMarker(confidence: number): string {
  return `confidence ${confidence}`;
}

export function isLowConfidence(confidence: number): boolean {
  return confidence < CONFIDENCE_DIRECTIONAL;
}

export function lowConfidenceViolations(answer: string, payload: GroundingPayload): Violation[] {
  return payload.facts
    .filter((fact) => isLowConfidence(fact.confidence))
    .filter((fact) => !answer.includes(lowConfidenceMarker(fact.confidence)))
    .map((fact) => ({
      kind: 'uncaveated_low_confidence' as const,
      detail:
        `${fact.protocol}/${fact.metric} has confidence ${fact.confidence}, below the ` +
        `${CONFIDENCE_DIRECTIONAL} line, so it is informational only. The prose must say so ` +
        `using the exact phrase "(${lowConfidenceMarker(fact.confidence)}, informational only)" ` +
        'immediately after the number it qualifies.',
    }));
}

/**
 * A protocol whose KPI we could not supply, and which the answer never
 * mentions.
 *
 * DATA_SCHEMA.md §1.5: we decline loudly. "Which protocol has the highest take
 * rate?" must not quietly become a ranking of the two protocols that publish
 * one — a reader would take Pact's absence as evidence about Pact rather than
 * about Pact's disclosure. The check is deliberately generous about *how* the
 * answer says it (any mention of the id or the display name counts) and strict
 * about *whether* it does.
 */
export function silentOmissionViolations(answer: string, payload: GroundingPayload): Violation[] {
  const lower = answer.toLowerCase();
  const answered = new Set(payload.facts.map((f) => f.protocol));
  const seen = new Set<string>();
  const violations: Violation[] = [];

  for (const entry of payload.unavailable) {
    if (!entry.declined) continue;
    // A protocol that answered some OTHER planned KPI is already named in the
    // prose for that one, so requiring a second mention would be noise. What
    // matters is that the reader is not left with an unexplained absence.
    if (answered.has(entry.protocol) && seen.has(entry.protocol)) continue;
    const mentioned =
      lower.includes(entry.protocol.toLowerCase()) ||
      lower.includes(entry.protocol_name.toLowerCase());
    if (mentioned) {
      seen.add(entry.protocol);
      continue;
    }
    violations.push({
      kind: 'silent_omission',
      detail:
        `${entry.protocol_name} does not publish "${entry.metric}" (${entry.reason}), and your ` +
        'answer never mentions it. Say that it does not publish the value. Leaving it out reads ' +
        'as though it has none, which is a claim about the protocol rather than about its ' +
        'disclosure.',
    });
  }
  return violations;
}

/** A citation that points past the end of `facts[]` is a citation to nothing. */
export function citationViolations(
  citations: readonly Citation[],
  payload: GroundingPayload,
): Violation[] {
  return citations
    .filter((c) => c.fact_index < 0 || c.fact_index >= payload.facts.length)
    .map((c) => ({
      kind: 'bad_citation' as const,
      detail:
        `citations[].fact_index ${c.fact_index} is out of range; facts[] has ` +
        `${payload.facts.length} entries, indexed 0 to ${payload.facts.length - 1}.`,
    }));
}

/** Every check, in one call. Empty means the answer is sellable. */
export function validateSynthesis(
  output: SynthesisOutput,
  payload: GroundingPayload,
): Violation[] {
  return [
    ...groundingViolations(output.answer, payload),
    ...lowConfidenceViolations(output.answer, payload),
    ...silentOmissionViolations(output.answer, payload),
    ...citationViolations(output.citations, payload),
  ];
}

// ---------------------------------------------------------------------------
// Caveats we generate ourselves
// ---------------------------------------------------------------------------

/**
 * The caveats that must be present regardless of what the model wrote.
 *
 * Generated from the facts, then merged with the model's own. `caveats[]` is
 * part of the paid response, and a caller filtering on it must not be relying
 * on a model having remembered — the low-confidence and declined-KPI entries
 * in particular are the ones an agent's operator would want to have seen.
 */
export function generatedCaveats(payload: GroundingPayload): string[] {
  const caveats: string[] = [];

  for (const fact of payload.facts) {
    if (isLowConfidence(fact.confidence)) {
      caveats.push(
        `${fact.protocol}/${fact.metric} carries confidence ${fact.confidence}, below the ` +
          `${CONFIDENCE_DIRECTIONAL} line: informational only, not safe to act on.`,
      );
    }
    if (fact.stale) {
      caveats.push(
        `${fact.protocol}/${fact.metric} was served from cache past its TTL (as_of ${fact.as_of}); ` +
          'its confidence carries the staleness penalty.',
      );
    }
    if (fact.is_estimated && fact.estimation_method !== null) {
      caveats.push(
        `${fact.protocol}/${fact.metric} is an estimate: ${fact.estimation_method}.`,
      );
    }
  }

  for (const entry of payload.unavailable) {
    if (entry.declined) caveats.push(entry.reason);
  }

  const classes = new Set(payload.facts.map((f) => f.protocol_class));
  if (classes.size > 1) {
    caveats.push(
      'This comparison spans protocol classes. The KPIs are defined once and mapped per class ' +
        `(DATA_SCHEMA.md §3.1/§3.2); see ${payload.methodology.url} for what makes them comparable.`,
    );
  }

  return [...new Set(caveats)];
}

/** Facts that carry a value, in plan order — the array `citations` index into. */
export function successFacts(facts: readonly KpiFact[]): SuccessFact[] {
  return facts.filter(isSuccessFact);
}
