/**
 * Rendering facts for a model that is about to paraphrase them.
 *
 * The failure this file is built against is specific and it is the expensive
 * one: the calling model reads `{"value": 5344337, "confidence": 0.70}`, decides
 * the confidence is metadata, and tells a human "Tinyman's TVL is $5.3 million."
 * The number survives; every qualification on it does not. The user then acts on
 * a figure whose USD leg is only as good as the price feed under it, and neither
 * they nor the model knows that.
 *
 * Three rules follow, and they are why this is prose and not `JSON.stringify`:
 *
 *  1. **A caveat is a sentence, not a field.** `confidence: 0.55` gets stripped.
 *     "INFORMATIONAL ONLY — do not present this number without this warning"
 *     survives a paraphrase, because it reads as instruction rather than schema.
 *  2. **Never derive a number.** No rounding to millions, no percent conversion,
 *     no computed ratios. Every numeral printed here is one the API returned.
 *     Thousands separators are added because they lose no digits; nothing else
 *     is transformed.
 *  3. **The raw JSON goes out too.** Prose can be misread; the exact response is
 *     appended verbatim so a model that wants a precise figure has one, and so a
 *     human can audit what the prose claims against what arrived.
 */
import type { CompareResponse, KpiFact, AskResponse, Unit } from './types.js';

export const CONFIDENCE_SAFE_TO_ACT = 0.9;
export const CONFIDENCE_DIRECTIONAL = 0.7;

