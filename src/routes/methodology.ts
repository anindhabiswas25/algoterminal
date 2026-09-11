import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';

import { env } from '../config/env.js';
import { listConnectors } from '../connectors/registry.js';
import type { Connector } from '../connectors/types.js';
import { ApiError } from '../errors.js';
import {
  CONFIDENCE_DIRECTIONAL,
  CONFIDENCE_FLOOR,
  CONFIDENCE_SAFE_TO_ACT,
  DERIVATION_BASE,
  L2_SNAPSHOT_FLOOR,
  PENALTIES,
} from '../standardize/confidence.js';
import { KPI_IDS, KPI_REGISTRY } from '../standardize/kpis.js';
import { MIN_BILLABLE_CONFIDENCE } from './metric.js';
import { SERVICE_NAME } from './catalog.js';
import {
  DEFILLAMA_DIVERGENCE_THRESHOLD,
  MAX_EXCLUSION_RATIO,
  MIN_PRICE_CONFIDENCE,
  MIN_PRICE_LIQUIDITY_USD,
  MIN_TVL_USD,
  PROTOCOL_CLASSES,
  RETENTION_DIVERGENCE_THRESHOLD,
  UNITS,
} from '../standardize/types.js';

/**
 * `GET /methodology` — API_SPEC.md §1/§3. Free.
 *
 * DATA_SCHEMA.md is the published accounting policy. This route serves it.
 *
 * ## Markdown or JSON? Both, and JSON is the default. Here is why.
 *
 * The primary reader is an agent, and the two renderings answer different
 * questions for it:
 *
 *  - **JSON (default).** The parts of the methodology an agent *acts on* are
 *    numbers and enumerations: the confidence ladder's thresholds, each KPI's
 *    unit and applicable classes, which KPIs a protocol declines and why, the
 *    §3.6 inclusion thresholds. An agent deciding whether a `confidence: 0.81`
 *    fact clears its own bar needs `0.7` as a number, not a sentence containing
 *    it. Serving only markdown would force every caller to write a parser for
 *    our prose, and each of those parsers would be a place our policy is
 *    misread — silently, since a misparsed threshold produces a plausible
 *    answer.
 *  - **Markdown (`?format=markdown`, or `Accept: text/markdown`).** The parts
 *    an agent — or the human reviewing it — needs to *understand* are the
 *    arguments: why `capital_efficiency` is comparable across a DEX and a
 *    lending market, why Tinyman's TVL confidence went down when its accuracy
 *    went up. Those are prose and cannot be usefully structured. This is the
 *    document itself, byte for byte, not a rendering of it.
 *
 * The decisive point is the last one. **The JSON is generated from the same
 * constants the service computes with** — `KPI_REGISTRY`, `DERIVATION_BASE`,
 * `PENALTIES`, the connector registry — not extracted from the markdown. So the
 * published thresholds are, by construction, the thresholds actually applied.
 * A JSON rendering parsed out of the prose would be a third artefact to keep in
 * step, and the one most likely to be wrong. The markdown, meanwhile, is the
 * checked-in document with its own changelog, and a test asserts its top
 * changelog entry equals `METHODOLOGY_VERSION`, which is what stops the two
 * from disagreeing about which version they describe.
 *
 * `/ask` cites this route (`AskResponse.caveats` and the synthesis prompt both
 * point at it), which is the other reason the confidence ladder has to be
 * machine-readable: an agent told "this fact is below the 0.7 line" must be
 * able to look up what that line is without reading English.
 */

/** `?format=` on this route. */
export const METHODOLOGY_FORMATS = ['json', 'markdown'] as const;
export type MethodologyFormat = (typeof METHODOLOGY_FORMATS)[number];

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where DATA_SCHEMA.md might be, most-authoritative first.
 *
 * `../../docs/` resolves from both `src/routes/` under tsx and `dist/routes/`
 * in the deployed image, which is why the source tree and the build output have
 * the same depth. `public/methodology.md` is the fallback for a build that
 * ships the landing page but not `docs/` — it is not written by anything today,
 * and exists so that a deployment which loses the docs directory degrades to a
 * missing-document 503 on ONE rendering rather than a broken route.
 */
const DOCUMENT_CANDIDATES = [
  join(here, '..', '..', 'docs', 'DATA_SCHEMA.md'),
  join(here, '..', '..', 'public', 'methodology.md'),
  join(process.cwd(), 'docs', 'DATA_SCHEMA.md'),
];

let cached: string | null | undefined;

