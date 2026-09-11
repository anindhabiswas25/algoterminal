/**
 * Tool registration.
 *
 * Two things here are deliberate and worth naming.
 *
 * **Prices in the descriptions are read live, not hardcoded.** The server reads
 * `/catalog` at startup and builds each paid tool's description from it, so the
 * cost a model reasons about before calling is the cost the service will
 * actually quote. A hardcoded price drifts, and a model reasoning about a stale
 * price makes a spending decision on a false premise.
 *
 * **`/ask` is registered only if the deployment says it is available.** Today
 * the TestNet deployment reports `available: false`, so the tool does not exist
 * rather than existing and failing. A tool a model can see is a tool it will
 * eventually call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AlgoTerminalClient } from './client.js';
import type { Config } from './config.js';
import { Payer, type PaymentBackend } from './payer.js';
import { SpendLedger } from './spend.js';
import type { Catalog } from './types.js';
import { CATALOG_DESCRIPTION, catalogTool } from './tools/catalog.js';
import { METHODOLOGY_DESCRIPTION, methodologyTool } from './tools/methodology.js';
import { METRIC_PATH, metricDescription, metricTool } from './tools/metric.js';
import { COMPARE_PATH, compareDescription, compareTool } from './tools/compare.js';
import { ASK_PATH, askDescription, askTool } from './tools/ask.js';
import { SPEND_DESCRIPTION, spendTool } from './tools/spend.js';
import { NO_KEY_MESSAGE, failure, findRoute, toToolError, type ToolContext, type ToolResult } from './tools/shared.js';

export const SERVER_NAME = 'algoterminal';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = `AlgoTerminal serves standardized financial KPIs for Algorand DeFi protocols.
Every number it returns is computed under ONE published accounting policy, which is what makes a DEX and a
lending market comparable on the same axis.

Two tools are FREE and make no payment: algoterminal_catalog and algoterminal_methodology. Use them freely.
Start with catalog — it tells you, live, which protocols publish which KPIs, what each route costs, and which
routes this deployment can actually serve.

The rest spend the user's own USDC from the user's own Algorand account, one payment per call, under caps the
user set. When a cap refuses a call, nothing was spent; relay the refusal rather than retrying.

When you report a number from this service, carry its qualifications with it. Every fact arrives with a 0-1
confidence score (>=0.9 safe to act on, 0.7-0.9 directional only, <0.7 informational), a cache state, a
staleness flag, and notes explaining what cost it confidence. A bare number without those is a misreport.

RATIO values are decimal fractions, never percentages: 0.0369 means 3.69%.

Some protocols deliberately DECLINE some KPIs and say why. That is a fact about what the source discloses, not
missing data. Report the reason; never substitute zero.

Errors cost nothing. The service settles payment only after a successful response, so a 404, a 422, a 502 and
a timeout are all free. Retrying after a transient failure is not throwing money away.`;

export interface BuildResult {
  readonly server: McpServer;
  readonly ctx: ToolContext;
  readonly payer: PaymentBackend | null;
  /** The catalog read at startup, or null if the service was unreachable. */
  readonly catalog: Catalog | null;
  readonly registeredTools: string[];
}

export interface BuildOptions {
  baseFetch?: typeof globalThis.fetch;
  /**
   * Supply the payment backend, for tests and for embedding.
   *
   * A factory rather than an instance, and deliberately so: the ledger is
   * created here and there is exactly one of it. Accepting a ready-made backend
   * would let a caller hand over one bound to a different ledger, and the
   * failure mode of that is a spend counter that reports zero while the wallet
   * empties — the single worst bug this server could have.
   */
  payer?: (ledger: SpendLedger) => PaymentBackend | null;
}

