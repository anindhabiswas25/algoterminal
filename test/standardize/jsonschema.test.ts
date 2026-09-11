import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { registerSchema, unregisterSchema, validate } from '@hyperjump/json-schema/draft-2020-12';

import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import {
  ARTEFACT_PATH,
  KPI_FACT_SCHEMA_PATH,
  SCHEMA_ARTEFACT_BASE_URL,
  SCHEMA_VERSION_KEY,
  buildKpiFactJsonSchema,
} from '../../src/standardize/jsonschema.js';
import { KpiFactSchema } from '../../src/standardize/schema.js';
import { isFreeRoute } from '../../src/pricing.js';

/**
 * `GET /schema/kpi-fact.json` — the published `KpiFact` contract.
 *
 * The envelope is the product (PRD.md §4), so this document is the artefact a
 * buyer holds us to. Three claims are worth testing, and only three:
 *
 *  1. **It does not drift.** The checked-in `docs/kpi-fact.schema.json` is what
 *     a reviewer reads when the envelope changes. If the emitter and the file
 *     disagree, someone changed the contract without the diff that says so.
 *  2. **It agrees with the zod.** The generated half loses every `superRefine`,
 *     so the invariants are hand-written in `INVARIANTS` — and a hand-written
 *     rule is exactly the kind that rots. The corpus below runs each fact
 *     through both validators and requires the same verdict, which is the only
 *     check that can catch the two falling out of step.
 *  3. **It is free.** PRD.md §7.5: an agent must be able to evaluate us
 *     completely without paying, and this is the thing it most needs to read.
 */

const SCHEMA_URI = 'https://algoterminal.test/schema/kpi-fact.json';

/** A complete, valid success fact. Every case below is a mutation of this one. */
const VALID_FACT = {
  metric: 'tvl',
  protocol: 'tinyman',
  value: 5_344_337,
  unit: 'USD',
  timestamp: '2026-09-10T14:32:11.000Z',
  as_of: '2026-09-10T14:30:00.000Z',
  source: [
    {
      name: 'tinyman-analytics',
      url: 'https://mainnet.analytics.tinyman.org/api/v1/pools/',
      kind: 'rest',
      retrieved_at: '2026-09-10T14:30:02.000Z',
    },
  ],
  confidence: 0.7,
  is_estimated: false,
  estimation_method: null,
  methodology_version: '1.2.0',
  cache: 'hit',
  stale: false,
  coverage: { entities: 361, excluded: 20_255, basis: 'all_pools_usd_priced' },
  notes: [],
} as const;

const VALID_ERROR_FACT = {
  metric: 'take_rate',
  protocol: 'pact',
  value: null,
  unit: null,
  timestamp: '2026-09-10T14:32:11.000Z',
  error: { code: 'KPI_NOT_APPLICABLE', message: 'Pact does not publish its fee split.' },
  confidence: 0,
  methodology_version: '1.2.0',
} as const;

function withFact(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID_FACT, ...overrides };
}

/**
 * The corpus both validators must agree on.
 *
 * Every `false` case is one of the §1.2/§1.5 honesty guarantees stated as a
 * document a buyer might receive. If the published schema accepted any of them
 * it would be advertising an envelope we do not emit — and specifically it
 * would be telling an agent that a bare `null`, or an unlabelled estimate, is
 * something we might send it.
 */
const CORPUS: readonly { name: string; fact: unknown; valid: boolean }[] = [
  { name: 'a complete success fact', fact: VALID_FACT, valid: true },
  { name: 'a complete error fact', fact: VALID_ERROR_FACT, valid: true },
  {
    name: 'a labelled estimate with its method',
    fact: withFact({ is_estimated: true, estimation_method: 'annualized_rate_to_daily_simple' }),
    valid: true,
  },
  {
    name: 'a COUNT fact',
    fact: withFact({ metric: 'pool_count', unit: 'COUNT', value: 361 }),
    valid: true,
  },
  {
    name: 'an ASSET_UNITS fact naming its asset',
    fact: withFact({ unit: 'ASSET_UNITS', value: 1000, notes: ['asset_id: 31566704'] }),
    valid: true,
  },
  // ---- the guarantees, as things that must NOT validate ----
  {
    name: 'a null value with no error (§1.5, the plausible-looking zero)',
    fact: withFact({ value: null }),
    valid: false,
  },
  {
    name: 'an estimate with no estimation_method (§1.2, a laundered estimate)',
    fact: withFact({ is_estimated: true, estimation_method: null }),
    valid: false,
  },
  {
    name: 'an estimate with an empty estimation_method',
    fact: withFact({ is_estimated: true, estimation_method: '   ' }),
    valid: false,
  },
  {
    name: 'a reported value carrying an estimation_method',
    fact: withFact({ is_estimated: false, estimation_method: 'guessed' }),
    valid: false,
  },
  {
    name: 'a value with no source (§1.4, not reproducible)',
    fact: withFact({ source: [] }),
    valid: false,
  },
  {
    name: 'a value with no coverage',
    fact: (() => {
      const { coverage, ...rest } = withFact({});
      void coverage;
      return rest;
    })(),
    valid: false,
  },
  {
    name: 'a value with no as_of',
    fact: (() => {
      const { as_of, ...rest } = withFact({});
      void as_of;
      return rest;
    })(),
    valid: false,
  },
  {
    name: 'an error fact with a non-zero confidence',
    fact: { ...VALID_ERROR_FACT, confidence: 0.9 },
    valid: false,
  },
  {
    name: 'an error fact carrying a value',
    fact: { ...VALID_ERROR_FACT, value: 0, unit: 'USD' },
    valid: false,
  },
  {
    name: 'a COUNT with a fractional value (§2.1)',
    fact: withFact({ metric: 'pool_count', unit: 'COUNT', value: 361.5 }),
    valid: false,
  },
  {
    name: 'an ASSET_UNITS fact that does not name its asset (§2.1)',
    fact: withFact({ unit: 'ASSET_UNITS', value: 1000, notes: [] }),
    valid: false,
  },
  {
    name: 'an unknown field (the envelope is strict)',
    fact: withFact({ vibes: 'good' }),
    valid: false,
  },
  {
    name: 'a confidence above 1',
    fact: withFact({ confidence: 1.4 }),
    valid: false,
  },
];

