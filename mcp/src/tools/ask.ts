/**
 * `algoterminal_ask` — PAID, and registered only when the deployment reports it
 * available.
 *
 * `/ask` is priced at ten times a cached `/metric` lookup, so it is not the
 * default way to answer a question — it is the way to answer one that does not
 * decompose cleanly into named KPIs. It is also currently `available: false` on
 * the TestNet deployment, which is why registration is conditional and why the
 * handler re-checks at call time: a route's availability is a per-deployment
 * fact that can change under a running server.
 *
 * The service's own guarantees carry most of the weight here. Every number in
 * the prose corresponds to a fact in `facts[]`, enforced on its side rather than
 * requested in a prompt; a question asking for a forecast returns an uncharged
 * 422; a question it cannot route returns an uncharged 422 with the coverage
 * list. Probing is deliberately free.
 */
import { text, failure, findRoute, preflightBudget, quotePrice, routeUnavailable, type ToolContext, type ToolResult } from './shared.js';
import { describeFailure } from '../client.js';
import { renderError } from '../errors.js';
import { atomicToUsdc } from '../config.js';
import { renderAskResult, renderRaw, renderReceipt } from '../format.js';
import type { AskResponse } from '../types.js';

export const ASK_PATH = '/ask';

export function askDescription(prices: { base: string; deep: string }): string {
  return (
    `PAID — spends the user's own USDC, and it is the most expensive tool here: $${prices.base} standard, ` +
    `$${prices.deep} with depth="deep" (wider KPI sweep, longer synthesis). That is many times the price of ` +
    'a cached get_metric lookup, so prefer get_metric or compare whenever the question names a KPI and a ' +
    'protocol. Use this only for a question that does not decompose into named KPIs. ' +
    'Answers a natural-language question strictly from AlgoTerminal\'s own measured facts, returning both ' +
    'prose and the facts[] array it rests on, with citations mapping each claim to a fact. Descriptive only: ' +
    'no forecasts, no price targets, no trading advice — those return an uncharged 422. A question outside ' +
    'coverage also returns an uncharged 422 listing what is covered, so probing costs nothing.'
  );
}

export interface AskArgs {
  question: string;
  depth?: 'standard' | 'deep' | undefined;
  max_facts?: number | undefined;
  format?: 'prose' | 'facts' | 'both' | undefined;
}

export async function askTool(ctx: ToolContext, args: AskArgs): Promise<ToolResult> {
  const question = args.question.trim();
  if (question === '') return failure('The question is empty. Nothing was spent.');
  if (question.length > 500) {
    return failure(
      `The question is ${question.length} characters; the service caps them at 500. Nothing was spent. ` +
        'Shorten it and ask again.',
    );
  }

  const catalog = await ctx.client.getCatalog();
  const route = findRoute(catalog, ASK_PATH);
  if (route === undefined) {
    return failure(`This deployment's catalog does not list ${ASK_PATH}. Nothing was spent.`);
  }
  // Re-checked here and not only at registration: availability can flip under a
  // running server, and paying to discover a 503 would be a poor trade.
  if (!route.available) return routeUnavailable(ASK_PATH, catalog);

  const depth = args.depth ?? 'standard';
  const price = quotePrice(route, depth === 'deep' ? 'deep' : 'base');
  const label = `POST /ask${depth === 'deep' ? '?depth=deep' : ''}`;

  const refused = preflightBudget(ctx, price, label);
  if (refused !== null) return refused;

  // `depth` is a priced query parameter, not a body field, because the price is
  // quoted before the body is read.
  const result = await ctx.client.postPaid(
    ASK_PATH,
    { depth: depth === 'deep' ? 'deep' : undefined },
    {
      question,
      ...(args.max_facts === undefined ? {} : { max_facts: args.max_facts }),
      ...(args.format === undefined ? {} : { format: args.format }),
    },
    label,
  );

  if (!result.ok) {
    return failure(renderError(describeFailure(result)), ctx.ledger.render());
  }

  const ask = result.body as AskResponse;
  return text(
    renderAskResult(ask),
    renderReceipt({
      label,
      paidUsdc: atomicToUsdc(result.settlement?.atomic ?? result.quotedAtomic ?? 0n),
      txid: result.settlement?.txid ?? null,
      explorerTxBase: ctx.config.network.explorerTxBase,
      spendLine: ctx.ledger.render(),
    }),
    renderRaw(ask),
  );
}
