/**
 * Shared plumbing for the tool handlers.
 *
 * The handlers are written as plain functions over a context object rather than
 * as closures inside the server, so the test suite can call every one of them
 * directly with a stubbed `fetch` and a real ledger. A spend cap that is only
 * exercised through a live MCP transport is a spend cap nobody tests.
 */
import type { AlgoTerminalClient } from '../client.js';
import type { Config } from '../config.js';
import { usdcToAtomic } from '../config.js';
import { SpendLimitError, type SpendLedger } from '../spend.js';
import { PaymentConfigError } from '../payer.js';
import { ServiceUnreachableError } from '../client.js';
import type { Catalog, CatalogProtocol, CatalogRoute } from '../types.js';

export interface ToolContext {
  readonly client: AlgoTerminalClient;
  readonly ledger: SpendLedger;
  readonly config: Config;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** The MCP SDK's result type is open; this keeps ours assignable to it. */
  [k: string]: unknown;
}

export function text(...parts: string[]): ToolResult {
  return { content: [{ type: 'text', text: parts.filter((p) => p !== '').join('\n\n') }] };
}

export function failure(...parts: string[]): ToolResult {
  return { content: [{ type: 'text', text: parts.filter((p) => p !== '').join('\n\n') }], isError: true };
}

export const NO_KEY_MESSAGE =
  'NOT CONFIGURED: this tool spends real USDC and no payment key is set, so nothing was called and nothing ' +
  'was spent.\n\n' +
  'AlgoTerminal has no API key and no signup — the payment IS the authentication, and it is made from the ' +
  "user's OWN Algorand account. This server never ships a funded account and never pays on anyone's behalf.\n\n" +
  'To enable paid tools, set one of these in the MCP server config and restart:\n' +
  '  ALGOTERMINAL_MNEMONIC  — the 25-word mnemonic of an Algorand account holding USDC\n' +
  '  ALGOTERMINAL_KEYFILE   — path to a file containing that mnemonic\n\n' +
  'On TestNet the USDC is free: fund an account with TestNet ALGO from https://bank.testnet.algorand.network, ' +
  'opt it in to ASA 10458941, then swap a little ALGO for USDC on a Tinyman V2 TestNet pool. The account MUST ' +
  'be opted in to the USDC ASA before it can hold or spend any.\n\n' +
  'The free tools — algoterminal_catalog and algoterminal_methodology — work right now without any of this.';

export function findRoute(catalog: Catalog, path: string): CatalogRoute | undefined {
  return catalog.routes.find((r) => r.path === path);
}

export function findProtocol(catalog: Catalog, id: string): CatalogProtocol | undefined {
  return catalog.protocols.find((p) => p.id === id);
}

export function routeUnavailable(path: string, catalog: Catalog): ToolResult {
  return failure(
    `ROUTE NOT AVAILABLE: ${path} is listed in this deployment's catalog with \`available: false\`, so it ` +
      'cannot be called. Nothing was spent.',
    'A listed route is not necessarily a callable one — availability is a per-deployment fact and is ' +
      'reported at runtime for exactly this reason.',
    `Routes on this deployment right now:\n${catalog.routes
      .map((r) => `  ${r.method} ${r.path} — $${r.price_usdc} — ${r.available ? 'available' : 'NOT AVAILABLE'}`)
      .join('\n')}`,
  );
}

/**
 * The price this call will be quoted, from the live catalog. Advisory only: the
 * binding number is the one in the server's 402, and that is what the ledger
 * actually enforces against. This exists so a call that is obviously over budget
 * is refused before a round trip, with the same message it would get later.
 */
export function quotePrice(route: CatalogRoute, tier: 'base' | 'fresh' | 'active_users' | 'deep'): string {
  switch (tier) {
    case 'fresh':
      return route.price_fresh_usdc ?? route.price_usdc;
    case 'active_users':
      return route.price_active_users_usdc ?? route.price_usdc;
    case 'deep':
      return route.price_deep_usdc ?? route.price_usdc;
    default:
      return route.price_usdc;
  }
}

export function preflightBudget(ctx: ToolContext, priceUsdc: string, label: string): ToolResult | null {
  try {
    ctx.ledger.assertAllowed(usdcToAtomic(priceUsdc, 'catalog price'), label);
    return null;
  } catch (cause) {
    if (cause instanceof SpendLimitError) {
      return failure(cause.message, ctx.ledger.render());
    }
    throw cause;
  }
}

/**
 * Turn anything thrown during a tool call into a result the model can act on.
 * A thrown exception reaching the transport becomes an opaque protocol error;
 * an explained refusal is what the caller actually needs.
 */
export function toToolError(cause: unknown, ledger: SpendLedger): ToolResult {
  if (cause instanceof SpendLimitError) {
    return failure(cause.message, ledger.render());
  }
  if (cause instanceof PaymentConfigError) {
    return failure(cause.message, ledger.render());
  }
  if (cause instanceof ServiceUnreachableError) {
    return failure(cause.message, ledger.render());
  }
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return failure(
      'The request timed out on this side before the service answered. Nothing was settled, so nothing was ' +
        'spent — AlgoTerminal settles only after a successful response. Retry; if it recurs, drop `fresh` ' +
        'and take the cached number, which is much faster.',
      ledger.render(),
    );
  }
  return failure(
    `The call failed before completing: ${cause instanceof Error ? cause.message : String(cause)}. ` +
      'No settlement receipt was produced, so nothing was spent.',
    ledger.render(),
  );
}
