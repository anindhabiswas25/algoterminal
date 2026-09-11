/**
 * `algoterminal_methodology` — FREE.
 *
 * AlgoTerminal's differentiator is not the data, it is the accounting policy:
 * one consistent definition applied across a DEX and a lending market, so
 * `gross_fees` means the same economic thing for a Tinyman swap fee and a Folks
 * borrower interest payment. That is what makes a cross-protocol ratio a real
 * ratio rather than two unrelated numbers divided by each other.
 *
 * Which means this tool answers the question a user actually asks after seeing a
 * number — "what does that mean?", "can I really compare those?" — for free,
 * before anyone pays for another one.
 *
 * The service serves this document two ways and the choice is not cosmetic. JSON
 * is generated from the same constants the service computes with, so the
 * confidence thresholds an agent tests against are the ones it enforces.
 * Markdown is the policy document itself, byte for byte, where the arguments
 * live. This tool defaults to JSON and offers markdown for the reasoning.
 */
import { text, failure, type ToolContext, type ToolResult } from './shared.js';
import { mapError, renderError } from '../errors.js';
import { renderRaw } from '../format.js';

export const METHODOLOGY_DESCRIPTION =
  'FREE — costs nothing, makes no payment. AlgoTerminal\'s published accounting policy: how each KPI is ' +
  'defined, what unit it carries, which protocol classes it applies to, and — the part that matters for ' +
  'cross-protocol work — the `cross_class_basis` explaining WHY a given KPI is comparable between a DEX and ' +
  'a lending market. Also returns the confidence ladder as numbers (>=0.9 safe to act on, 0.7-0.9 ' +
  'directional, <0.7 informational). Use this whenever a user asks what a number means, how it was ' +
  'computed, or whether two protocols can honestly be compared on it. Pass `kpi` to narrow it to one; pass ' +
  'format="markdown" for the full policy document with the reasoning behind each definition.';

export interface MethodologyArgs {
  kpi?: string | undefined;
  format?: 'json' | 'markdown' | undefined;
}

interface MethodologyKpi {
  id: string;
  unit: string;
  classes: string[];
  definition: string;
  ttl_seconds?: number;
  cross_class_basis?: string;
  [k: string]: unknown;
}

interface MethodologyDoc {
  service: string;
  methodology_version: string;
  document_url?: string;
  kpis: MethodologyKpi[];
  confidence?: Record<string, unknown>;
  units?: string[];
  protocol_classes?: string[];
  protocols?: unknown;
  [k: string]: unknown;
}

function renderKpi(kpi: MethodologyKpi): string {
  const lines = [
    `${kpi.id} — unit ${kpi.unit} — applies to: ${kpi.classes.join(', ')}`,
    `  definition: ${kpi.definition}`,
  ];
  if (kpi.ttl_seconds !== undefined) {
    lines.push(`  cache TTL: ${kpi.ttl_seconds}s (how long a computed value is served before recomputation)`);
  }
  if (kpi.cross_class_basis !== undefined) {
    lines.push(
      '  CROSS-CLASS BASIS — why this KPI is comparable across different kinds of protocol. Quote this ' +
        'whenever you put a DEX and a lending market on the same axis; it is the justification, and without ' +
        'it the comparison is an assertion:',
      `    ${kpi.cross_class_basis}`,
    );
  }
  return lines.join('\n');
}

export async function methodologyTool(ctx: ToolContext, args: MethodologyArgs): Promise<ToolResult> {
  if (args.format === 'markdown') {
    const res = await ctx.client.getFree('/methodology', { format: 'markdown' });
    if (!res.ok) return failure(renderError(mapError(res.status, res.body)));
    return text(
      'ALGOTERMINAL ACCOUNTING POLICY (the published document, verbatim). This is free and no payment was made.',
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2),
    );
  }

  const res = await ctx.client.getFree('/methodology');
  if (!res.ok) return failure(renderError(mapError(res.status, res.body)));
  const doc = res.body as MethodologyDoc;

  if (args.kpi !== undefined && args.kpi !== '') {
    const found = doc.kpis.find((k) => k.id === args.kpi);
    if (found === undefined) {
      return failure(
        `No KPI named "${args.kpi}" in methodology version ${doc.methodology_version}. Nothing was spent.`,
        `KPIs the policy defines: ${doc.kpis.map((k) => k.id).join(', ')}`,
        'Call algoterminal_catalog (also free) to see which protocols publish which of these.',
      );
    }
    return text(
      `ALGOTERMINAL METHODOLOGY ${doc.methodology_version} — one KPI. Free; no payment was made.`,
      renderKpi(found),
      `Full policy document (prose, with the arguments): ${doc.document_url ?? 'GET /methodology?format=markdown'}`,
      renderRaw(found),
    );
  }

  const lines: string[] = [
    `ALGOTERMINAL METHODOLOGY ${doc.methodology_version} — free; no payment was made.`,
    '',
    'ONE POLICY, APPLIED ACROSS EVERY PROTOCOL. This is the differentiator: `gross_fees_24h` means the same ' +
      'economic thing for a Tinyman swap fee and a Folks borrower interest payment — what users paid to use ' +
      'the protocol — which is what makes a cross-protocol ratio a real ratio.',
    '',
    'UNITS: ' + (doc.units ?? []).join(', ') + '. RATIO is always a decimal fraction; there are no ' +
      'percentages anywhere in this API. A RATIO of 0.05 is five percent.',
    '',
    'KPI DEFINITIONS',
  ];
  for (const kpi of doc.kpis) lines.push('', renderKpi(kpi));

  const ladder = doc.confidence as { ladder?: { tier: string; min: number; meaning: string }[] } | undefined;
  if (ladder?.ladder !== undefined) {
    lines.push('', 'CONFIDENCE LADDER — every fact carries a 0-1 score, and these are the thresholds:');
    for (const tier of ladder.ladder) lines.push(`  ${tier.tier}: >= ${tier.min} — ${tier.meaning}`);
    lines.push(
      '  A composite spanning two facts takes the MINIMUM of its inputs, never the mean.',
    );
  }

  lines.push('', `Full policy document (prose): ${doc.document_url ?? 'GET /methodology?format=markdown'}`);

  return text(lines.join('\n'), renderRaw(doc));
}
