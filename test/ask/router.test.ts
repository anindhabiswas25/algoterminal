import { describe, it, expect } from 'vitest';

import {
  DECLINE_TOOL,
  PLAN_TOOL,
  routeQuestion,
  routerSystemPrompt,
  routerTools,
} from '../../src/ask/router.js';
import { capabilityMatrix, coverageSummary, validatePlan } from '../../src/ask/capabilities.js';
import { callCostUsd, MODEL_PRICING, ROUTER_MODEL, SYNTHESIZER_MODEL, totalCostUsd } from '../../src/ask/client.js';
import { listProtocolIds } from '../../src/connectors/registry.js';
import { KPI_IDS } from '../../src/standardize/kpis.js';
import { fakeAnthropic } from './helpers.js';

/**
 * The router (ARCHITECTURE.md §4.7 step 1).
 *
 * The claim under test is the strong one: it *cannot* name a protocol or KPI
 * we do not cover. That is enforced twice — by the tool schema's enums with
 * `strict: true`, and by re-validating on the way back — and both are checked
 * here, because the first happens in a service we do not control.
 */

const matrix = capabilityMatrix();

describe('the tool schema is built from the live registries', () => {
  it('enumerates exactly the registered protocols and the §4 KPIs', () => {
    const tools = routerTools(matrix);
    const plan = tools.find((t) => t.name === PLAN_TOOL)!;
    const props = plan.input_schema.properties as Record<string, any>;

    expect(props.protocols.items.enum).toEqual(listProtocolIds());
    expect(props.kpis.items.enum).toEqual([...KPI_IDS]);
  });

  it('sets strict:true with a closed object, which is what makes the enum binding', () => {
    for (const tool of routerTools(matrix)) {
      expect(tool.strict, tool.name).toBe(true);
      expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
      expect(tool.input_schema.required, tool.name).toEqual(
        Object.keys(tool.input_schema.properties as object),
      );
    }
  });

  it('offers a decline tool, so a refusal is structured rather than prose', () => {
    expect(routerTools(matrix).map((t) => t.name)).toEqual([PLAN_TOOL, DECLINE_TOOL]);
  });

  it('puts the whole matrix in the system prompt, including declines', () => {
    const prompt = routerSystemPrompt(matrix);
    for (const id of listProtocolIds()) expect(prompt).toContain(`"${id}"`);
    // Pact's declined take_rate has to reach the router, or it would drop Pact
    // from a take-rate question instead of planning it and saying so.
    expect(prompt).toContain('take_rate');
    expect(prompt).toContain('pact_fee_bps');
  });

  it('names every refusal trigger §3.3 lists', () => {
    const prompt = routerSystemPrompt(matrix).toLowerCase();
    for (const trigger of ['forecast', 'price target', 'advice', 'predict']) {
      expect(prompt, trigger).toContain(trigger);
    }
  });
});

describe('routeQuestion', () => {
  it('normalizes the plan into registry order, so one question is one cache key', async () => {
    const claude = fakeAnthropic();
    claude.plan({
      protocols: ['tinyman', 'folks'],
      kpis: ['tvl', 'capital_efficiency'],
      comparison_type: 'cross_class_comparison',
    });
    const result = await routeQuestion('q', { client: claude, matrix });

    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    // Sorted by the registries, not by the order the model emitted.
    expect(result.plan.protocols).toEqual(['folks', 'tinyman']);
    expect(result.plan.kpis).toEqual(KPI_IDS.filter((k) => k === 'tvl' || k === 'capital_efficiency'));
  });

  it('turns a decline into a typed refusal, not an exception', async () => {
    const claude = fakeAnthropic();
    claude.decline('out_of_scope', 'no forecasts');
    const result = await routeQuestion('Will ALGO go up?', { client: claude, matrix });

    expect(result.kind).toBe('decline');
    if (result.kind !== 'decline') return;
    expect(result.reason).toBe('out_of_scope');
    expect(result.explanation).toBe('no forecasts');
  });

  /**
   * The belt to the tool schema's braces. `strict: true` should make this
   * unreachable, but the enforcement lives in another company's service, and
   * "should be unreachable" is not a guarantee.
   */
  it('rejects a plan naming a protocol outside the matrix, rather than passing it through', async () => {
    const claude = fakeAnthropic();
    claude.plan({
      protocols: ['uniswap', 'tinyman'],
      kpis: ['tvl'],
      comparison_type: 'cross_protocol_ranking',
    } as never);
    const result = await routeQuestion('q', { client: claude, matrix });

    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') return;
    // The unknown id is filtered by the registry intersection; the real
    // protocol survives.
    expect(result.plan.protocols).toEqual(['tinyman']);
  });

  it('declines when a plan survives validation with nothing in it', async () => {
    const claude = fakeAnthropic();
    claude.plan({ protocols: ['uniswap'], kpis: ['tvl'], comparison_type: 'single_metric_lookup' } as never);
    const result = await routeQuestion('q', { client: claude, matrix });
    expect(result.kind).toBe('decline');
  });
});

