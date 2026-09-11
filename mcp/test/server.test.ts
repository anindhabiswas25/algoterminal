/**
 * End-to-end over the MCP protocol itself, on an in-memory transport.
 *
 * Everything below goes through a real `Client` talking to a real `McpServer`,
 * so the schemas asserted here are the JSON Schema a calling model actually
 * receives — not the zod shapes that produced it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import { CATALOG, CATALOG_WITH_ASK, TINYMAN_TVL } from './fixtures.js';
import { BASE, RecordingPayer, stubFetch, testConfig } from './harness.js';

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
}

async function connect(catalogBody: unknown = CATALOG, withPayer = false) {
  const config = testConfig();
  const fetchStub = stubFetch({ '/catalog': { body: catalogBody } });
  // The ledger comes from buildServer, and the payer is built against that same
  // one. There is no way to wire up two.
  const built = await buildServer(config, {
    baseFetch: fetchStub.fetch,
    payer: (ledger) =>
      withPayer ? new RecordingPayer(ledger, () => ({ status: 200, body: TINYMAN_TVL }), 5000n) : null,
  });
  const ledger = built.ctx.ledger;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([client.connect(clientTransport), built.server.connect(serverTransport)]);
  return { client, built, fetchStub, ledger };
}

describe('tool schemas', () => {
  it('every tool has a name, a description and a valid object input schema', async () => {
    const { client } = await connect();
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^algoterminal_[a-z_]+$/);
      expect(tool.description ?? '').not.toBe('');
      expect(tool.inputSchema.type).toBe('object');
      // Every declared property is documented; an undocumented argument is one a
      // model will guess at.
      for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect((schema as { description?: string }).description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
    await client.close();
  });

  it('states in the description whether a tool is free or paid, and what a paid one costs', async () => {
    const { client } = await connect();
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']));

    for (const free of ['algoterminal_catalog', 'algoterminal_methodology', 'algoterminal_spend']) {
      expect(byName[free], free).toMatch(/^FREE — costs nothing, makes no payment/);
    }
    for (const paid of ['algoterminal_get_metric', 'algoterminal_compare']) {
      expect(byName[paid], paid).toMatch(/^PAID — spends the user's own USDC/);
    }
    await client.close();
  });

  it('quotes live prices from the catalog rather than hardcoded ones', async () => {
    // A deployment that has repriced everything. The descriptions must follow it.
    const repriced = {
      ...CATALOG,
      routes: CATALOG.routes.map((r) =>
        r.path === '/metric/{protocol}/{kpi}'
          ? { ...r, price_usdc: '0.007', price_fresh_usdc: '0.031', price_active_users_usdc: '0.044' }
          : r.path === '/compare'
            ? { ...r, price_usdc: '0.061', price_fresh_usdc: '0.099' }
            : r,
      ),
    };
    const { client } = await connect(repriced);
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']));

    expect(byName.algoterminal_get_metric).toContain('$0.007');
    expect(byName.algoterminal_get_metric).toContain('$0.031');
    expect(byName.algoterminal_get_metric).toContain('$0.044');
    expect(byName.algoterminal_get_metric).not.toContain('$0.005');
    expect(byName.algoterminal_compare).toContain('$0.061');
    expect(byName.algoterminal_compare).toContain('$0.099');
    await client.close();
  });

  it('constrains compare to 2-5 protocols in the schema itself', async () => {
    const { client } = await connect();
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    const compare = tools.find((t) => t.name === 'algoterminal_compare');
    const protocols = compare?.inputSchema.properties?.protocols as { minItems?: number; maxItems?: number };
    expect(protocols.minItems).toBe(2);
    expect(protocols.maxItems).toBe(5);
    await client.close();
  });
});

describe('conditional registration of /ask', () => {
  it('does not register algoterminal_ask when the deployment reports it unavailable', async () => {
    const { client, built } = await connect(CATALOG);
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    expect(tools.map((t) => t.name)).not.toContain('algoterminal_ask');
    expect(built.registeredTools).not.toContain('algoterminal_ask');
    await client.close();
  });

  it('registers it, priced, once the deployment reports it available', async () => {
    const { client } = await connect(CATALOG_WITH_ASK);
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    const ask = tools.find((t) => t.name === 'algoterminal_ask');
    expect(ask).toBeDefined();
    expect(ask?.description).toContain('$0.15');
    expect(ask?.description).toContain('$0.2');
    expect(ask?.description).toMatch(/no forecasts, no price targets/i);
    await client.close();
  });
});

describe('paid tools without a key', () => {
  it('explain the setup instead of failing obscurely, and never pay', async () => {
    const { client, ledger } = await connect(CATALOG, false);
    const result = (await client.callTool({
      name: 'algoterminal_get_metric',
      arguments: { protocol: 'tinyman', kpi: 'tvl' },
    })) as { content: { text: string }[]; isError?: boolean };

    const text = result.content.map((c) => c.text).join('\n');
    expect(result.isError).toBe(true);
    expect(text).toContain('NOT CONFIGURED');
    expect(text).toContain('ALGOTERMINAL_MNEMONIC');
    expect(text).toContain('ALGOTERMINAL_KEYFILE');
    expect(text).toContain('10458941');
    expect(text).toMatch(/never pays on anyone's behalf|never ship/i);
    expect(ledger.spentAtomic).toBe(0n);
    await client.close();
  });

  it('leaves the free tools fully working', async () => {
    const { client } = await connect(CATALOG, false);
    const result = (await client.callTool({ name: 'algoterminal_catalog', arguments: {} })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content.map((c) => c.text).join('\n')).toContain('Tinyman');
    await client.close();
  });
});

describe('a paid call over the protocol', () => {
  it('returns the fact with its caveats and a spend counter', async () => {
    const { client } = await connect(CATALOG, true);
    const result = (await client.callTool({
      name: 'algoterminal_get_metric',
      arguments: { protocol: 'tinyman', kpi: 'tvl' },
    })) as { content: { text: string }[] };
    const text = result.content.map((c) => c.text).join('\n');

    expect(text).toContain('CONFIDENCE 0.7');
    expect(text).toContain('DIRECTIONALLY SOUND ONLY');
    expect(text).toContain('PAID: 0.005000 USDC');
    expect(text).toContain('SESSION SPEND: 0.005000 USDC of 1.000000 cap');
    await client.close();
  });

  it('rejects arguments the schema forbids before any handler runs', async () => {
    const { client, ledger } = await connect(CATALOG, true);
    // One protocol violates minItems: 2. The SDK validates against the published
    // schema and never reaches the handler, so nothing is spent.
    const result = (await client.callTool({
      name: 'algoterminal_compare',
      arguments: { protocols: ['tinyman'], metric: 'tvl' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(ledger.spentAtomic).toBe(0n);
    await client.close();
  });
});

describe('server instructions', () => {
  it('tell the model to carry qualifications and that errors are free', async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toMatch(/carry its qualifications with it/);
    expect(instructions).toMatch(/RATIO values are decimal fractions/);
    expect(instructions).toMatch(/never substitute zero/);
    expect(instructions).toMatch(/Errors cost nothing/);
    await client.close();
  });
});

describe('startup resilience', () => {
  it('still registers every tool when the catalog is unreachable at startup', async () => {
    const config = testConfig();
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const built = await buildServer(config, { baseFetch: failing, payer: () => null });

    expect(built.catalog).toBeNull();
    expect(built.registeredTools).toContain('algoterminal_catalog');
    expect(built.registeredTools).toContain('algoterminal_get_metric');
    // /ask stays unregistered: unknown availability is not availability.
    expect(built.registeredTools).not.toContain('algoterminal_ask');
  });
});