/** Group thousands without losing a single digit of what the API sent. */
function group(value: number): string {
  const raw = String(value);
  const [intPart = '', fracPart] = raw.split('.');
  if (raw.includes('e') || raw.includes('E')) return raw;
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign === '-' ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fracPart === undefined ? '' : `.${fracPart}`}`;
}

/**
 * The value, exactly as returned, with the unit explained.
 *
 * RATIO gets a sentence rather than a percentage. The API has no percentages
 * anywhere, and converting one here would put a numeral in the output that the
 * service did not produce — the precise thing rule 2 forbids.
 */
export function renderValue(value: number | null, unit: Unit | null): string {
  if (value === null) {
    return 'null (the service could not compute this and says so rather than returning a plausible zero)';
  }
  switch (unit) {
    case 'USD':
      return `${value} USD ($${group(value)})`;
    case 'RATIO':
      return (
        `${value} (unit RATIO — a decimal fraction, NOT a percentage. This API has no percentages ` +
        'anywhere. Multiply by one hundred if you need to express it as one, and say that you did.)'
      );
    case 'COUNT':
      return `${value} (unit COUNT — a count of entities, not a dollar amount)`;
    case 'ASSET_UNITS':
      return `${value} ASSET_UNITS (denominated in the asset, not in USD)`;
    default:
      return `${value}${unit === null ? '' : ` ${unit}`}`;
  }
}

/**
 * The value alone, for a list where the unit has already been stated once.
 *
 * The long form belongs on a single fact, where it is the only thing being
 * read. Repeating it on every row of a ranking buries the numbers it is meant
 * to qualify, and a qualification nobody reads is not a qualification.
 */
export function renderValueCompact(value: number | null, unit: Unit | null): string {
  if (value === null) return 'null (not computable — see the leg below)';
  return unit === 'USD' ? `${value} ($${group(value)})` : String(value);
}

/** One line explaining the unit, to head a list rather than repeat within it. */
export function unitConvention(unit: Unit): string {
  switch (unit) {
    case 'USD':
      return 'All values are USD.';
    case 'RATIO':
      return (
        'All values are unit RATIO — decimal fractions, NOT percentages. This API has no percentages ' +
        'anywhere. Multiply by one hundred to express one as a percentage, and say that you did.'
      );
    case 'COUNT':
      return 'All values are unit COUNT — counts of entities, not dollar amounts.';
    case 'ASSET_UNITS':
      return 'All values are unit ASSET_UNITS — denominated in the asset, not in USD.';
    default:
      return `All values are unit ${String(unit)}.`;
  }
}

/** The confidence line. Loud in proportion to how little the number can carry. */
export function renderConfidence(confidence: number, prefix = ''): string {
  if (confidence >= CONFIDENCE_SAFE_TO_ACT) {
    return `${prefix}CONFIDENCE ${confidence} — at or above 0.9: safe to act on.`;
  }
  if (confidence >= CONFIDENCE_DIRECTIONAL) {
    return (
      `${prefix}!! CONFIDENCE ${confidence} — DIRECTIONALLY SOUND ONLY (0.7-0.9). ` +
      'This number is good enough to compare and to reason about, and not good enough to settle a trade on. ' +
      'Read the notes below; they say which step cost the confidence. State this qualification whenever you ' +
      'state the number.'
    );
  }
  return (
    `${prefix}!!! LOW CONFIDENCE ${confidence} — BELOW 0.7: INFORMATIONAL ONLY. ` +
    'This number is NOT safe to act on and must NOT be presented as a fact. If you repeat it to a human, ' +
    'repeat this warning with it, in the same sentence. Do not round it, do not summarize it, and do not ' +
    'use it as an input to any other figure.'
  );
}

function factHeadline(fact: KpiFact, compact: boolean): string {
  if (fact.error !== undefined) {
    return `${fact.protocol} / ${fact.metric}: UNAVAILABLE — ${fact.error.code}: ${fact.error.message}`;
  }
  const value = compact ? renderValueCompact(fact.value, fact.unit) : renderValue(fact.value, fact.unit);
  return `${fact.protocol} / ${fact.metric} = ${value}`;
}

/**
 * One KpiFact, with everything that qualifies it above the fold.
 *
 * `compact` drops the per-value unit explanation, for lists where the unit has
 * already been stated once at the top of the same message.
 */
export function renderFact(fact: KpiFact, indent = '', compact = false): string {
  const lines: string[] = [`${indent}${factHeadline(fact, compact)}`];

  if (fact.error !== undefined) {
    lines.push(
      `${indent}  This leg did not resolve. It is reported rather than dropped so the comparison is honest ` +
        'about what is missing. Do not fill the gap with a zero or an estimate.',
    );
    return lines.join('\n');
  }

  lines.push(`${indent}  ${renderConfidence(fact.confidence)}`);

  if (fact.is_estimated === true) {
    lines.push(
      `${indent}  !! ESTIMATED, not measured` +
        `${fact.estimation_method === null || fact.estimation_method === undefined ? '' : ` — method: ${fact.estimation_method}`}. ` +
        'Say so when you report it.',
    );
  }

  if (fact.stale === true) {
    lines.push(
      `${indent}  !! STALE — this is a previously computed number served past its TTL, not a current one. ` +
        `The notes say how old. Its as_of timestamp (${fact.as_of ?? 'not given'}) is the moment it describes.`,
    );
  }

  lines.push(
    `${indent}  as_of ${fact.as_of ?? '(not given)'} — the moment the data describes` +
      ` | computed ${fact.timestamp} — when the service calculated it` +
      ` | cache ${fact.cache ?? 'unknown'}`,
  );
  lines.push(`${indent}  methodology_version ${fact.methodology_version}`);

  if (fact.coverage !== undefined) {
    lines.push(
      `${indent}  coverage: ${fact.coverage.entities} entities included, ${fact.coverage.excluded} excluded, ` +
        `basis "${fact.coverage.basis}" — two facts on different bases are measuring different populations.`,
    );
  }

  if (fact.source !== undefined && fact.source.length > 0) {
    const names = [...new Set(fact.source.map((s) => s.name))];
    lines.push(`${indent}  sources: ${names.join(', ')} (${fact.source.length} provenance refs)`);
  }

  const notes = fact.notes ?? [];
  if (notes.length > 0) {
    lines.push(
      `${indent}  NOTES — these qualify the number above and travel with it. Do not drop them when summarizing:`,
    );
    notes.forEach((note, i) => lines.push(`${indent}    ${i + 1}. ${note}`));
  }

  return lines.join('\n');
}

export function renderMetricResult(fact: KpiFact): string {
  return renderFact(fact);
}

export function renderCompareResult(cmp: CompareResponse): string {
  const lines: string[] = [
    `COMPARISON: ${cmp.metric} (${cmp.unit}) across ${cmp.facts.length} protocol(s)`,
    `methodology_version ${cmp.methodology_version} | computed ${cmp.timestamp} | cache ${cmp.cache}${
      cmp.stale ? ' | !! STALE (the worst cache state across the legs)' : ''
    }`,
    '',
    unitConvention(cmp.unit),
    '',
    'RANKING',
    `  basis: ${cmp.ranking_basis}`,
    '  Rank 1 is the LARGEST value, not the "best" one. Some of these KPIs are arguably better low, and ' +
      'which is better depends on which side of the trade you are on. The service does not take that position ' +
      'and neither should you.',
  ];

  for (const row of cmp.ranking) {
    lines.push(`  #${row.rank} ${row.protocol}: ${renderValueCompact(row.value, cmp.unit)}`);
  }

  if (cmp.spread === null) {
    lines.push('', 'SPREAD: not computable for this set.');
  } else {
    lines.push(
      '',
      `SPREAD: min ${cmp.spread.min}, max ${cmp.spread.max}, ratio ${
        cmp.spread.ratio === null
          ? 'null — the lowest value is zero or negative, so a multiple would not be a real number. ' +
            'The service returns null deliberately rather than an unbounded or undefined value; ' +
            'do not compute one yourself.'
          : `${cmp.spread.ratio}x`
      }`,
    );
  }

  lines.push(
    '',
    `COMPARABILITY: ${cmp.comparability.confidence} — this is the MINIMUM across the legs, never the mean. ` +
      'A comparison is only as trustworthy as its weakest side.',
    `  ${cmp.comparability.note}`,
  );

  // Verbatim, in full, unabridged. The cross-class caveat is the argument for
  // why a DEX and a lending market belong on one axis at all — it is the
  // product, not boilerplate, and paraphrasing it would sell the wrong thing.
  if (cmp.comparability.caveats.length > 0) {
    lines.push(
      '',
      'CAVEATS — reproduced verbatim from the service. These are the part worth reading. Carry them with any ' +
        'statement you make about this comparison; do not paraphrase or condense them:',
    );
    cmp.comparability.caveats.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  } else {
    lines.push('', 'CAVEATS: none — the service generates these per response and found nothing that warranted one.');
  }

  if (cmp.partial) {
    lines.push(
      '',
      `!! PARTIAL COMPARISON — excluded: ${cmp.excluded_protocols.join(', ')}. ` +
        'At least two legs resolved, so this is a usable comparison, but it is not the one that was asked for. ' +
        'Name the excluded protocols and the reason below when you report it.',
    );
  }

  lines.push('', 'EVERY LEG, including any that failed:');
  for (const fact of cmp.facts) lines.push(renderFact(fact, '  ', true), '');

  return lines.join('\n').trimEnd();
}

