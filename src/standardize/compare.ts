import { z } from 'zod';

import { combineConfidence } from './confidence.js';
import { crossClassBasis, getKpi, type KpiId } from './kpis.js';
import {
  CacheStateSchema,
  KpiFactSchema,
  UnitSchema,
  isSuccessFact,
  type CacheState,
  type KpiFact,
  type SuccessFact,
} from './schema.js';
import { KPI_IDS } from './kpis.js';
import type { ProtocolClass, Unit } from './types.js';

/**
 * API_SPEC.md §3.2 — composing one comparison out of N already-fetched facts.
 *
 * ARCHITECTURE.md §4.2 keeps the query layer free of arithmetic, and ranking,
 * spread and confidence composition are arithmetic. They live here, next to the
 * §5 confidence rules they obey, so `src/routes/compare.ts` stays what §4.2
 * describes: parse, validate, fetch, shape.
 *
 * Nothing in this file fetches anything. `/compare` results are deliberately
 * not cached as a unit (ARCHITECTURE.md §6) — each leg goes through the normal
 * cached path and this function composes what came back — so a composite can
 * never be staler than the legs it reports, and there is no second staleness
 * surface to reason about.
 *
 * ## What this module is actually for
 *
 * The ranking is the easy part. The hard part, and the part being sold, is
 * {@link generateCaveats}: the sentences that say what a caller is and is not
 * entitled to conclude from putting a DEX and a lending market on one axis.
 * DATA_SCHEMA.md §6 uses exactly this comparison as the worked example of the
 * whole methodology, and the caveats are where that methodology becomes
 * legible to the agent quoting it to its operator.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One protocol's contribution: whatever the cached path returned for it. */
export interface ComparisonLeg {
  readonly protocol: string;
  /** From the connector registry — what makes a comparison cross-class. */
  readonly protocolClass: ProtocolClass;
  /** A §2 success fact or a §2 error fact. Both are legitimate outcomes. */
  readonly fact: KpiFact;
}

