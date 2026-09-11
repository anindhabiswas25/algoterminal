/**
 * `algoterminal_catalog` — FREE.
 *
 * The tool a model should reach for first, and the reason the rest of this
 * server does not hardcode anything. Coverage grows as connectors are added,
 * prices are the service's to set, and route availability is a per-deployment
 * fact. Everything here is read live.
 *
 * The declines get the most space on purpose. Pact refusing to publish
 * `take_rate` is not a hole in the data — it is a measured fact about what Pact
 * discloses, and it is the single most likely thing for a calling model to
 * paper over with a zero.
 */
import { text, type ToolContext, type ToolResult } from './shared.js';
import type { Catalog } from '../types.js';
import { renderRaw } from '../format.js';

export const CATALOG_DESCRIPTION =
  'FREE — costs nothing, makes no payment. The live capability list for AlgoTerminal: which Algorand DeFi ' +
  'protocols are covered, which standardized KPIs each one publishes, which KPIs a protocol explicitly ' +
  'DECLINES to publish and the reason why, the current price of every paid route in USDC, and whether each ' +
  'route is actually available on this deployment. Call this BEFORE any paid tool: it is free, it is read ' +
  'live rather than hardcoded, and it tells you whether the thing you are about to pay for exists.';

export async function catalogTool(ctx: ToolContext): Promise<ToolResult> {
  const catalog: Catalog = await ctx.client.getCatalog();

  const lines: string[] = [
    `${catalog.service} — methodology_version ${catalog.methodology_version}`,
    `Payment settles on ${catalog.network} in ${catalog.payment.asset_symbol} (ASA ${catalog.payment.asset}, ` +
      `${catalog.payment.decimals} decimals) via x402 v${catalog.payment.version} scheme "${catalog.payment.scheme}".`,
    `Facilitator ${catalog.payment.facilitator} · payTo ${catalog.payment.payTo}` +
      `${catalog.payment.fee_sponsored ? ' · the facilitator sponsors the Algorand network fee, so a caller needs USDC only and no ALGO for gas' : ''}`,
    '',
    'NOTE ON CHAINS: the DATA describes Algorand MainNet protocols. The PAYMENT settles on the chain named ' +
      'above. Those are two different things.',
    '',
    'COVERAGE',
  ];

  for (const p of catalog.protocols) {
    lines.push('', `  ${p.id} — ${p.name} (${p.class})`);
    lines.push(`    publishes (${p.kpis.length}): ${p.kpis.join(', ')}`);
    if (p.sources !== undefined && p.sources.length > 0) {
      lines.push(`    sources: ${p.sources.join(', ')}`);
    }
    const declined = Object.entries(p.declined ?? {});
    if (declined.length > 0) {
      lines.push(
        `    DECLINES (${declined.length}) — requesting one of these returns 404 KPI_NOT_APPLICABLE and is NOT charged.`,
        '    A decline is a fact about what this source discloses, not a gap in coverage. Report the reason;',
        '    never substitute zero, and never quietly rank this protocol as if it had answered.',
      );
      for (const [kpi, reason] of declined) {
        lines.push(`      ${kpi}: ${reason}`);
      }
    }
  }

  lines.push('', 'ROUTES AND PRICES (USDC per call)');
  for (const r of catalog.routes) {
    const tiers = [`base $${r.price_usdc}`];
    if (r.price_fresh_usdc !== undefined) tiers.push(`fresh=true $${r.price_fresh_usdc}`);
    if (r.price_active_users_usdc !== undefined) tiers.push(`active_users_24h $${r.price_active_users_usdc}`);
    if (r.price_deep_usdc !== undefined) tiers.push(`depth=deep $${r.price_deep_usdc}`);
    lines.push(
      `  ${r.method} ${r.path}`,
      `    ${tiers.join(' · ')}`,
      `    ${r.available ? 'AVAILABLE on this deployment' : 'NOT AVAILABLE on this deployment — calling it returns 503'}`,
    );
  }

  lines.push(
    '',
    'BILLING: payment settles only after a successful response. Every 4xx and 5xx — including a declined KPI, ' +
      'an out-of-scope question, and a timeout — costs nothing.',
    '',
    ctx.ledger.render(),
  );

  return text(lines.join('\n'), renderRaw(catalog));
}