describe('validatePlan against the capability matrix', () => {
  it('drops a KPI that is not defined for the protocol class, with a reason', () => {
    const validated = validatePlan({
      protocols: ['tinyman'],
      kpis: ['utilization'],
      comparison_type: 'single_metric_lookup',
    });
    expect(validated.fetch).toEqual([]);
    expect(validated.unavailable[0]?.declined).toBe(false);
    expect(validated.unavailable[0]?.reason).toContain('not defined for a dex');
  });

  /**
   * The distinction the whole `unavailable` shape exists for: a *declined* KPI
   * is a finding about the source, and the answer must say so. An inapplicable
   * one is a category error.
   */
  it('marks a deliberately declined KPI as declined, with the source’s reason', () => {
    const validated = validatePlan({
      protocols: ['pact'],
      kpis: ['take_rate'],
      comparison_type: 'single_metric_lookup',
    });
    expect(validated.fetch).toEqual([]);
    expect(validated.unavailable[0]?.declined).toBe(true);
    expect(validated.unavailable[0]?.reason).toContain('take_rate');
  });

  it('expands the cross product in plan order', () => {
    const validated = validatePlan({
      protocols: ['tinyman', 'folks'],
      kpis: ['tvl', 'gross_fees_24h'],
      comparison_type: 'cross_class_comparison',
    });
    expect(validated.fetch).toEqual([
      { protocol: 'tinyman', kpi: 'tvl' },
      { protocol: 'tinyman', kpi: 'gross_fees_24h' },
      { protocol: 'folks', kpi: 'tvl' },
      { protocol: 'folks', kpi: 'gross_fees_24h' },
    ]);
  });

  it('reports an unknown protocol separately from an inapplicable pair', () => {
    const validated = validatePlan({
      protocols: ['uniswap'],
      kpis: ['tvl'],
      comparison_type: 'single_metric_lookup',
    });
    expect(validated.unknownProtocols).toEqual(['uniswap']);
    expect(validated.unavailable).toEqual([]);
  });

  it('coverageSummary tells a 422 caller exactly what we do cover', () => {
    const summary = coverageSummary();
    expect(summary.protocols).toEqual(listProtocolIds());
    expect(summary.kpis).toEqual([...KPI_IDS]);
  });
});

/**
 * Cost accounting. `PRD.md` §5.3 assumes ~80% gross margin on `/ask`; this is
 * the arithmetic that turns that from an assumption into something the logs
 * report on every call.
 */
describe('cost accounting', () => {
  it('prices each model from its published per-MTok rate', () => {
    expect(MODEL_PRICING[ROUTER_MODEL]).toEqual({ inputPerMTok: 1.0, outputPerMTok: 5.0 });
    expect(MODEL_PRICING[SYNTHESIZER_MODEL]).toEqual({ inputPerMTok: 2.0, outputPerMTok: 10.0 });
  });

  it('computes a call cost from input, output and cached tokens', () => {
    // 1M input at $2 + 1M output at $10 = $12.
    expect(
      callCostUsd({
        model: SYNTHESIZER_MODEL,
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
      }),
    ).toBeCloseTo(12, 6);

    // Cache reads bill at a tenth of the input rate.
    expect(
      callCostUsd({
        model: SYNTHESIZER_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.2, 6);
  });

  it('costs an unknown model at zero rather than throwing', () => {
    // Telemetry must never be able to fail a request that was already answered.
    expect(
      callCostUsd({ model: 'claude-not-a-model', inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 }),
    ).toBe(0);
  });

  it('sums the calls one answer made', () => {
    expect(
      totalCostUsd([
        { model: ROUTER_MODEL, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
        { model: SYNTHESIZER_MODEL, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      ]),
    ).toBeCloseTo(3, 6);
  });
});