export async function buildServer(config: Config, options: BuildOptions = {}): Promise<BuildResult> {
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  const ledger = new SpendLedger(config.maxSessionAtomic, config.maxPerCallAtomic);

  const payer =
    options.payer !== undefined
      ? options.payer(ledger)
      : config.mnemonic === null
        ? null
        : new Payer(config, ledger, baseFetch);

  const client = new AlgoTerminalClient(config, payer, baseFetch);
  const ctx: ToolContext = { client, ledger, config };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  /**
   * Nothing thrown by a handler should reach the transport as an opaque
   * protocol error. A model can act on "REFUSED: over budget, nothing was
   * spent"; it cannot act on "MCP error -32603".
   */
  const guarded = async (run: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await run();
    } catch (cause) {
      return toToolError(cause, ledger);
    }
  };

  /** Paid tools without a key explain the setup rather than failing obscurely. */
  const withPayer = async (run: () => Promise<ToolResult>): Promise<ToolResult> =>
    payer === null ? failure(NO_KEY_MESSAGE, ledger.render()) : await guarded(run);

  // The live contract. Read once here to price the tool descriptions honestly;
  // every handler re-reads it per call, so this snapshot is never the authority
  // on coverage — only on what to say in a description at registration time.
  let catalog: Catalog | null = null;
  try {
    catalog = await client.getCatalog();
  } catch {
    catalog = null;
  }

  const metricRoute = catalog === null ? undefined : findRoute(catalog, METRIC_PATH);
  const compareRoute = catalog === null ? undefined : findRoute(catalog, COMPARE_PATH);
  const askRoute = catalog === null ? undefined : findRoute(catalog, ASK_PATH);

  const registeredTools: string[] = [];

  server.registerTool(
    'algoterminal_catalog',
    { title: 'AlgoTerminal catalog (free)', description: CATALOG_DESCRIPTION, inputSchema: {} },
    async () => await guarded(async () => await catalogTool(ctx)),
  );
  registeredTools.push('algoterminal_catalog');

  server.registerTool(
    'algoterminal_methodology',
    {
      title: 'AlgoTerminal methodology (free)',
      description: METHODOLOGY_DESCRIPTION,
      inputSchema: {
        kpi: z
          .string()
          .optional()
          .describe('Narrow to one KPI id, e.g. "capital_efficiency". Omit for the whole policy.'),
        format: z
          .enum(['json', 'markdown'])
          .optional()
          .describe(
            'json (default) returns the structured policy: definitions, units, thresholds as numbers. ' +
              'markdown returns the full policy document with the reasoning behind each definition.',
          ),
      },
    },
    async (args) => await guarded(async () => await methodologyTool(ctx, args)),
  );
  registeredTools.push('algoterminal_methodology');

  server.registerTool(
    'algoterminal_get_metric',
    {
      title: 'AlgoTerminal: one KPI, one protocol (paid)',
      description: metricDescription({
        base: metricRoute?.price_usdc ?? '0.005',
        fresh: metricRoute?.price_fresh_usdc ?? '0.02',
        activeUsers: metricRoute?.price_active_users_usdc ?? '0.03',
      }),
      inputSchema: {
        protocol: z.string().describe('Protocol id exactly as listed by algoterminal_catalog, e.g. "tinyman".'),
        kpi: z.string().describe('KPI id exactly as listed by algoterminal_catalog for that protocol, e.g. "tvl".'),
        fresh: z
          .boolean()
          .optional()
          .describe(
            'Force an upstream fetch instead of taking the cached value. Costs several times more and is ' +
              'much slower. Only worth it when recency is the point; the cached value reports its own age.',
          ),
        basis: z
          .string()
          .optional()
          .describe('Inclusion basis, e.g. "all_pools_usd_priced" (default) or "verified_only".'),
      },
    },
    async (args) => await withPayer(async () => await metricTool(ctx, args)),
  );
  registeredTools.push('algoterminal_get_metric');

  server.registerTool(
    'algoterminal_compare',
    {
      title: 'AlgoTerminal: one KPI across protocols (paid)',
      description: compareDescription({
        base: compareRoute?.price_usdc ?? '0.05',
        fresh: compareRoute?.price_fresh_usdc ?? '0.08',
      }),
      inputSchema: {
        protocols: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe('2 to 5 protocol ids as listed by algoterminal_catalog, e.g. ["tinyman","pact","folks"].'),
        metric: z.string().describe('The KPI id to compare on, e.g. "capital_efficiency".'),
        fresh: z
          .boolean()
          .optional()
          .describe('Force an upstream fetch on EVERY leg. Substantially more expensive and much slower.'),
        basis: z.string().optional().describe('Inclusion basis applied to every leg.'),
      },
    },
    async (args) => await withPayer(async () => await compareTool(ctx, args)),
  );
  registeredTools.push('algoterminal_compare');

  // Registered ONLY when the deployment reports it available. On the current
  // TestNet deployment it is not, so this tool does not exist there at all.
  if (askRoute?.available === true) {
    server.registerTool(
      'algoterminal_ask',
      {
        title: 'AlgoTerminal: natural-language question (paid)',
        description: askDescription({
          base: askRoute.price_usdc,
          deep: askRoute.price_deep_usdc ?? askRoute.price_usdc,
        }),
        inputSchema: {
          question: z.string().max(500).describe('A descriptive question about Algorand DeFi. Max 500 characters.'),
          depth: z
            .enum(['standard', 'deep'])
            .optional()
            .describe('"deep" sweeps more KPIs and costs more. Default "standard".'),
          max_facts: z.number().int().min(1).max(24).optional().describe('Cap on facts returned. 1-24.'),
          format: z
            .enum(['prose', 'facts', 'both'])
            .optional()
            .describe('facts[] is always returned regardless of this. "both" is the default.'),
        },
      },
      async (args) => await withPayer(async () => await askTool(ctx, args)),
    );
    registeredTools.push('algoterminal_ask');
  }

  server.registerTool(
    'algoterminal_spend',
    { title: 'AlgoTerminal spend and wallet status (free)', description: SPEND_DESCRIPTION, inputSchema: {} },
    async () => await guarded(async () => await spendTool(ctx, payer?.address ?? null)),
  );
  registeredTools.push('algoterminal_spend');

  return { server, ctx, payer, catalog, registeredTools };
}
