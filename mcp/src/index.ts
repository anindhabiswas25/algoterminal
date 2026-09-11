#!/usr/bin/env node
/**
 * Entry point. stdio transport, so it runs under Claude Desktop, Claude Code,
 * or anything else that speaks MCP over a pipe.
 *
 * Everything diagnostic goes to stderr. stdout is the protocol channel, and a
 * stray `console.log` there corrupts the stream — which presents to the user as
 * a server that "does not work" with no clue why.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, atomicToUsdc, loadConfig } from './config.js';
import { PaymentConfigError } from './payer.js';
import { SERVER_NAME, SERVER_VERSION, buildServer } from './server.js';

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    if (cause instanceof ConfigError) {
      log(`algoterminal-mcp: configuration error\n\n${cause.message}\n`);
      process.exit(1);
    }
    throw cause;
  }

  let built;
  try {
    built = await buildServer(config);
  } catch (cause) {
    if (cause instanceof PaymentConfigError) {
      log(`algoterminal-mcp: payment key error\n\n${cause.message}\n`);
      process.exit(1);
    }
    throw cause;
  }

  const { server, payer, catalog, registeredTools } = built;

  log(`${SERVER_NAME} ${SERVER_VERSION} — ${config.baseUrl}`);
  log(`  payment chain: ${config.network.id} (USDC ASA ${config.network.usdcAsaId})`);
  log(
    payer === null
      ? '  payer: NONE — paid tools will explain how to configure a key. Free tools work.'
      : `  payer: ${payer.address} (from ${config.keySource})`,
  );
  log(
    `  caps: ${atomicToUsdc(config.maxPerCallAtomic)} USDC per call, ` +
      `${atomicToUsdc(config.maxSessionAtomic)} USDC per session`,
  );
  if (catalog === null) {
    log(
      '  catalog: UNREACHABLE at startup — tool descriptions fall back to documented prices. ' +
        'Each call re-reads the catalog, so coverage stays live once the service is back.',
    );
  } else {
    log(
      `  catalog: ${catalog.protocols.length} protocols, methodology ${catalog.methodology_version}, ` +
        `routes ${catalog.routes.map((r) => `${r.path}${r.available ? '' : ' (unavailable)'}`).join(', ')}`,
    );
  }
  log(`  tools: ${registeredTools.join(', ')}`);

  await server.connect(new StdioServerTransport());
}

main().catch((cause: unknown) => {
  log(`algoterminal-mcp: fatal — ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
  process.exit(1);
});
