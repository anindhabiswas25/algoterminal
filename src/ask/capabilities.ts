import { getConnector, listConnectors, listProtocolIds } from '../connectors/registry.js';
import { isApplicable, KPI_IDS, KPI_REGISTRY, type KpiId } from '../standardize/kpis.js';
import type { ProtocolClass } from '../standardize/types.js';
import type { Plan } from './schema.js';

/**
 * The capability matrix — what `/ask` is allowed to plan against.
 *
 * ARCHITECTURE.md §4.7: the router's plan is "validated against the registry
 * capability matrix. Cheap, fast, and it *cannot* invent a protocol we don't
 * cover." This module is that matrix, and it is generated from the same
 * `registry.ts` Map that `/catalog`, `/metric` and `/compare` read, so a
 * connector registered in one line is immediately askable and one that is
 * removed is immediately unroutable.
 *
 * It is used twice, and both uses matter:
 *
 *  - **In the router's tool schema**, as `enum`s. With `strict: true` the API
 *    itself rejects a tool call naming a protocol or KPI outside these lists,
 *    so a hallucinated protocol never reaches our code.
 *  - **In {@link validatePlan}**, after the call. The enum is enforced a
 *    network hop away by a service we do not control; re-checking here costs
 *    microseconds and means a relaxed `strict`, a schema-less fallback, or a
 *    future SDK change cannot turn "cannot invent a protocol" from a guarantee
 *    into a hope.
 *
 * The applicability rules are NOT duplicated: `isApplicable` and the
 * connectors' own `capabilities()` are the same functions `/metric` resolves
 * against, so a KPI Pact declines is declined identically on both routes.
 */

export interface ProtocolCapability {
  readonly id: string;
  readonly name: string;
  readonly class: ProtocolClass;
  /** KPIs this connector actually publishes. */
  readonly kpis: readonly KpiId[];
  /**
   * KPIs applicable to the class that this connector deliberately declines,
   * with the reason.
   *
   * Given to the router *and* to the synthesizer, because the two need it for
   * different reasons. The router needs to know Pact's `take_rate` is
   * unavailable so it does not silently drop Pact from a take-rate question;
   * the synthesizer needs the reason so it can say "Pact does not publish its
   * fee split" instead of omitting Pact from the answer, which would read as
   * "Pact has no take rate" (DATA_SCHEMA.md §1.5).
   */
  readonly declined: ReadonlyArray<{ readonly kpi: string; readonly reason: string }>;
}

export interface KpiCapability {
  readonly id: KpiId;
  readonly unit: string;
  readonly classes: readonly ProtocolClass[];
  readonly definition: string;
}

export interface CapabilityMatrix {
  readonly protocols: readonly ProtocolCapability[];
  readonly kpis: readonly KpiCapability[];
}

export function capabilityMatrix(): CapabilityMatrix {
  return {
    protocols: listConnectors().map((connector) => {
      const caps = connector.capabilities();
      return {
        id: caps.id,
        name: caps.name,
        class: caps.class,
        kpis: [...caps.kpis],
        declined: Object.entries(caps.declined ?? {}).map(([kpi, reason]) => ({
          kpi,
          reason: reason as string,
        })),
      };
    }),
    kpis: KPI_IDS.map((id) => ({
      id,
      unit: KPI_REGISTRY[id].unit,
      classes: [...KPI_REGISTRY[id].applicableClasses],
      definition: KPI_REGISTRY[id].description,
    })),
  };
}

/** One (protocol, KPI) the plan asks for, and whether we can answer it. */
export interface PlannedPair {
  readonly protocol: string;
  readonly kpi: KpiId;
}

/** A pair we will not fetch, and the reason a caller can act on. */
export interface UnavailablePair extends PlannedPair {
  readonly reason: string;
  /**
   * True when this is a deliberate connector decline (§1.5) rather than a
   * category error. The distinction is the whole point: a declined KPI is a
   * finding about the source that the answer must state, and an inapplicable
   * one is a question that was never coherent for that protocol.
   */
  readonly declined: boolean;
}

export interface ValidatedPlan {
  /** Pairs we will actually fetch, in plan order. */
  readonly fetch: readonly PlannedPair[];
  /** Pairs we will not fetch, each with a reason for the answer to carry. */
  readonly unavailable: readonly UnavailablePair[];
  /** Protocol ids the plan named that we do not cover at all. */
  readonly unknownProtocols: readonly string[];
}

/**
 * Expand a plan into the pairs to fetch, dropping the ones no connector can
 * answer and recording why.
 *
 * The cross product of `protocols x kpis` is the right expansion because that
 * is what the plan means: "these KPIs, for these protocols". Pairs that do not
 * exist are filtered here rather than becoming failed fetches, so an
 * inapplicable pair costs nothing and still produces a sentence in the answer.
 *
 * An unknown protocol is reported separately from an inapplicable pair. It is
 * the router having produced something outside the matrix — which the tool
 * schema should have made impossible — and the route turns it into a 422
 * rather than quietly answering a narrower question than the one asked.
 */
export function validatePlan(plan: Plan): ValidatedPlan {
  const fetch: PlannedPair[] = [];
  const unavailable: UnavailablePair[] = [];
  const unknownProtocols: string[] = [];

  for (const protocol of plan.protocols) {
    const connector = getConnector(protocol);
    if (connector === undefined) {
      unknownProtocols.push(protocol);
      continue;
    }
    const caps = connector.capabilities();

    for (const kpi of plan.kpis) {
      if (!isApplicable(kpi, caps.class)) {
        unavailable.push({
          protocol,
          kpi,
          reason: `"${kpi}" is not defined for a ${caps.class} protocol.`,
          declined: false,
        });
        continue;
      }

      const declineReason = caps.declined?.[kpi];
      if (declineReason !== undefined) {
        unavailable.push({
          protocol,
          kpi,
          reason: `${caps.name} declines "${kpi}": ${declineReason}`,
          declined: true,
        });
        continue;
      }

      if (!caps.kpis.includes(kpi)) {
        unavailable.push({
          protocol,
          kpi,
          reason: `${caps.name} does not publish "${kpi}".`,
          declined: false,
        });
        continue;
      }

      fetch.push({ protocol, kpi });
    }
  }

  return { fetch, unavailable, unknownProtocols };
}

/** What a 422 tells the caller we DO cover (API_SPEC.md §3.3: "body lists what we do cover"). */
export function coverageSummary() {
  return {
    protocols: listProtocolIds(),
    kpis: [...KPI_IDS],
    note:
      'Ask about these protocols and these KPIs. Not every KPI applies to every protocol — ' +
      'GET /catalog lists each connector’s own set, and GET /methodology explains the accounting.',
  };
}
