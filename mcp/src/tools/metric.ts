/**
 * `algoterminal_get_metric` — PAID.
 *
 * One KPI, one protocol. The cheapest thing on the menu and the one a model will
 * reach for most, so the order of operations here is the order that spends least:
 *
 *   1. Read `/catalog` (free) and check the protocol exists.
 *   2. If the protocol DECLINES this KPI, answer from the catalog's own reason
 *      and spend nothing. The service would return an uncharged 404 anyway; this
 *      just skips the round trip and puts the reason where a model will read it.
 *   3. Check the budget against the catalog price before making a request.
 *   4. Pay, and let the server's 402 be the number the ledger actually enforces.
 */
import { text, failure, findProtocol, findRoute, preflightBudget, quotePrice, routeUnavailable, type ToolContext, type ToolResult } from './shared.js';
import { describeFailure } from '../client.js';
import { renderError } from '../errors.js';
import { atomicToUsdc } from '../config.js';
import { renderMetricResult, renderRaw, renderReceipt } from '../format.js';
import type { KpiFact } from '../types.js';

export const METRIC_PATH = '/metric/{protocol}/{kpi}';

export function metricDescription(prices: { base: string; fresh: string; activeUsers: string }): string {
  return (
    `PAID — spends the user's own USDC. $${prices.base} for a cache-backed lookup, ` +
    `$${prices.fresh} with fresh=true (forces an upstream round-trip), ` +
    `$${prices.activeUsers} for kpi="active_users_24h" (indexer aggregation is materially more expensive). ` +
    'Returns ONE standardized financial KPI for ONE Algorand DeFi protocol, as a KpiFact carrying the value, ' +
    'its unit, a 0-1 confidence score, cache state, staleness, coverage and provenance notes. ' +
    'Call algoterminal_catalog first (free) to confirm the protocol publishes the KPI — some protocols ' +
    'deliberately decline some KPIs, and this tool will tell you the reason rather than return a zero. ' +
    'Errors are never charged: the service settles payment only after a successful response.'
  );
}

export interface MetricArgs {
  protocol: string;
  kpi: string;
  fresh?: boolean | undefined;
  basis?: string | undefined;
}

export async function metricTool(ctx: ToolContext, args: MetricArgs): Promise<ToolResult> {
  const catalog = await ctx.client.getCatalog();
  const route = findRoute(catalog, METRIC_PATH);
  if (route === undefined) {
    return failure(`This deployment's catalog does not list ${METRIC_PATH}. Nothing was spent.`);
  }
  if (!route.available) return routeUnavailable(METRIC_PATH, catalog);

  const protocol = findProtocol(catalog, args.protocol);
  if (protocol === undefined) {
    return failure(
      `No protocol "${args.protocol}" in this deployment's coverage. Nothing was spent.`,
      `Protocols covered right now: ${catalog.protocols.map((p) => `${p.id} (${p.class})`).join(', ')}`,
    );
  }

  // A declined KPI is answered from the catalog, for free. The reason IS the
  // answer — surface it, do not substitute zero, and do not silently swap in a
  // neighbouring KPI that happens to resolve.
  const declineReason = protocol.declined?.[args.kpi];
  if (declineReason !== undefined) {
    return failure(
      `${protocol.name} (${protocol.id}) DECLINES to publish "${args.kpi}". Nothing was spent — this is ` +
        'answered from the free catalog, and the service would not have charged for it either.',
      'THE REASON, verbatim. This is a fact about what the source discloses, not a gap in coverage. Report it ' +
        'as the answer. Do NOT substitute zero, do NOT rank this protocol as if it had answered, and do NOT ' +
        'fall back to a different KPI without saying so:',
      declineReason,
      `${protocol.id} does publish: ${protocol.kpis.join(', ')}`,
    );
  }

  if (!protocol.kpis.includes(args.kpi)) {
    return failure(
      `${protocol.id} does not publish "${args.kpi}". Nothing was spent.`,
      `It publishes: ${protocol.kpis.join(', ')}`,
      'Call algoterminal_catalog (free) for the full live matrix across every protocol.',
    );
  }

  const fresh = args.fresh === true;
  const tier = args.kpi === 'active_users_24h' ? 'active_users' : fresh ? 'fresh' : 'base';
  const price = quotePrice(route, tier);
  const label = `GET /metric/${args.protocol}/${args.kpi}${fresh ? '?fresh=true' : ''}`;

  const refused = preflightBudget(ctx, price, label);
  if (refused !== null) return refused;

  const result = await ctx.client.getPaid(
    `/metric/${encodeURIComponent(args.protocol)}/${encodeURIComponent(args.kpi)}`,
    { fresh: fresh ? 'true' : undefined, basis: args.basis },
    label,
  );

  if (!result.ok) {
    return failure(renderError(describeFailure(result)), ctx.ledger.render());
  }

  const fact = result.body as KpiFact;
  return text(
    renderMetricResult(fact),
    renderReceipt({
      label,
      paidUsdc: atomicToUsdc(result.settlement?.atomic ?? result.quotedAtomic ?? 0n),
      txid: result.settlement?.txid ?? null,
      explorerTxBase: ctx.config.network.explorerTxBase,
      spendLine: ctx.ledger.render(),
    }),
    renderRaw(fact),
  );
}