/** A leg that produced a number, narrowed. */
interface ValuedLeg extends ComparisonLeg {
  readonly fact: SuccessFact;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface RankingEntry {
  readonly rank: number;
  readonly protocol: string;
  readonly value: number;
}

export interface Spread {
  readonly max: number;
  readonly min: number;
  /**
   * `max / min`, or **null** when that quotient is not a meaningful multiple.
   *
   * Never `Infinity`, never `NaN`, never negative — see {@link spreadOf} for
   * why each of those is a real case rather than a defensive flourish.
   */
  readonly ratio: number | null;
}

export interface Comparability {
  /** §5: the MINIMUM across legs, never the mean. */
  readonly confidence: number;
  readonly note: string;
  readonly caveats: readonly string[];
}

export interface Comparison {
  readonly metric: KpiId;
  readonly unit: Unit;
  readonly timestamp: string;
  readonly methodology_version: string;
  readonly facts: readonly KpiFact[];
  readonly ranking: readonly RankingEntry[];
  readonly ranking_basis: string;
  readonly spread: Spread | null;
  readonly comparability: Comparability;
  /** Worst cache state across the legs (ARCHITECTURE.md §6). */
  readonly cache: CacheState;
  readonly stale: boolean;
  readonly partial: boolean;
  readonly excluded_protocols: readonly string[];
}

// ---------------------------------------------------------------------------
// The response, as a schema
// ---------------------------------------------------------------------------

/**
 * `Comparison`, as zod.
 *
 * Added with `/openapi.json` (API_SPEC.md §4), which generates its
 * `CompareResponse` component from this object. That is the whole reason it
 * exists: the alternative was hand-writing the §4 skeleton's `CompareResponse`
 * into a static document, where it could describe a shape `/compare` no longer
 * returns and nothing would fail.
 *
 * It is not defensive validation on the way out — `composeComparison` is pure
 * and typed, and re-parsing its own output on every paid request would be
 * latency spent proving TypeScript works. It is a *published* description that
 * a test asserts real composed responses satisfy, so the spec is checked
 * against the code rather than against a reviewer's memory of it.
 */
export const RankingEntrySchema = z.strictObject({
  rank: z.number().int().min(1),
  protocol: z.string().min(1),
  value: z.number(),
});

export const SpreadSchema = z.strictObject({
  max: z.number(),
  min: z.number(),
  /** `max / min`, or null when the quotient is not a meaningful multiple. */
  ratio: z.number().nullable(),
});

export const ComparabilitySchema = z.strictObject({
  /** §5: the MINIMUM across legs, never the mean. */
  confidence: z.number().min(0).max(1),
  note: z.string(),
  caveats: z.array(z.string()),
});

export const ComparisonSchema = z.strictObject({
  metric: z.enum(KPI_IDS),
  unit: UnitSchema,
  timestamp: z.iso.datetime(),
  methodology_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  facts: z.array(KpiFactSchema),
  /** Strictly descending by value. Rank 1 is the largest, not the "best". */
  ranking: z.array(RankingEntrySchema),
  ranking_basis: z.string(),
  spread: SpreadSchema.nullable(),
  comparability: ComparabilitySchema,
  /** Worst state across the legs. */
  cache: CacheStateSchema,
  stale: z.boolean(),
  partial: z.boolean(),
  excluded_protocols: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Ranking direction — decided once, here, and published in the response
// ---------------------------------------------------------------------------

/**
 * **Rank 1 is the highest value. Always, for every KPI.**
 *
 * The alternative was a per-KPI `direction` in the §4 registry, so that
 * `utilization` or `take_rate` — arguably better low — would rank ascending.
 * It is rejected, and the reason is not convenience.
 *
 * A direction column is a **normative** claim, and DATA_SCHEMA.md §4 is a
 * registry of what numbers *mean*, not of whether they are good. Every
 * candidate for "lower is better" falls apart on inspection once you ask *for
 * whom*:
 *
 *  - `take_rate` low is good for LPs and bad for whoever holds the protocol's
 *    equity. Those are both our buyers.
 *  - `utilization` high is capital working hard; it is also thin exit
 *    liquidity and a nearer liquidation cascade. A treasury agent and a risk
 *    agent read the same 0.85 in opposite directions.
 *  - `capital_efficiency` high is good until it is a fee-extractive venue
 *    nobody routes through twice.
 *
 * Encoding an answer would ship an unfalsifiable judgement under an analytics
 * label — the same thing §4.1 refuses when it declines to de-duplicate wallets
 * into humans, and what §1 rules out generally. So `/compare` sorts by
 * magnitude, states that it did in `ranking_basis` on every response, and
 * leaves "better" to the caller, who knows which side of the trade it is on.
 *
 * Ties share a rank and consume the ones after them (1, 2, 2, 4): two
 * protocols at the same value are not first and second, and inventing an order
 * between them would be a claim the data does not support.
 */
export const RANKING_BASIS =
  'rank 1 is the highest value; ranking is strictly descending by magnitude for every KPI, and implies ' +
  'nothing about which direction is better. Some KPIs here are arguably better low (a lower take_rate is ' +
  'better for liquidity providers and worse for the protocol) and AlgoTerminal does not take a position on ' +
  'which — that depends on which side of the trade the caller is on. Equal values share a rank.';

/** §5's own words, restated on every response so the min rule is visible. */
export const COMPOSITE_CONFIDENCE_NOTE =
  'Composite confidence is the MINIMUM across legs, not the mean. A comparison is only as trustworthy as its ' +
  'weakest side, and averaging would hide exactly the leg a risk agent needs to see.';

// ---------------------------------------------------------------------------
// Ranking and spread
// ---------------------------------------------------------------------------

/** Descending by value, ties sharing a rank. See {@link RANKING_BASIS}. */
export function rankLegs(legs: readonly ValuedLeg[]): RankingEntry[] {
  const sorted = [...legs].sort((a, b) => b.fact.value - a.fact.value);

  const ranking: RankingEntry[] = [];
  for (const [index, leg] of sorted.entries()) {
    const previous = ranking.at(-1);
    const tied = previous !== undefined && previous.value === leg.fact.value;
    ranking.push({
      rank: tied ? previous.rank : index + 1,
      protocol: leg.protocol,
      value: leg.fact.value,
    });
  }
  return ranking;
}

/** Round to 4dp without accumulating float noise in the printed value. */
function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * `max`, `min`, and the multiple between them.
 *
 * `ratio` is `max / min` and is **null** whenever that division does not
 * produce a meaningful multiple. Three cases, all of which have either occurred
 * or are reachable from data we publish today:
 *
 *  - **`min` is 0.** `max / 0` is `Infinity`, which is not JSON — `JSON.stringify`
 *    emits `null` for it anyway, but only after every intermediate consumer has
 *    had a chance to compare against it and get a nonsense answer. This is not
 *    hypothetical: Pact's `take_rate` was exactly `0.000000` before Pact
 *    declined the KPI (DATA_SCHEMA.md §3.4), so a three-way take_rate spread
 *    would have divided by it. And `0/0` is `NaN`, which is worse, because it
 *    compares false against everything including itself.
 *  - **`min` is negative.** `max / min` is then negative, and a negative
 *    "spread ratio" reads as a direction rather than as a magnitude. A residual
 *    KPI can legitimately go negative (§3.5's `protocol_revenue_24h` did, on 7
 *    of 24 Folks markets, under the pre-1.2.0 formula).
 *  - **Signs differ across legs.** The multiple between −$5 and +$10 is not
 *    −2×; it is not a multiple at all.
 *
 * In every one of them `max` and `min` are still reported — they are real
 * measurements — and only the derived quotient is withheld, with a caveat
 * saying why. A single distinct value across all legs gives `ratio: 1`, which
 * is correct rather than degenerate.
 */
export function spreadOf(legs: readonly ValuedLeg[]): Spread | null {
  if (legs.length === 0) return null;

  const values = legs.map((leg) => leg.fact.value);
  const max = Math.max(...values);
  const min = Math.min(...values);

  return { max, min, ratio: min > 0 ? round4(max / min) : null };
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

/**
 * The worst cache state across the legs (ARCHITECTURE.md §6).
 *
 * Ordered `hit` < `miss` < `stale`. A `miss` is ranked worse than a `hit`
 * because the field describes the cache, and a miss is a cache that did not
 * have the answer — but it is ranked better than `stale`, because the data it
 * returned came straight from upstream. It is the composite's *staleness* the
 * caller is being warned about, and only `stale` carries the §5 confidence
 * penalty that goes with it.
 */
const CACHE_SEVERITY: Record<CacheState, number> = { hit: 0, miss: 1, stale: 2 };

export function worstCacheState(legs: readonly ValuedLeg[]): CacheState {
  let worst: CacheState = 'hit';
  for (const leg of legs) {
    if (CACHE_SEVERITY[leg.fact.cache] > CACHE_SEVERITY[worst]) worst = leg.fact.cache;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Caveats — the part that is actually the product
// ---------------------------------------------------------------------------

/** "a", "a and b", "a, b and c" — used in prose, so no Oxford comma. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) as string}`;
}

function verb(items: readonly unknown[]): string {
  return items.length === 1 ? 'is' : 'are';
}

/** Group legs by a key, preserving the order the keys first appeared in. */
function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket === undefined) groups.set(k, [item]);
    else bucket.push(item);
  }
  return groups;
}

/**
 * The cross-class caveat: the product thesis in one sentence.
 *
 * Emitted only when the legs actually span protocol classes. It names the
 * classes and, crucially, the §3.1 basis on which they are *nonetheless*
 * comparable — because "these are different kinds of protocol" on its own is a
 * warning, and the thing being sold is the reason it is not a disqualifying
 * one. The basis comes from the §4 registry ({@link crossClassBasis}), next to
 * the definition it justifies.
 */
function crossClassCaveat(metric: KpiId, legs: readonly ValuedLeg[]): string | null {
  const byClass = groupBy(legs, (leg) => leg.protocolClass);
  if (byClass.size < 2) return null;

  const clauses = [...byClass].map(
    ([cls, members]) =>
      `${list(members.map((m) => m.protocol))} ${verb(members)} class '${cls}'`,
  );

  return `${clauses.join('; ')}; ${metric} is comparable because ${crossClassBasis(metric)}.`;
}

/**
 * The differing-`coverage.basis` caveat.
 *
 * This is the one that matters most in practice, and it exists because of a
 * measured near-miss. Folks reports `coverage.basis: 'total_deposits'` while
 * the DEXes report `'all_pools_usd_priced'`. Both are honest and they are not
 * the same definition — our Folks TVL read 52% above DefiLlama's until it was
 * restated as deposits minus borrows, at which point it agreed to 0.85%
 * (DATA_SCHEMA.md §3.5).
 *
 * **What the difference DOES depends on the metric, and the caveat says which.**
 * An earlier version of this function emitted one sentence about a
 * "definitional gap" for every KPI. On `take_rate` that sentence was wrong, and
 * wrong in the worst available way: it directly contradicted the cross-class
 * caveat sitting immediately above it, which correctly says `take_rate` is
 * comparable *because* it is a dimensionless ratio into which no conversion
 * enters. Both caveats cannot be true, and a caller reading a paid response
 * that argues with itself learns to trust neither. So there are three
 * endings — for the metric that IS the disputed quantity, for the metrics that
 * divide by it, and for the ones that merely aggregate over differently
 * selected populations.
 */
function coverageBasisCaveat(metric: KpiId, legs: readonly ValuedLeg[]): string | null {
  const byBasis = groupBy(legs, (leg) => leg.fact.coverage.basis);
  if (byBasis.size < 2) return null;

  const clauses = [...byBasis].map(
    ([basis, members]) =>
      `${list(members.map((m) => m.protocol))} ${verb(members)} measured on '${basis}'`,
  );
  const opening =
    `The legs do not share one coverage basis: ${clauses.join(', while ')}. ` +
    `Each is the honest basis for its protocol and is stated on its own fact, but they select and define ` +
    `what is counted differently.`;

  if (metric === 'tvl') {
    return (
      `${opening} For tvl this is the value itself, not a detail of it: 'all_pools_usd_priced' is the ` +
      `liquidity sitting in pools that passed the inclusion filters, while 'total_deposits' is everything ` +
      `supplied to the protocol including the portion currently lent out (DATA_SCHEMA.md §3.5). Those are ` +
      `two defensible definitions of the same word, and the difference is large: restating our Folks figure ` +
      `on the deposits-minus-borrows definition moves it by roughly a third. Treat a gap here as ` +
      `definitional until you have checked which basis each leg used.`
    );
  }

  if (getKpi(metric).tvlDenominated === true) {
    return (
      `${opening} ${metric} divides by that quantity, so the difference lands in the denominator: a lending ` +
      `leg is divided by total deposits, including capital currently lent out, and a DEX leg by the ` +
      `liquidity in its pools (DATA_SCHEMA.md §3.5). The ranking is still meaningful — the numerator is ` +
      `defined identically across the legs — but a narrow gap between legs on different bases is not, ` +
      `because part of it is the denominator's definition rather than the protocols' performance.`
    );
  }

  return (
    `${opening} This does not change what ${metric} means: its definition is identical across these legs, ` +
    `and it is computed the same way within each. What differs is the population it was computed over — ` +
    `which pools or markets each protocol's basis admits — so the legs are like-for-like in definition and ` +
    `not quite like-for-like in coverage. Each fact's coverage block gives the entity and exclusion counts.`
  );
}

/**
 * Any leg whose value is an estimate, naming the method (§1.2).
 *
 * The method is named as its documented id rather than paraphrased, because
 * the id is what `/methodology` and DATA_SCHEMA.md §3 index on — a caller that
 * wants to know exactly what was assumed can look it up, and a paraphrase here
 * would be a fourth description of the same thing to keep in sync. What the
 * sentence adds is the consequence: an estimated leg is graded on §5's
 * estimation row, not the reported row, so it cannot reach the top of the
 * confidence ladder however clean the arithmetic was.
 */
function estimationCaveats(legs: readonly ValuedLeg[]): string[] {
  return legs
    .filter((leg) => leg.fact.is_estimated)
    .map(
      (leg) =>
        `${leg.protocol} is estimated rather than directly reported by its source (estimation_method: ` +
        `${leg.fact.estimation_method ?? 'unstated'}). It is therefore graded on the estimation row of the ` +
        `DATA_SCHEMA.md §5 confidence table rather than the reported row, which caps it below the legs that ` +
        `were measured directly. /methodology documents what this method assumes.`,
    );
}

/**
 * Any leg below the §5 buyer-facing 0.7 line.
 *
 * §5 publishes the ladder — `>= 0.9` safe to act on, `0.7-0.9` directionally
 * sound, `< 0.7` informational — so a leg under 0.7 is one the caller was told
 * to treat as informational. Naming it here is what stops a composite from
 * quietly laundering it into a ranking that looks authoritative.
 */
export const INFORMATIONAL_CONFIDENCE = 0.7;

function lowConfidenceCaveats(legs: readonly ValuedLeg[]): string[] {
  return legs
    .filter((leg) => leg.fact.confidence < INFORMATIONAL_CONFIDENCE)
    .map(
      (leg) =>
        `${leg.protocol} has confidence ${leg.fact.confidence}, below the ${INFORMATIONAL_CONFIDENCE} line at ` +
        `which DATA_SCHEMA.md §5 stops calling a number directionally sound and starts calling it ` +
        `informational. Its position in this ranking is correspondingly weak.`,
    );
}

/** Why `spread.ratio` was withheld, when it was. */
function spreadCaveat(spread: Spread | null): string | null {
  if (spread === null || spread.ratio !== null) return null;
  return (
    `spread.ratio is null: the lowest value across the legs is ${spread.min}, and a ratio against a value that ` +
    `is zero or negative is not a meaningful multiple. spread.max and spread.min are the measured values and ` +
    `are unaffected.`
  );
}

/** Legs that could not be answered at all, so the ranking's shape is visible. */
function exclusionCaveat(excluded: readonly { protocol: string; code: string }[]): string | null {
  if (excluded.length === 0) return null;
  const named = excluded.map((e) => `${e.protocol} (${e.code})`);
  return (
    `This comparison is partial: ${list(named)} could not be included, and ${excluded.length === 1 ? 'its' : 'their'} ` +
    `error fact${excluded.length === 1 ? '' : 's'} in facts[] give${excluded.length === 1 ? 's' : ''} the reason. ` +
    `The ranking and spread describe only the legs that resolved.`
  );
}

/**
 * Every caveat this comparison warrants, in the order a reader needs them:
 * first why the comparison is legitimate at all, then what makes the numbers
 * not-quite-like-for-like, then which individual legs are weak, then what was
 * withheld or missing.
 *
 * Generated, never decorative. An empty array is a real answer — three DEXes
 * on `volume_24h`, all directly reported, all fully covered, warrants no
 * caveats and must not be given filler ones. A caveat a caller learns to skip
 * is worse than no caveat, because the next one matters.
 */
export function generateCaveats(
  metric: KpiId,
  legs: readonly ValuedLeg[],
  excluded: readonly { protocol: string; code: string }[],
  spread: Spread | null,
): string[] {
  return [
    crossClassCaveat(metric, legs),
    coverageBasisCaveat(metric, legs),
    ...estimationCaveats(legs),
    ...lowConfidenceCaveats(legs),
    spreadCaveat(spread),
    exclusionCaveat(excluded),
  ].filter((c): c is string => c !== null);
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface ComposeOptions {
  readonly metric: KpiId;
  readonly methodologyVersion: string;
  /** Injected, so a composite is deterministic under test (CONNECTOR_GUIDE §1). */
  readonly timestamp: string;
}

/**
 * The minimum number of resolved legs that constitutes a comparison.
 *
 * API_SPEC.md §3.2: "a two-way comparison is the product; a one-way
 * 'comparison' is not, and charging $0.05 for it would be taking money for a
 * non-answer." The route turns a shortfall into a 502, which the gate does not
 * settle — so this constant is a pricing decision as much as a data one.
 */
export const MIN_COMPARABLE_LEGS = 2;

/** Did enough legs resolve for this to be a comparison at all? */
export function isComparable(legs: readonly ComparisonLeg[]): boolean {
  return legs.filter((leg) => isSuccessFact(leg.fact)).length >= MIN_COMPARABLE_LEGS;
}

/**
 * Compose the §3.2 response body from legs the caller has already fetched.
 *
 * Assumes {@link isComparable} passed; composing a one-legged "comparison" is
 * a caller bug rather than a runtime condition, so it is not defended against
 * here — the route decides that, because the route is what returns the 502.
 */
export function composeComparison(
  legs: readonly ComparisonLeg[],
  opts: ComposeOptions,
): Comparison {
  const valued = legs.filter((leg): leg is ValuedLeg => isSuccessFact(leg.fact));
  const excluded = legs
    .filter((leg) => !isSuccessFact(leg.fact))
    .map((leg) => ({ protocol: leg.protocol, code: leg.fact.error?.code ?? 'UNKNOWN' }));

  const spread = spreadOf(valued);

  return {
    metric: opts.metric,
    unit: getKpi(opts.metric).unit,
    timestamp: opts.timestamp,
    methodology_version: opts.methodologyVersion,
    // Every leg, in the order it was requested — including the failures, as §2
    // error facts, so one bad protocol never removes a row the caller asked for.
    facts: legs.map((leg) => leg.fact),
    ranking: rankLegs(valued),
    ranking_basis: RANKING_BASIS,
    spread,
    comparability: {
      // §5, and the reason this module imports `combineConfidence` rather than
      // computing a min inline: there is one implementation of "composite
      // confidence" and it is the one §5 specifies. Error legs are excluded —
      // their confidence is 0 by construction (§2), and folding that in would
      // make every partial comparison read as worthless rather than as
      // narrower.
      confidence: combineConfidence(valued.map((leg) => leg.fact)),
      note: COMPOSITE_CONFIDENCE_NOTE,
      caveats: generateCaveats(opts.metric, valued, excluded, spread),
    },
    cache: worstCacheState(valued),
    stale: valued.some((leg) => leg.fact.stale),
    partial: excluded.length > 0,
    excluded_protocols: excluded.map((e) => e.protocol),
  };
}
