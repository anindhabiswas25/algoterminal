import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  computeStatus,
  currentSignals,
  emptySignals,
  probeConnectors,
  buildHealth,
  upstreamHealth,
  type HealthSignals,
  type ConnectorHealth,
} from '../src/routes/health.js';
import { createApp } from '../src/app.js';
import { makeContext, makeFakeConnector, makeRegistry } from '../src/connectors/testing.js';
import { listProtocolIds, registry } from '../src/connectors/registry.js';

function connector(overrides: Partial<ConnectorHealth> = {}): ConnectorHealth {
  return { status: 'ok', last_success: '2026-09-08T12:00:00Z', success_rate_24h: 1.0, ...overrides };
}

function signals(overrides: Partial<HealthSignals> = {}): HealthSignals {
  return {
    connectors: { alpha: connector(), beta: connector(), gamma: connector() },
    cache: { hit_rate_1h: 0.83, redis: 'ok' },
    facilitator: { status: 'ok', settle_failures_1h: 0, settle_failure_rate_5m: 0 },
    ...overrides,
  };
}

describe('computeStatus — API_SPEC.md §3.5 thresholds', () => {
  it('is ok when every signal is healthy', () => {
    expect(computeStatus(signals())).toBe('ok');
  });

  it('is degraded when any connector 24h success rate is below 0.95', () => {
    const s = signals();
    s.connectors.beta = connector({ success_rate_24h: 0.9499 });
    expect(computeStatus(s)).toBe('degraded');
  });

  it('holds ok exactly at the 0.95 connector boundary', () => {
    const s = signals();
    s.connectors.beta = connector({ success_rate_24h: 0.95 });
    expect(computeStatus(s)).toBe('ok');
  });

  it('is degraded when the cache hit rate falls below 0.5', () => {
    expect(computeStatus(signals({ cache: { hit_rate_1h: 0.4999, redis: 'ok' } }))).toBe(
      'degraded',
    );
  });

  it('holds ok exactly at the 0.5 cache boundary', () => {
    expect(computeStatus(signals({ cache: { hit_rate_1h: 0.5, redis: 'ok' } }))).toBe('ok');
  });

  it('is degraded when redis is down', () => {
    expect(computeStatus(signals({ cache: { hit_rate_1h: 0.99, redis: 'down' } }))).toBe(
      'degraded',
    );
  });

  it('is degraded when settle failures exceed 5% over 5 minutes', () => {
    const s = signals({
      facilitator: { status: 'ok', settle_failures_1h: 3, settle_failure_rate_5m: 0.0501 },
    });
    expect(computeStatus(s)).toBe('degraded');
  });

  it('holds ok exactly at the 5% settle-failure boundary (must exceed, not equal)', () => {
    const s = signals({
      facilitator: { status: 'ok', settle_failures_1h: 1, settle_failure_rate_5m: 0.05 },
    });
    expect(computeStatus(s)).toBe('ok');
  });

  it('is down when every connector is down', () => {
    const s = signals({
      connectors: {
        alpha: connector({ status: 'down', success_rate_24h: 0 }),
        beta: connector({ status: 'down', success_rate_24h: 0 }),
        gamma: connector({ status: 'down', success_rate_24h: 0 }),
      },
    });
    expect(computeStatus(s)).toBe('down');
  });

  it('treats unmeasured (null) signals as non-degrading', () => {
    expect(computeStatus(emptySignals())).toBe('ok');
  });
});

// API_SPEC.md §3.5 response shape. Placeholders are nullable at this build
// step but the keys must already be present and correctly typed.
const ComponentStatus = z.enum(['ok', 'degraded', 'down']);
const HealthSchema = z.object({
  status: ComponentStatus,
  uptime_s: z.number().int().nonnegative(),
  methodology_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  connectors: z.record(
    z.string(),
    z.object({
      status: ComponentStatus,
      last_success: z.string().nullable(),
      success_rate_24h: z.number().min(0).max(1).nullable(),
    }),
  ),
  cache: z.object({
    hit_rate_1h: z.number().min(0).max(1).nullable(),
    redis: ComponentStatus.nullable(),
  }),
  facilitator: z.object({
    status: ComponentStatus.nullable(),
    settle_failures_1h: z.number().int().nonnegative().nullable(),
    settle_failure_rate_5m: z.number().min(0).max(1).nullable().optional(),
  }),
  last_block_seen: z.number().int().nullable(),
});

describe('buildHealth', () => {
  it('produces a schema-valid body', () => {
    expect(() => HealthSchema.parse(buildHealth(42.7, emptySignals()))).not.toThrow();
  });

  it('floors uptime to whole seconds', () => {
    expect(buildHealth(42.7, emptySignals()).uptime_s).toBe(42);
  });

  it('reports methodology_version from env, not a literal', () => {
    expect(buildHealth(0, emptySignals()).methodology_version).toBe(
      process.env.METHODOLOGY_VERSION,
    );
  });

  it('does not fake values that later build steps populate', () => {
    const body = buildHealth(0, emptySignals());
    expect(body.connectors).toEqual({});
    expect(body.cache).toEqual({ hit_rate_1h: null, redis: null });
    expect(body.last_block_seen).toBeNull();
  });

  it('reports the concentration review as null until it has run (§4g item 5)', () => {
    // Same rule as everything else here: a compliance control that has not run
    // reports that it has not run. A green `ok` from a monitor whose first
    // weekly pass is still pending is precisely the false comfort §7.2's
    // control exists to remove.
    expect(buildHealth(0, emptySignals()).concentration).toBeNull();
  });
});

