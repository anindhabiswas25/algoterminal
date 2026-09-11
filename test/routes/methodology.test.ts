import { describe, it, expect } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  buildMethodology,
  chooseFormat,
  documentVersion,
  methodologyMarkdown,
} from '../../src/routes/methodology.js';
import { ApiError } from '../../src/errors.js';
import { listConnectors } from '../../src/connectors/registry.js';
import { KPI_IDS, KPI_REGISTRY } from '../../src/standardize/kpis.js';
import {
  CONFIDENCE_DIRECTIONAL,
  CONFIDENCE_SAFE_TO_ACT,
  DERIVATION_BASE,
  PENALTIES,
  confidenceTier,
} from '../../src/standardize/confidence.js';

/**
 * `GET /methodology` — the published accounting policy.
 *
 * The load-bearing assertions here are the ones about *agreement*: between the
 * checked-in document and `METHODOLOGY_VERSION`, and between the published
 * confidence ladder and the function that actually grades facts. A policy
 * document that disagrees with the code is worse than no document, because a
 * caller acts on it.
 */

const VERSION = process.env.METHODOLOGY_VERSION as string;

describe('/methodology', () => {
  it('is free, JSON by default, with permissive CORS', async () => {
    const res = await createApp().request('/methodology');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-algoterminal-methodology')).toBe(VERSION);
  });

  it('serves the document itself under ?format=markdown', async () => {
    const res = await createApp().request('/methodology?format=markdown');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const body = await res.text();
    expect(body).toContain('# AlgoTerminal — Standardized Data Schema & Methodology');
    expect(body).toBe(methodologyMarkdown());
  });

  it('honours Accept: text/markdown, and lets ?format= override it', () => {
    expect(chooseFormat(undefined, 'text/markdown')).toBe('markdown');
    expect(chooseFormat(undefined, 'application/json')).toBe('json');
    expect(chooseFormat(undefined, undefined)).toBe('json');
    expect(chooseFormat('json', 'text/markdown')).toBe('json');
  });

  it('rejects an unknown format rather than quietly serving another one', () => {
    // Same class of mistake as quietly substituting a different ?basis=: the
    // caller would get a coherent answer to a question it did not ask.
    expect(() => chooseFormat('yaml', undefined)).toThrow(ApiError);
    try {
      chooseFormat('yaml', undefined);
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).detail.allowed).toEqual(['json', 'markdown']);
    }
  });

  /**
   * The document carries its own changelog. If its top entry and the version
   * the service stamps on every fact disagree, we are publishing the wrong
   * formula for numbers we are selling — and the version is in every cache key
   * (`src/cache/keys.ts`), so the disagreement would be invisible.
   */
  it('the document describes the version the service stamps', () => {
    expect(documentVersion(methodologyMarkdown())).toBe(VERSION);
    expect(buildMethodology().document_version).toBe(VERSION);
    expect(buildMethodology().methodology_version).toBe(VERSION);
  });

  it('publishes the §4 KPI registry the service computes with', () => {
    const body = buildMethodology();
    expect(body.kpis.map((k) => k.id)).toEqual([...KPI_IDS]);
    for (const kpi of body.kpis) {
      const row = KPI_REGISTRY[kpi.id];
      expect(kpi.unit).toBe(row.unit);
      expect(kpi.ttl_seconds).toBe(row.ttlSeconds);
      expect(kpi.classes).toEqual([...row.applicableClasses]);
    }
    // §4.1's hard cap is a number a caller can read, not a sentence to parse.
    expect(body.kpis.find((k) => k.id === 'active_users_24h')?.max_confidence).toBe(0.8);
  });

  it('publishes the §5 ladder as the thresholds confidenceTier actually applies', () => {
    const ladder = buildMethodology().confidence.ladder;
    const safe = ladder.find((t) => t.tier === 'safe_to_act')!;
    const directional = ladder.find((t) => t.tier === 'directional')!;
    const informational = ladder.find((t) => t.tier === 'informational')!;

    expect(safe.min).toBe(CONFIDENCE_SAFE_TO_ACT);
    expect(directional.min).toBe(CONFIDENCE_DIRECTIONAL);
    expect(informational.below).toBe(CONFIDENCE_DIRECTIONAL);

    // The published boundary must be the one the grader uses, in both
    // directions and exactly at the edge. 0.70 is `directional`, NOT
    // `informational` — which is what decides whether /ask caveats a fact.
    expect(confidenceTier(safe.min!)).toBe('safe_to_act');
    expect(confidenceTier(directional.min!)).toBe('directional');
    expect(confidenceTier(informational.below! - 0.01)).toBe('informational');
    expect(confidenceTier(0.7)).toBe('directional');
  });

  it('publishes the derivation bases and penalties from §5, not a copy of them', () => {
    const conf = buildMethodology().confidence;
    for (const [kind, base] of Object.entries(DERIVATION_BASE)) {
      expect(conf.bases.find((b) => b.derivation === kind)?.base).toBe(base);
    }
    for (const [kind, penalty] of Object.entries(PENALTIES)) {
      const published = conf.penalties.find((p) => p.condition === kind)!;
      expect(published.mode).toBe(penalty.mode);
      expect(published.amount).toBe(penalty.amount);
    }
  });

  /**
   * §1.5: a KPI a protocol declines is a finding about the source, not a hole
   * in our coverage — and an agent comparing take rates has to be able to tell
   * those apart without reading prose. Pact is the motivating case.
   */
  it('publishes each protocol’s declined KPIs with the reason', () => {
    const body = buildMethodology();
    expect(body.protocols.map((p) => p.id)).toEqual(listConnectors().map((c) => c.capabilities().id));

    const pact = body.protocols.find((p) => p.id === 'pact');
    expect(pact).toBeDefined();
    const declined = pact!.declined.find((d) => d.kpi === 'take_rate');
    expect(declined).toBeDefined();
    expect(declined!.reason.length).toBeGreaterThan(0);
    expect(pact!.kpis).not.toContain('take_rate');
  });

  it('generates its protocol list from the live registry', () => {
    for (const connector of listConnectors()) {
      const caps = connector.capabilities();
      const published = buildMethodology().protocols.find((p) => p.id === caps.id)!;
      expect(published.class).toBe(caps.class);
      expect(published.kpis).toEqual([...caps.kpis]);
      expect(published.sources).toEqual([...caps.sourceHosts]);
    }
  });
});
