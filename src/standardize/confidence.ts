import { getKpi, isKpiId, type KpiId } from './kpis.js';

/**
 * DATA_SCHEMA.md §5 — the single source of confidence.
 *
 * CONNECTOR_GUIDE §4.4: connectors declare a `derivation` and a list of
 * `penalties`; they never hardcode a confidence float. Hardcoded confidences
 * drift apart across connectors and make the number meaningless — and since §5
 * publishes a buyer-facing ladder (>= 0.9 safe to act on, 0.7-0.9 directional,
 * < 0.7 informational), a drifting float is a broken contract, not a cosmetic
 * inconsistency.
 *
 * The formula: `base x multiplicative penalties`, then the one additive
 * penalty, then the per-KPI caps and floors, floored at 0.1 and rounded to 2dp.
 */

/** §5, the "Base, by derivation" table. */
export const DERIVATION_BASE = {
  /** Directly reported by the protocol's own API in the requested unit. */
  reported: 0.95,
  /** Directly read from on-chain state. */
  onchain: 0.95,
  /** Arithmetic on directly-reported values (sums, residuals, ratios). */
  arithmetic: 0.9,
  /** Requires a USD price conversion: 0.90 x price_confidence (§3.7). */
  usd_conversion: 0.9,
  /** Requires a documented estimation, e.g. annualized -> daily (§3.5). */
  documented_estimation: 0.85,
  /** Requires a fallback constant, e.g. the Tinyman V2 default fee ratio. */
  fallback_constant: 0.7,
  /** Indexer aggregation over addresses (`active_users_24h`) — 0.80 hard cap. */
  indexer_address_aggregation: 0.8,
} as const satisfies Record<string, number>;

export type DerivationKind = keyof typeof DERIVATION_BASE;

/**
 * A declared derivation. `usd_conversion` is the only kind that takes a
 * parameter, because §5 defines its base as `0.90 x price_confidence` and the
 * price confidence comes from the §3.7 resolution ladder at runtime.
 */
export type Derivation =
  | { kind: Exclude<DerivationKind, 'usd_conversion'> }
  | { kind: 'usd_conversion'; priceConfidence: number };

/**
 * §5, the penalty table.
 *
 * Every entry is a multiplier except `folks_retention_divergence`, which §3.5
 * specifies as an additive `-0.10`. That difference is real and is modelled as
 * a distinct `mode`, not smuggled in as a 0.9-ish multiplier: at a base of 0.85
 * the two would differ by only 0.065, which is small enough to look like a
 * rounding artefact and large enough to move a fact across the 0.7 buyer-facing
 * boundary.
 */
export const PENALTIES = {
  /** Served stale from L1 past TTL. */
  stale_l1: { mode: 'multiply', amount: 0.9 },
  /** Served from L2 last-known-good snapshot. Also floors confidence at 0.4. */
  l2_snapshot: { mode: 'multiply', amount: 0.7 },
  /** `coverage.excluded / (entities + excluded) > 0.10`. */
  high_exclusion: { mode: 'multiply', amount: 0.9 },
  /** DefiLlama cross-check divergence > 10%. */
  defillama_divergence: { mode: 'multiply', amount: 0.9 },
  /** Folks retention-rate cross-check divergence > 5% (§3.5). ADDITIVE. */
  folks_retention_divergence: { mode: 'subtract', amount: 0.1 },
  /** Any upstream field failed zod validation and was skipped. */
  validation_skip: { mode: 'multiply', amount: 0.85 },
} as const satisfies Record<string, { mode: 'multiply' | 'subtract'; amount: number }>;

export type PenaltyKind = keyof typeof PENALTIES;

/** §5 — the global floor, applied last. */
export const CONFIDENCE_FLOOR = 0.1;
/** §5 — the floor that an L2-snapshot fact never falls below. */
export const L2_SNAPSHOT_FLOOR = 0.4;

/**
 * §5's published contract with buyers: `>= SAFE_TO_ACT` is safe to act on,
 * `>= DIRECTIONAL` is directionally sound (check `notes`), and anything below
 * that is informational — `/ask` must explicitly caveat it in prose. The ladder
 * lives here, with the arithmetic that produces the numbers it grades, so a
 * change to one is made in sight of the other.
 */
export const CONFIDENCE_SAFE_TO_ACT = 0.9;
export const CONFIDENCE_DIRECTIONAL = 0.7;

/** Where a confidence sits on the §5 buyer ladder. */
export function confidenceTier(confidence: number): 'safe_to_act' | 'directional' | 'informational' {
  if (confidence >= CONFIDENCE_SAFE_TO_ACT) return 'safe_to_act';
  if (confidence >= CONFIDENCE_DIRECTIONAL) return 'directional';
  return 'informational';
}

export interface ComputeConfidenceArgs {
  /** The §5 base row. Never a raw float (CONNECTOR_GUIDE §4.4). */
  derivation: Derivation;
  /** The §5 penalty rows that apply. Order is irrelevant; see below. */
  penalties?: readonly PenaltyKind[];
  /**
   * The KPI this confidence is for. REQUIRED, and typed to `KpiId`.
   *
   * The per-KPI hard caps in the §4 registry (today: `active_users_24h` at
   * 0.80) are enforced here rather than by every caller — that is the whole
   * point of centralising this function (CONNECTOR_GUIDE §4.4). While this was
   * optional, omitting it silently bypassed a cap that §4.1 states applies
   * "always, on every protocol": `computeConfidence({ derivation: { kind:
   * 'arithmetic' } })` returned 0.9 for what was in fact an active-users fact.
   * A cap a caller can forget is not enforced, so the type no longer lets them.
   *
   * `KpiId` rather than `string` for the same reason one step earlier: a
   * mistyped metric would find no registry row and silently uncap.
   */
  metric: KpiId;
}