describe('upstreamHealth — the §4g item 2 throttle measurement', () => {
  it('reports the throttle rate, not just the count', () => {
    // §4g item 2 asked for the throttle rate "before and after". A count is not
    // a rate: 12 throttles out of 12 requests and 12 out of 12,000 are
    // different services, and only the second number says which one we are.
    const health = upstreamHealth({
      'mainnet.analytics.tinyman.org': { requests: 400, failures: 2, retries: 30, throttled: 20 },
    });

    expect(health['mainnet.analytics.tinyman.org']?.throttle_rate).toBe(0.05);
    expect(health['mainnet.analytics.tinyman.org']?.throttled).toBe(20);
  });

  it('reports null rather than zero for a host it has never called', () => {
    // No requests is not a 0% throttle rate, it is no measurement — the same
    // rule `settle_failure_rate_5m` follows one block up in the same file.
    const health = upstreamHealth({ 'quiet.example': { requests: 0, failures: 0, retries: 0, throttled: 0 } });
    expect(health['quiet.example']?.throttle_rate).toBeNull();
  });

  it('is empty before the first upstream request rather than absent', () => {
    expect(upstreamHealth({})).toEqual({});
  });
});

describe('GET /health', () => {
  it('returns 200 with a schema-valid body', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(() => HealthSchema.parse(body)).not.toThrow();
  });

  it('sends permissive CORS, since /health is a free route', async () => {
    const res = await createApp().request('/health', { headers: { Origin: 'https://example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});


describe('the connectors object is generated from the registry (§3.5)', () => {
  // There is no list of protocol names in src/routes/health.ts. A connector
  // appears here the moment it is registered and disappears the moment it is
  // not, which is the property that makes protocol #4 one line in registry.ts.
  it('is empty for an empty registry, and builds no context to discover that', async () => {
    // `connectorContext()` throws until step 4; reaching it would fail here.
    expect(await probeConnectors(() => { throw new Error('must not build a context'); }, new Map()))
      .toEqual({});
  });

  it('reports every connector in the live registry, with no edit to this route', async () => {
    // The step-4 claim, tested: registering Tinyman was one line in
    // registry.ts and /health picked it up. The probe is stubbed, because a
    // unit test must not depend on Tinyman being up.
    expect(listProtocolIds()).toContain('tinyman');
    const connectors = await probeConnectors(() => makeContext({ httpResponses: {} }), registry);
    expect(Object.keys(connectors)).toEqual(listProtocolIds());
    // The stub http throws on the unregistered probe URL, so 'down' here is
    // the honest answer for an unreachable upstream.
    expect(connectors.tinyman?.status).toBe('down');
  });

  it('has one entry per registered connector, keyed by its id', async () => {
    const source = makeRegistry(
      makeFakeConnector({ capabilities: { id: 'alpha' } }),
      makeFakeConnector({ capabilities: { id: 'beta' } }),
    );
    const connectors = await probeConnectors(makeContext, source);
    expect(Object.keys(connectors).sort()).toEqual(['alpha', 'beta']);
    expect(connectors.alpha).toEqual({ status: 'ok', last_success: null, success_rate_24h: null });
  });

  it("marks a connector whose probe reports not-ok as down", async () => {
    const source = makeRegistry(makeFakeConnector({ health: { ok: false, detail: 'unreachable' } }));
    expect((await probeConnectors(makeContext, source)).fake?.status).toBe('down');
  });

  it('marks a connector whose probe throws as down, rather than failing /health', async () => {
    const source = makeRegistry(
      makeFakeConnector({ health: () => Promise.reject(new Error('boom')) }),
    );
    expect((await probeConnectors(makeContext, source)).fake?.status).toBe('down');
  });

  it('does not invent a success rate it has not measured (§3.5, ledger lands at step 11)', async () => {
    const source = makeRegistry(makeFakeConnector());
    const health = (await probeConnectors(makeContext, source)).fake;
    expect(health?.success_rate_24h).toBeNull();
    expect(health?.last_success).toBeNull();
    // ...and an unmeasured rate must not degrade the service.
    expect(computeStatus({ ...emptySignals(), connectors: { fake: health as ConnectorHealth } })).toBe('ok');
  });

  it('still applies the §3.5 degraded thresholds over generated entries', async () => {
    const source = makeRegistry(
      makeFakeConnector({ capabilities: { id: 'alpha' } }),
      makeFakeConnector({ capabilities: { id: 'beta' }, health: { ok: false } }),
    );
    const signals = await currentSignals(makeContext, source);
    expect(computeStatus(signals)).toBe('degraded');
  });

  it('is down when every generated connector is down', async () => {
    const source = makeRegistry(
      makeFakeConnector({ capabilities: { id: 'alpha' }, health: { ok: false } }),
      makeFakeConnector({ capabilities: { id: 'beta' }, health: { ok: false } }),
    );
    expect(computeStatus(await currentSignals(makeContext, source))).toBe('down');
  });
});