describe('the published KpiFact JSON Schema', () => {
  it('matches the checked-in artefact — run `npm run schema:emit` to accept a change', () => {
    const onDisk = readFileSync(join(process.cwd(), ARTEFACT_PATH), 'utf8');
    const emitted = `${JSON.stringify(
      buildKpiFactJsonSchema(SCHEMA_ARTEFACT_BASE_URL, env.METHODOLOGY_VERSION),
      null,
      2,
    )}\n`;
    // Compared as parsed objects for a readable diff, and as text so key order
    // and formatting are pinned too: the file is meant to be read in a review,
    // and a reshuffled 200-line document is not reviewable.
    expect(JSON.parse(onDisk)).toEqual(JSON.parse(emitted));
    expect(onDisk).toBe(emitted);
  });

  it('is stamped with the version the service computes under', () => {
    const doc = buildKpiFactJsonSchema();
    expect(doc[SCHEMA_VERSION_KEY]).toBe(env.METHODOLOGY_VERSION);
    // The stamp is the whole reason the URL is unversioned: a buyer's cached
    // copy has to be able to identify itself.
    expect(JSON.parse(readFileSync(join(process.cwd(), ARTEFACT_PATH), 'utf8'))).toHaveProperty(
      SCHEMA_VERSION_KEY,
      env.METHODOLOGY_VERSION,
    );
  });

  describe('agrees with the zod it was generated from', () => {
    const doc = buildKpiFactJsonSchema('https://algoterminal.test');
    registerSchema({ ...doc, $id: SCHEMA_URI }, SCHEMA_URI);

    for (const { name, fact, valid } of CORPUS) {
      it(`${valid ? 'accepts' : 'rejects'} ${name}`, async () => {
        const zodVerdict = KpiFactSchema.safeParse(fact).success;
        const schemaVerdict = (await validate(SCHEMA_URI, fact)).valid;
        expect(zodVerdict, 'zod disagrees with the fixture').toBe(valid);
        expect(schemaVerdict, 'the published schema disagrees with the zod').toBe(valid);
      });
    }

    it('cleans up its registration', () => {
      unregisterSchema(SCHEMA_URI);
      expect(true).toBe(true);
    });
  });
});

describe(`GET ${KPI_FACT_SCHEMA_PATH}`, () => {
  it('is served free, as a schema document', async () => {
    const res = await createApp().request(KPI_FACT_SCHEMA_PATH);
    expect(res.status).toBe(200);
    // Never gated. PRD.md §7.5 — the contract has to be readable before anyone
    // decides to pay, and `pricing.ts` is where that is decided.
    expect(res.headers.get('payment-required')).toBeNull();
    expect(isFreeRoute(KPI_FACT_SCHEMA_PATH)).toBe(true);
    expect(res.headers.get('content-type')).toContain('application/schema+json');
    expect(res.headers.get('x-algoterminal-methodology')).toBe(env.METHODOLOGY_VERSION);
  });

  it('serves the document with this deployment’s own base URL', async () => {
    const res = await createApp().request(KPI_FACT_SCHEMA_PATH);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.$id).toBe(`${env.PUBLIC_BASE_URL}${KPI_FACT_SCHEMA_PATH}`);
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('is listed in /catalog with the version it is stamped with', async () => {
    const catalog = (await (await createApp().request('/catalog')).json()) as {
      schemas: { kpi_fact: string; methodology_version: string };
    };
    expect(catalog.schemas.kpi_fact).toBe(`${env.PUBLIC_BASE_URL}${KPI_FACT_SCHEMA_PATH}`);
    expect(catalog.schemas.methodology_version).toBe(env.METHODOLOGY_VERSION);
  });

  it('is listed in /llms.txt, where the buying decision is made', async () => {
    const llms = await (await createApp().request('/llms.txt')).text();
    expect(llms).toContain(`${env.PUBLIC_BASE_URL}${KPI_FACT_SCHEMA_PATH}`);
  });
});