export function renderAskResult(ask: AskResponse): string {
  const lines: string[] = [
    `QUESTION: ${ask.question}`,
    `depth ${ask.depth} | format ${ask.format} | methodology_version ${ask.methodology_version} | cache ${ask.cache}`,
    `models: router ${ask.model.router}, synthesizer ${ask.model.synthesizer}`,
    '',
    renderConfidence(ask.confidence, 'OVERALL '),
    '',
    'ANSWER (prose is a convenience over the facts below, never a substitute for them — every number in it ' +
      'corresponds to a fact in FACTS, and the service enforces that on its side):',
    ask.answer,
  ];

  if (ask.caveats.length > 0) {
    lines.push('', 'CAVEATS — verbatim from the service, carry them with the answer:');
    ask.caveats.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }

  lines.push('', `FACTS (${ask.facts.length}) — the numbers the answer rests on:`);
  for (const fact of ask.facts) lines.push(renderFact(fact, '  '), '');

  if (ask.citations.length > 0) {
    lines.push('CITATIONS — each claim mapped to the fact index it rests on:');
    for (const c of ask.citations) lines.push(`  ${JSON.stringify(c)}`);
  }

  return lines.join('\n').trimEnd();
}

/**
 * The receipt. Both halves matter: the price, so the model can reason about
 * whether the next call is worth making, and the txid, so the human can check
 * on chain that they were charged what they were told.
 */
export function renderReceipt(args: {
  label: string;
  paidUsdc: string;
  txid: string | null;
  explorerTxBase: string;
  spendLine: string;
}): string {
  const lines = [`PAID: ${args.paidUsdc} USDC for ${args.label}.`];
  if (args.txid === null) {
    lines.push(
      'No settlement receipt on this response — the service returned data without a PAYMENT-RESPONSE header. ' +
        'Treat the spend counter below as authoritative only for calls that did settle.',
    );
  } else {
    lines.push(`Settlement txid: ${args.txid}`, `Explorer: ${args.explorerTxBase}/${args.txid}`);
  }
  lines.push(args.spendLine);
  return lines.join('\n');
}

/** The exact bytes the service returned, so nothing here has to be trusted. */
export function renderRaw(body: unknown): string {
  return `RAW RESPONSE (verbatim from the service — the authority for every number above):\n${JSON.stringify(
    body,
    null,
    2,
  )}`;
}
