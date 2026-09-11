import { env } from '../config/env.js';
import { connectorContext } from '../connectors/context.js';
import { getConnector } from '../connectors/registry.js';
import type { Connector, ConnectorContext } from '../connectors/types.js';
import { isApplicable, type KpiId } from '../standardize/kpis.js';
import { isSuccessFact, type SuccessFact } from '../standardize/schema.js';
import type { FactParams } from '../cache/keys.js';

/**
 * The generic connector pipeline: `fetchRaw` → resolve prices → `toFacts`.
 *
 * This is the single place the two halves of a connector are joined, and the
 * only thing above the connector layer that runs upstream I/O. Everything else
 * — the read path, the refresher, the snapshotter — goes through here, so
 * there is exactly one implementation of "how a fact gets made" to keep
 * correct.
 *
 * It knows nothing about any specific protocol: the connector comes out of the
 * registry, the assets to price come from {@link Connector.priceAssets}, and
 * the KPI list is filtered against the §4 registry. Adding protocol #4 does
 * not touch this file.
 */

export interface ComputeRequest {
  readonly protocol: string;
  /** The KPIs to compute. Passed straight to `opts.kpis` so the connector can
   *  skip fetches it does not need — the difference between a 13s TVL refresh
   *  and a 65s full one (ARCHITECTURE.md §4.6). */
  readonly kpis: readonly KpiId[];
  readonly params: FactParams;
}

export class UnknownProtocolError extends Error {
  constructor(readonly protocol: string) {
    super(`No connector registered for protocol "${protocol}"`);
    this.name = 'UnknownProtocolError';
  }
}

/**
 * Compute the facts `req` asks for — and ONLY those.
 *
 * The filter at the end is not tidiness, it is a correctness boundary. A
 * connector's `toFacts` is a pure function of its snapshot and computes
 * whatever that snapshot supports; `opts.kpis` scopes the FETCH, not the
 * arithmetic. So a TVL-only fetch produces a snapshot with no 24h flows in it,
 * and Tinyman's `toFacts` will duly report `volume_24h: 0` — an arithmetically
 * correct sum over zero flows, and exactly the plausible-looking zero
 * DATA_SCHEMA.md §1.5 forbids us to publish. Cached, it would be served as a
 * real volume for the next 600 seconds.
 *
 * Requesting the KPI is therefore what makes its value meaningful, and a fact
 * outside `wanted` is dropped here rather than trusted. The cost is real: one
 * `fetchRaw` yields the whole KPI family, and scoping means the refresher's
 * fast cycle cannot fill the flow KPIs for free. That is why §4.6 has two
 * cycles rather than one — the split is the point, not a workaround.
 */
export async function computeFacts(
  req: ComputeRequest,
  ctx: ConnectorContext = connectorContext(),
  connector: Connector | undefined = getConnector(req.protocol),
): Promise<SuccessFact[]> {
  if (connector === undefined) throw new UnknownProtocolError(req.protocol);

  const caps = connector.capabilities();
  // Ask only for what this connector both declares and the §4 registry allows
  // for its class. A KPI outside that set is a 404 at the route, never an
  // upstream fetch, and never a fact.
  const wanted = req.kpis.filter(
    (kpi) => caps.kpis.includes(kpi) && isApplicable(kpi, caps.class),
  );
  if (wanted.length === 0) return [];

  const opts = { basis: req.params.basis, kpis: wanted } as const;
  const snapshot = await connector.fetchRaw(ctx, opts);

  // §4.3 — the ONLY sanctioned USD path, resolved here rather than inside the
  // connector, which is what keeps `toFacts` pure and replayable from a
  // fixture.
  const assetIds = connector.priceAssets?.(snapshot) ?? [];
  const prices = await ctx.prices.resolve(assetIds);

  const facts = connector.toFacts(snapshot, {
    ...opts,
    prices,
    now: ctx.now().toISOString(),
    methodologyVersion: env.METHODOLOGY_VERSION,
  });

  const requested = new Set<KpiId>(wanted);

  // Error facts are dropped rather than cached. An error is a property of one
  // attempt, not of the KPI, and caching it for 300s would turn a single
  // upstream hiccup into five minutes of served failures — with the L2
  // fallback, which exists for exactly this, never consulted.
  return facts.filter(isSuccessFact).filter((fact) => requested.has(fact.metric));
}

/** The KPIs a connector can actually produce, in §4 registry order. */
export function producibleKpis(connector: Connector): KpiId[] {
  const caps = connector.capabilities();
  return caps.kpis.filter((kpi) => isApplicable(kpi, caps.class));
}
