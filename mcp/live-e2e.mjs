/**
 * Live end-to-end run against the deployed TestNet service.
 *
 * Drives the MCP server over stdio exactly as Claude Desktop does. Every
 * payment here is a real x402 settlement in TestNet USDC from a real account.
 *
 *   ALGOTERMINAL_MNEMONIC='<25 words>' node live-e2e.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CWD = new URL('.', import.meta.url).pathname;

async function session(envOverrides = {}) {
  const client = new Client({ name: 'live-e2e', version: '1' });
  await client.connect(new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    cwd: CWD,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALGOTERMINAL_MNEMONIC: process.env.ALGOTERMINAL_MNEMONIC,
      ...envOverrides,
    },
    stderr: 'inherit',
  }));
  return client;
}

const rule = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);

async function call(client, name, args = {}, { raw = false } = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join('\n\n');
  rule(`TOOL: ${name} ${JSON.stringify(args)}   (${Date.now() - t0} ms)${r.isError ? '   [isError]' : ''}`);
  console.log(raw ? text : text.split('\nRAW RESPONSE')[0].trimEnd());
  return text;
}

const main = await session();
console.log('TOOLS:', (await main.listTools()).tools.map((t) => t.name).join(', '));
console.log('(algoterminal_ask is absent: /catalog reports the route unavailable on this deployment)');

await call(main, 'algoterminal_spend');
await call(main, 'algoterminal_get_metric', { protocol: 'folks', kpi: 'tvl' });
await call(main, 'algoterminal_get_metric', { protocol: 'pact', kpi: 'take_rate' });
await call(main, 'algoterminal_spend');
await main.close();

rule('SECOND SERVER, per-call cap lowered to $0.001 — a paid call must be REFUSED for free');
const capped = await session({ ALGOTERMINAL_MAX_PER_CALL_USDC: '0.001', ALGOTERMINAL_MAX_SPEND_USDC: '0.01' });
await call(capped, 'algoterminal_get_metric', { protocol: 'tinyman', kpi: 'tvl' });
await call(capped, 'algoterminal_spend');
await capped.close();
