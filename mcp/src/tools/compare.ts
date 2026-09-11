/**
 * `algoterminal_compare` — PAID.
 *
 * The same KPI across 2-5 protocols, ranked, with a generated statement of what
 * makes the legs comparable. This is the route where AlgoTerminal's one-policy
 * claim is actually cashed in, and therefore the route where the caveats matter
 * most — `comparability.caveats` names legs measured on a different
 * `coverage.basis`, legs that are estimates, legs below the 0.7 line, and, when
 * the legs span protocol classes, the argument for why a DEX and a lending
 * market belong on the same axis at all.
 *
 * Those caveats go out verbatim (see format.ts). Condensing them would sell the
 * comparison without the reasoning that makes it one.
 */
import { text, failure, findProtocol, findRoute, preflightBudget, quotePrice, routeUnavailable, type ToolContext, type ToolResult } from './shared.js';
import { describeFailure } from '../client.js';
import { renderError } from '../errors.js';
import { atomicToUsdc } from '../config.js';
import { renderCompareResult, renderRaw, renderReceipt } from '../format.js';
import type { CompareResponse } from '../types.js';

export const COMPARE_PATH = '/compare';

export function compareDescription(prices: { base: string; fresh: string }): string {
  return (
    `PAID — spends the user's own USDC. $${prices.base} flat for 2-5 protocols, ` +
    `$${prices.fresh} with fresh=true (forces an upstream round-trip on EVERY leg). ` +
    'Returns ONE standardized KPI across several Algorand DeFi protocols with a descending ranking, the ' +
    'spread, and comparability caveats explaining what does and does not make the legs comparable — ' +
    'including, when the legs span a DEX and a lending market, why that comparison is valid at all. ' +
    'comparability.confidence is the MINIMUM across legs, never the mean. Every leg appears in the result, ' +
    'including ones that failed; one bad protocol never fails the whole call. Cheaper than several ' +
    'get_metric calls once you are comparing three or more. Not charged if fewer than two legs resolve.'
  );
}

export interface CompareArgs {
  protocols: string[];
  metric: string;
  fresh?: boolean | undefined;
  basis?: string | undefined;
}

export async function compareTool(ctx: ToolContext, args: CompareArgs): Promise<ToolResult> {
  const unique = [...new Set(args.protocols.map((p) => p.trim()).filter((p) => p !== ''))];
  if (unique.length < 2) {
    return failure(
      `A comparison needs at least 2 distinct protocols; got ${unique.length}. Nothing was spent.`,
      'For a single protocol use algoterminal_get_metric, which is ten times cheaper.',
    );
  }
  if (unique.length > 5) {
    return failure(`A comparison takes at most 5 protocols; got ${unique.length}. Nothing was spent.`);
  }

  const catalog = await ctx.client.getCatalog();
  const route = findRoute(catalog, COMPARE_PATH);
  if (route === undefined) {
    return failure(`This deployment's catalog does not list ${COMPARE_PATH}. Nothing was spent.`);
  }
  if (!route.available) return routeUnavailable(COMPARE_PATH, catalog);

  const unknown = unique.filter((p) => findProtocol(catalog, p) === undefined);
  if (unknown.length > 0) {
    return failure(
      `Not in this deployment's coverage: ${unknown.join(', ')}. Nothing was spent.`,
      `Protocols covered right now: ${catalog.protocols.map((p) => `${p.id} (${p.class})`).join(', ')}`,
    );
  }

  // Warn about legs the catalog already says will not resolve, but do not refuse:
  // the service returns a partial comparison as long as two legs resolve, and
  // that is a real answer. Refusing here would substitute our judgement for its.
  const willDecline = unique.filter((p) => findProtocol(catalog, p)?.declined?.[args.metric] !== undefined);
  const resolvable = unique.length - willDecline.length;
  if (resolvable < 2) {
    const reasons = willDecline
      .map((p) => `  ${p}: ${findProtocol(catalog, p)?.declined?.[args.metric] ?? ''}`)
      .join('\n');
    return failure(
      `Fewer than two of these protocols publish "${args.metric}", so no comparison is possible. Nothing was ` +
        'spent — the service would have returned an uncharged 422 for the same reason.',
      `Declining: ${willDecline.join(', ')}`,
      'THE REASONS, verbatim — report these rather than describing the data as missing:',
      reasons,
    );
  }

  const fresh = args.fresh === true;
  const price = quotePrice(route, fresh ? 'fresh' : 'base');
  const label = `GET /compare?protocols=${unique.join(',')}&metric=${args.metric}${fresh ? '&fresh=true' : ''}`;

  const refused = preflightBudget(ctx, price, label);
  if (refused !== null) return refused;

  const result = await ctx.client.getPaid(
    COMPARE_PATH,
    {
      protocols: unique.join(','),
      metric: args.metric,
      fresh: fresh ? 'true' : undefined,
      basis: args.basis,
    },
    label,
  );

  if (!result.ok) {
    return failure(renderError(describeFailure(result)), ctx.ledger.render());
  }

  const cmp = result.body as CompareResponse;
  const notice =
    willDecline.length > 0
      ? `NOTE: ${willDecline.join(', ')} declines to publish "${args.metric}" and appears below as a failed leg ` +
        'with its reason. That is not missing data — say so when you report this comparison.'
      : '';

  return text(
    notice,
    renderCompareResult(cmp),
    renderReceipt({
      label,
      paidUsdc: atomicToUsdc(result.settlement?.atomic ?? result.quotedAtomic ?? 0n),
      txid: result.settlement?.txid ?? null,
      explorerTxBase: ctx.config.network.explorerTxBase,
      spendLine: ctx.ledger.render(),
    }),
    renderRaw(cmp),
  );
}