/** Round half-up to 2dp, per §5. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute a fact's confidence per §5.
 *
 * Order of operations, and why it is this one:
 *  1. base
 *  2. x every multiplicative penalty (commutative, so declaration order of
 *     `penalties` never changes the result)
 *  3. - the additive penalty (after the multiplications: §5 states the formula
 *     as `base x penalties` and describes the Folks row as a subtraction from
 *     the result, not as a discount on the base)
 *  4. per-KPI hard cap (§4.1)
 *  5. floors — L2 snapshot's 0.4 where it applies, otherwise the global 0.1.
 *     Floors run after the cap so a floor always wins; the two can never
 *     conflict, since every floor sits below every cap.
 *  6. round to 2dp
 */
export function computeConfidence(args: ComputeConfidenceArgs): number {
  const { derivation, penalties = [], metric } = args;

  let confidence = baseFor(derivation);

  for (const kind of penalties) {
    const penalty = PENALTIES[kind];
    if (penalty.mode === 'multiply') confidence *= penalty.amount;
  }
  for (const kind of penalties) {
    const penalty = PENALTIES[kind];
    if (penalty.mode === 'subtract') confidence -= penalty.amount;
  }

  // `isKpiId` is not redundant with the `KpiId` type: it is the guard for the
  // untyped boundary (a JS caller, or a metric read off a request path), where
  // an unknown id must uncap rather than throw.
  const cap = isKpiId(metric) ? getKpi(metric).maxConfidence : undefined;
  if (cap !== undefined) confidence = Math.min(confidence, cap);

  const floor = penalties.includes('l2_snapshot') ? L2_SNAPSHOT_FLOOR : CONFIDENCE_FLOOR;
  confidence = Math.max(confidence, floor);

  return round2(Math.min(confidence, 1));
}

function baseFor(derivation: Derivation): number {
  if (derivation.kind === 'usd_conversion') {
    const p = derivation.priceConfidence;
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new RangeError(
        `priceConfidence must be in [0,1] (§3.7), received ${String(derivation.priceConfidence)}`,
      );
    }
    // §5: "Requires a USD price conversion | 0.90 x price_confidence (§3.7)".
    // ALGO's price confidence propagates through most of the catalogue this way.
    return DERIVATION_BASE.usd_conversion * p;
  }
  return DERIVATION_BASE[derivation.kind];
}

/**
 * §5 — composite facts (`/compare`, and any ratio spanning two facts) take the
 * MINIMUM confidence of their inputs, not the mean.
 *
 * A comparison is only as trustworthy as its weakest leg. Averaging a 0.95 TVL
 * against a 0.45 fee estimate yields 0.70, which reads as "directionally sound"
 * on the §5 buyer ladder and hides exactly the case a risk agent needs to see —
 * one side of the comparison being barely better than a guess. The minimum
 * carries the weak leg forward into the caller's decision, which is the whole
 * point of publishing a confidence at all.
 */
export function combineConfidence(facts: ReadonlyArray<{ confidence: number }>): number {
  if (facts.length === 0) return 0;
  let min = Infinity;
  for (const fact of facts) min = Math.min(min, fact.confidence);
  return round2(min);
}

/**
 * Apply a freshness penalty to an already-computed confidence, at serve time.
 *
 * ## Why this is not just `computeConfidence` with an extra penalty
 *
 * Every other §5 penalty is known when the fact is computed, so it goes
 * through {@link computeConfidence} with the derivation that produced it. The
 * two cache penalties are not: `stale_l1` and `l2_snapshot` describe how a
 * fact reached *this particular caller*, and the same stored bytes are a fresh
 * hit for one request and a stale serve for the next. There is no derivation
 * to recompute from at that point — only the stamped number.
 *
 * So the multiplier is applied to the stamped confidence, and the §4 per-KPI
 * cap and the §5 floors are re-applied on top. For a multiplicative penalty
 * that is the same arithmetic as recomputing from the base, up to the 2dp
 * rounding that `computeConfidence` already performed; the alternative would
 * be to store each fact's derivation and penalty list in the cache envelope
 * alongside it, which is a second copy of the confidence inputs that can drift
 * from the first.
 *
 * Only the two multiplicative cache penalties are accepted. The additive Folks
 * row is a cross-check result, not a freshness signal, and it does not commute
 * with a rounded input the way a multiplier does.
 */
export function applyServePenalty(
  confidence: number,
  penalty: 'stale_l1' | 'l2_snapshot',
  metric: KpiId,
): number {
  let next = confidence * PENALTIES[penalty].amount;

  const cap = isKpiId(metric) ? getKpi(metric).maxConfidence : undefined;
  if (cap !== undefined) next = Math.min(next, cap);

  // §5: an L2 snapshot's confidence is floored at 0.4, not at the global 0.1.
  // It is a real number that was true recently, and grading it below the
  // global floor would say less about it than we know.
  const floor = penalty === 'l2_snapshot' ? L2_SNAPSHOT_FLOOR : CONFIDENCE_FLOOR;
  next = Math.max(next, floor);

  return round2(Math.min(next, 1));
}