/** The document, read once and held. `null` when it is not in this image. */
export function methodologyMarkdown(): string | null {
  if (cached !== undefined) return cached;
  for (const path of DOCUMENT_CANDIDATES) {
    try {
      cached = readFileSync(path, 'utf8');
      return cached;
    } catch {
      // Try the next candidate. A missing file is the expected case for all
      // but one of them.
    }
  }
  cached = null;
  return cached;
}

/** Reset the memo. Tests only. */
export function resetMethodologyCache(): void {
  cached = undefined;
}

/**
 * The version the DOCUMENT claims, from the top of its `## Changelog`.
 *
 * Read rather than assumed so a test can assert it equals
 * `METHODOLOGY_VERSION`. The two drifting is not a cosmetic problem: the
 * version is in every cache key (`src/cache/keys.ts`) and on every fact, so a
 * document describing 1.1.0 while the service stamps 1.2.0 would have us
 * publishing the wrong formula for numbers we are selling.
 */
export function documentVersion(markdown: string | null): string | null {
  if (markdown === null) return null;
  const changelog = markdown.indexOf('## Changelog');
  if (changelog === -1) return null;
  return /^###\s+(\d+\.\d+\.\d+)\b/m.exec(markdown.slice(changelog))?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The structured rendering
// ---------------------------------------------------------------------------

function protocolPolicy(connector: Connector) {
  const caps = connector.capabilities();
  return {
    id: caps.id,
    name: caps.name,
    class: caps.class,
    kpis: [...caps.kpis],
    /**
     * §1.5: a KPI applicable to the class that this protocol does not publish,
     * with the reason. Pact's `take_rate` is the motivating case — the honest
     * answer is not "no such metric" but "the source does not publish its cut",
     * and an agent comparing take rates must be able to tell those apart
     * without reading prose.
     */
    declined: Object.entries(caps.declined ?? {}).map(([kpi, reason]) => ({ kpi, reason })),
    supports_basis: [...caps.supportsBasis],
    sources: [...caps.sourceHosts],
    ...(caps.appIds === undefined ? {} : { app_ids: [...caps.appIds] }),
  };
}

export function buildMethodology() {
  const markdown = methodologyMarkdown();
  const base = env.PUBLIC_BASE_URL;

  return {
    service: SERVICE_NAME,
    methodology_version: env.METHODOLOGY_VERSION,
    /** What the checked-in document says its own top version is. */
    document_version: documentVersion(markdown),
    document_url: `${base}/methodology?format=markdown`,
    document_available: markdown !== null,

    units: [...UNITS],
    protocol_classes: [...PROTOCOL_CLASSES],

    /** DATA_SCHEMA.md §4, generated from the registry the service computes with. */
    kpis: KPI_IDS.map((id) => {
      const kpi = KPI_REGISTRY[id];
      return {
        id,
        unit: kpi.unit,
        classes: [...kpi.applicableClasses],
        definition: kpi.description,
        ttl_seconds: kpi.ttlSeconds,
        ...('nullWhen' in kpi && kpi.nullWhen !== undefined
          ? { null_when: { rule: kpi.nullWhen.rule, threshold: kpi.nullWhen.threshold } }
          : {}),
        ...('maxConfidence' in kpi && kpi.maxConfidence !== undefined
          ? { max_confidence: kpi.maxConfidence }
          : {}),
        ...('crossClassBasis' in kpi && kpi.crossClassBasis !== undefined
          ? { cross_class_basis: kpi.crossClassBasis }
          : {}),
      };
    }),

    /** DATA_SCHEMA.md §5, including the buyer-facing ladder `/ask` cites. */
    confidence: {
      formula: 'base x multiplicative penalties, then the additive penalty, then per-KPI caps, floored and rounded to 2dp',
      bases: Object.entries(DERIVATION_BASE).map(([kind, base_value]) => ({
        derivation: kind,
        base: base_value,
        ...(kind === 'usd_conversion'
          ? { note: 'multiplied by the §3.7 price confidence for the assets involved' }
          : {}),
      })),
      penalties: Object.entries(PENALTIES).map(([kind, penalty]) => ({
        condition: kind,
        mode: penalty.mode,
        amount: penalty.amount,
      })),
      floor: CONFIDENCE_FLOOR,
      l2_snapshot_floor: L2_SNAPSHOT_FLOOR,
      composite_rule:
        'A composite spanning two facts takes the MINIMUM of its inputs, never the mean. A sum ' +
        'built from many prices takes the TVL-weighted mean of their price confidences — a ' +
        'different object, graded on the dollars it is made of.',
      /**
       * The §5 ladder, as thresholds rather than as a sentence.
       *
       * Note the strict inequality on `informational`. A fact at exactly 0.70
       * is `directional`, not `informational`, so the `/ask` caveat rule does
       * not fire on it. That boundary is load-bearing and is stated as a
       * number here precisely so a caller does not have to infer it.
       */
      ladder: [
        {
          tier: 'safe_to_act',
          min: CONFIDENCE_SAFE_TO_ACT,
          meaning: 'Safe to act on.',
        },
        {
          tier: 'directional',
          min: CONFIDENCE_DIRECTIONAL,
          below: CONFIDENCE_SAFE_TO_ACT,
          meaning: 'Directionally sound; check notes[].',
        },
        {
          tier: 'informational',
          below: CONFIDENCE_DIRECTIONAL,
          meaning:
            'Informational only. /ask explicitly caveats any fact strictly below this line in prose.',
        },
      ],
      /** Below this we decline and do not charge (`src/routes/metric.ts`). */
      min_billable: MIN_BILLABLE_CONFIDENCE,
      min_billable_note:
        'At or below this confidence we return 502 and do not charge, rather than sell a number ' +
        'whose error we can no longer bound.',
    },

    /** DATA_SCHEMA.md §3.6 / §3.7 — the thresholds, as numbers. */
    inclusion_filters: {
      min_entity_tvl_usd: MIN_TVL_USD,
      min_price_liquidity_usd: MIN_PRICE_LIQUIDITY_USD,
      min_price_confidence: MIN_PRICE_CONFIDENCE,
      max_exclusion_ratio: MAX_EXCLUSION_RATIO,
      defillama_divergence_threshold: DEFILLAMA_DIVERGENCE_THRESHOLD,
      folks_retention_divergence_threshold: RETENTION_DIVERGENCE_THRESHOLD,
    },

    /** Generated from the live registry, so it cannot advertise a stale policy. */
    protocols: listConnectors().map(protocolPolicy),

    versioning:
      'A change to a FORMULA is a methodology_version bump, announced here, with the previous ' +
      'version pinnable for one quarter. A breaking change to the envelope ships under /v2. ' +
      'Numbers never change silently. The version is part of every cache key, so a bump makes ' +
      'pre-bump entries unreachable rather than merely stale.',

    spec_url: `${base}/openapi.json`,
  };
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/**
 * Which rendering this request wants.
 *
 * `?format=` wins over `Accept`, because an explicit parameter is a stronger
 * signal than a header a client library may have set for it. An unknown format
 * is a 400 rather than a silent fall back to JSON — this route is a policy
 * document, and quietly serving a different rendering than the one asked for is
 * the same class of mistake as quietly serving a different `?basis=`.
 */
export function chooseFormat(
  formatParam: string | undefined,
  accept: string | undefined,
): MethodologyFormat {
  if (formatParam !== undefined) {
    if (!(METHODOLOGY_FORMATS as readonly string[]).includes(formatParam)) {
      throw new ApiError(400, 'INVALID_PARAM', `Unknown format "${formatParam}".`, {
        param: 'format',
        provided: formatParam,
        allowed: [...METHODOLOGY_FORMATS],
      });
    }
    return formatParam as MethodologyFormat;
  }
  return (accept ?? '').includes('text/markdown') ? 'markdown' : 'json';
}

export const methodology = new Hono();

methodology.get('/methodology', (c) => {
  const format = chooseFormat(c.req.query('format'), c.req.header('accept'));

  if (format === 'markdown') {
    const markdown = methodologyMarkdown();
    if (markdown === null) {
      // A deployment that did not ship the document. The JSON rendering is
      // generated from code and still correct, so say so and point at it
      // rather than returning an empty 200 that reads as "we have no policy".
      throw new ApiError(
        503,
        'DOCUMENT_UNAVAILABLE',
        'The methodology document is not present in this build. The structured rendering at ' +
          '/methodology is generated from the running code and is unaffected.',
        { format: 'markdown', json_url: `${env.PUBLIC_BASE_URL}/methodology` },
      );
    }
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('X-AlgoTerminal-Methodology', env.METHODOLOGY_VERSION);
    return c.body(markdown);
  }

  c.header('X-AlgoTerminal-Methodology', env.METHODOLOGY_VERSION);
  return c.json(buildMethodology());
});
