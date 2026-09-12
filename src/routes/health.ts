import { Hono } from 'hono';
import { askConfigured, ROUTER_MODEL, SYNTHESIZER_MODEL } from '../ask/client.js';
import { cacheHealth } from '../cache/index.js';
import type { CycleStats } from '../cache/metrics.js';
import { env } from '../config/env.js';
import { connectorContext, httpCounters } from '../connectors/context.js';
import type { HostCounters } from '../connectors/http.js';
import { methodologyMarkdown } from './methodology.js';
import { listProtocolIds, registry } from '../connectors/registry.js';
import type { Connector, ConnectorContext } from '../connectors/types.js';
import { settleStats } from '../gate/ledger.js';
import { concentrationMonitor, type ConcentrationReport } from '../jobs/concentration.js';
import { refresher } from '../jobs/refresher.js';
import { snapshotter } from '../jobs/snapshotter.js';

/**
 * GET /health — API_SPEC.md §3.5.
 *
 * The `connectors` object is generated from the connector registry, one entry
 * per registered connector via its `healthCheck()`. There is no list of
 * protocol names in this file, so a new connector appears here the moment it is
 * registered (CONNECTOR_GUIDE.md §Step 7).
 *
 * The cache block is real as of step 5 and the facilitator block as of step 6.
 * Nothing here is faked: a health endpoint that reports invented uptime is
 * worse than none, so a signal we do not measure is `null`, and `computeStatus`
 * treats null as non-degrading rather than as healthy.
 */

export type ComponentStatus = 'ok' | 'degraded' | 'down';
export type OverallStatus = 'ok' | 'degraded' | 'down';

export interface ConnectorHealth {
  status: ComponentStatus;
  last_success: string | null;
  success_rate_24h: number | null;
}

export interface CacheHealth {
  /** Trailing-hour fresh-hit rate. Null before the first lookup, never faked. */
  hit_rate_1h: number | null;
  redis: ComponentStatus | null;
  /** Lookups the hit rate is computed over — a rate over 3 calls is not a rate. */
  lookups_1h?: number;
  /** L0 occupancy, out of the ~2k ceiling (ARCHITECTURE.md §4.5). */
  l0_entries?: number;
  /**
   * Per-cycle refresher timings (§4.6).
   *
   * `last_duration_ms` sits next to `interval_s` so a cycle drifting past its
   * period is a number an operator can read rather than something inferred
   * from log timestamps — the failure a single 60s cycle would have had, given
   * a full refresh floors at ~65s.
   */
  refresher?: Record<string, CycleStats>;
  snapshotter?: { interval_s: number; last_run_at: string | null; last_written: number };
}

export interface FacilitatorHealth {
  status: ComponentStatus | null;
  settle_failures_1h: number | null;
  /** Share of settle attempts that failed over the last 5 minutes, 0..1. */
  settle_failure_rate_5m?: number | null;
}

/**
 * Whether the two things `/ask` and `/methodology` need at RUNTIME are present.
 *
 * Both are deployment-time facts that no other check would catch: a missing
 * `ANTHROPIC_API_KEY` leaves `/ask` ungated and unadvertised (which is correct,
 * and silent), and a build that did not ship `public/methodology.md` serves the
 * structured methodology perfectly and the document itself as a 503. Neither
 * shows up in a connector probe or a cache stat, and both are exactly the kind
 * of thing that is discovered by a buyer rather than by us.
 */
export interface AskHealth {
  /** False when this deployment does not offer POST /ask at all. */
  configured: boolean;
  router_model: string;
  synthesizer_model: string;
  /** False when ?format=markdown would 503 on this build. */
  methodology_document: boolean;
}

/**
 * Per-host upstream counters, straight off the shared HTTP client (§4.1).
 *
 * Published because §4g item 2 required the throttle rate to be *measured*
 * before and after lowering Tinyman's concurrency, and a number that can only
 * be obtained by reading logs is a number nobody compares. `throttled` is the
 * 429 count; `throttle_rate` is it over `requests`, which is the figure that
 * means something — twelve 429s out of twelve requests and twelve out of twelve
 * thousand are different services.
 */
export interface UpstreamHealth {
  requests: number;
  failures: number;
  retries: number;
  throttled: number;
  /** `throttled / requests`, or null before the first request to this host. */
  throttle_rate: number | null;
}

export interface HealthBody {
  status: OverallStatus;
  uptime_s: number;
  methodology_version: string;
  connectors: Record<string, ConnectorHealth>;
  cache: CacheHealth;
  facilitator: FacilitatorHealth;
  /** Per-upstream-host request counters (§4.1), keyed by host. */
  upstream: Record<string, UpstreamHealth>;
  /**
   * DEPLOYMENT.md §7.2's weekly volume-integrity review, so payer
   * concentration is visible without a database session (§4g item 5). Null
   * before the monitor's first run.
   */
  concentration: ConcentrationReport | null;
  ask: AskHealth;
  last_block_seen: number | null;
}

/** API_SPEC.md §3.5 degradation thresholds. */
export const CONNECTOR_SUCCESS_RATE_MIN = 0.95;
export const CACHE_HIT_RATE_MIN = 0.5;
export const SETTLE_FAILURE_RATE_5M_MAX = 0.05;

export interface HealthSignals {
  connectors: Record<string, ConnectorHealth>;
  cache: CacheHealth;
  facilitator: FacilitatorHealth;
}

/**
 * `status` is `degraded` if any connector's 24h success rate < 0.95, if the
 * cache hit rate falls below 0.5, or if settle failures exceed 5% over 5
 * minutes (API_SPEC.md §3.5). It is `down` only when every known connector is
 * down — with no data source left, nothing paid can be served.
 *
 * Thresholds are inclusive bounds: a value exactly at 0.95 or 0.5 is healthy,
 * a settle failure rate of exactly 0.05 does not "exceed" 5%.
 *
 * A null signal means "not measured yet" and never degrades the service.
 */
export function computeStatus(signals: HealthSignals): OverallStatus {
  const connectors = Object.values(signals.connectors);

  if (connectors.length > 0 && connectors.every((c) => c.status === 'down')) {
    return 'down';
  }

  const connectorDegraded = connectors.some(
    (c) =>
      c.status !== 'ok' ||
      (c.success_rate_24h !== null && c.success_rate_24h < CONNECTOR_SUCCESS_RATE_MIN),
  );

  const cacheDegraded =
    signals.cache.redis === 'down' ||
    signals.cache.redis === 'degraded' ||
    (signals.cache.hit_rate_1h !== null && signals.cache.hit_rate_1h < CACHE_HIT_RATE_MIN);

  const rate = signals.facilitator.settle_failure_rate_5m;
  const facilitatorDegraded =
    signals.facilitator.status === 'down' ||
    signals.facilitator.status === 'degraded' ||
    (rate !== null && rate !== undefined && rate > SETTLE_FAILURE_RATE_5M_MAX);

  return connectorDegraded || cacheDegraded || facilitatorDegraded ? 'degraded' : 'ok';
}

/**
 * Probe every registered connector, in parallel.
 *
 * `last_success` and `success_rate_24h` stay null until the ledger lands at
 * step 11 — a rate we do not measure must not be reported as 1.0, and
 * `computeStatus` already treats a null signal as non-degrading rather than as
 * healthy.
 *
 * A probe that throws or hangs is `down`; each is bounded by
 * {@link HEALTH_PROBE_TIMEOUT_MS}, since `/health` must answer even when an
 * upstream does not.
 *
 * The context is passed as a factory, not a value, and is built at most once —
 * only if there is a connector to probe with it. That is what lets `/health`
 * serve an empty registry before the step-4 I/O clients exist, without this
 * route knowing anything about which build step we are on.
 */
export async function probeConnectors(
  getContext: () => ConnectorContext,
  source: ReadonlyMap<string, Connector> = registry,
): Promise<Record<string, ConnectorHealth>> {
  const ids = listProtocolIds(source);
  if (ids.length === 0) return {};

  const ctx = getContext();
  const probes = await Promise.all(
    ids.map(async (id): Promise<ConnectorHealth> => {
      const connector = source.get(id) as Connector;
      try {
        const probe = await withTimeout(connector.healthCheck(ctx), HEALTH_PROBE_TIMEOUT_MS);
        return { status: probe.ok ? 'ok' : 'down', last_success: null, success_rate_24h: null };
      } catch {
        return { status: 'down', last_success: null, success_rate_24h: null };
      }
    }),
  );
  return Object.fromEntries(ids.map((id, i) => [id, probes[i] as ConnectorHealth]));
}

/** A connector probe is "cheap" (§1); anything slower than this counts as down. */
export const HEALTH_PROBE_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`health probe timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Signals as of now. Connector entries are generated from the registry; the
 * cache and facilitator readings arrive at steps 5 and 6.
 */
export async function currentSignals(
  getContext: () => ConnectorContext = connectorContext,
  source: ReadonlyMap<string, Connector> = registry,
): Promise<HealthSignals> {
  const [connectors, facilitator] = await Promise.all([
    probeConnectors(getContext, source),
    currentFacilitatorHealth(),
  ]);
  return { connectors, cache: currentCacheHealth(), facilitator };
}

/** §3.5's degradation window for settle failures. */
export const SETTLE_FAILURE_WINDOW_S = 300;
/** §3.5's reported window: `settle_failures_1h`. */
export const SETTLE_FAILURE_REPORT_S = 3_600;

/**
 * The §3.5 `facilitator` block, read from the payment ledger.
 *
 * This is ARCHITECTURE.md §5.2's requirement made visible: a settle that failed
 * after a successful handler cost us money we will not get back, and the whole
 * point of writing the row was that the rate be *knowable*. A count with no
 * denominator cannot express the §3.5 rule ("settle failures exceed 5% over 5
 * minutes"), so the rate is computed over attempts in the same window and the
 * hour-long count is reported beside it.
 *
 * `status` is derived rather than probed: we do not call the facilitator from
 * `/health`, because a liveness endpoint that depends on a third party reports
 * that party's health instead of ours — and because `/health` is free, which
 * would make it a free way to poll someone else's service.
 */
export async function currentFacilitatorHealth(): Promise<FacilitatorHealth> {
  const [recent, hour] = await Promise.all([
    settleStats(SETTLE_FAILURE_WINDOW_S),
    settleStats(SETTLE_FAILURE_REPORT_S),
  ]);

  if (recent === null || hour === null) {
    return { status: null, settle_failures_1h: null, settle_failure_rate_5m: null };
  }

  // No attempts is not a 0% failure rate, it is no measurement — reporting 0
  // would let a facilitator outage look healthy for as long as it stops anyone
  // from paying at all.
  const rate = recent.attempts === 0 ? null : recent.failed / recent.attempts;

  return {
    status: rate !== null && rate > SETTLE_FAILURE_RATE_5M_MAX ? 'degraded' : 'ok',
    settle_failures_1h: hour.failed,
    settle_failure_rate_5m: rate,
  };
}

/**
 * The §3.5 `cache` block, read from the live cache and jobs.
 *
 * Wrapped in a try/catch because `/health` must answer even when the thing it
 * is reporting on is broken: `cacheDeps()` constructs the Redis client on
 * first use, and a health endpoint that 500s because Redis is down tells an
 * operator nothing at the moment they most need it. A failure here reports
 * `redis: 'down'`, which is the fact being asked about.
 */
export function currentCacheHealth(): CacheHealth {
  try {
    const cache = cacheHealth();
    return {
      hit_rate_1h: cache.hit_rate_1h,
      redis: cache.redis,
      lookups_1h: cache.lookups_1h,
      l0_entries: cache.l0_entries,
      refresher: refresher.stats(),
      snapshotter: snapshotter.stats(),
    };
  } catch {
    return { hit_rate_1h: null, redis: 'down' };
  }
}

/** Signals with no connectors probed. Used where an await is not available. */
export function emptySignals(): HealthSignals {
  return {
    connectors: {},
    cache: { hit_rate_1h: null, redis: null },
    facilitator: { status: null, settle_failures_1h: null, settle_failure_rate_5m: null },
  };
}

/** Per-host counters with the derived rate §4g item 2 asked to be able to read. */
export function upstreamHealth(
  counters: Record<string, HostCounters> = httpCounters(),
): Record<string, UpstreamHealth> {
  return Object.fromEntries(
    Object.entries(counters).map(([host, c]) => [
      host,
      {
        requests: c.requests,
        failures: c.failures,
        retries: c.retries,
        throttled: c.throttled,
        // No requests is not a 0% throttle rate, it is no measurement — the
        // same rule `settle_failure_rate_5m` follows one block up.
        throttle_rate: c.requests === 0 ? null : Number((c.throttled / c.requests).toFixed(4)),
      },
    ]),
  );
}

export function buildHealth(uptimeSeconds: number, signals: HealthSignals): HealthBody {
  return {
    status: computeStatus(signals),
    uptime_s: Math.floor(uptimeSeconds),
    methodology_version: env.METHODOLOGY_VERSION,
    connectors: signals.connectors,
    cache: signals.cache,
    facilitator: signals.facilitator,
    upstream: upstreamHealth(),
    // Reported, not scored, and for a different reason from `ask` below: a
    // payer over the threshold is something to explain, not evidence that the
    // service is unhealthy, and §7.2's alarm needs a human to act on it rather
    // than a load balancer to route around it. `computeStatus` is therefore
    // not given this signal — but the ERROR log is not optional, and it fires
    // in `runConcentrationCheck` whether or not anyone reads /health.
    concentration: concentrationMonitor.stats(),
    // Reported, not scored: a deployment that deliberately does not offer
    // /ask is correctly configured, not degraded, and `computeStatus` is
    // therefore not given this signal.
    ask: {
      configured: askConfigured(),
      router_model: ROUTER_MODEL,
      synthesizer_model: SYNTHESIZER_MODEL,
      methodology_document: methodologyMarkdown() !== null,
    },
    last_block_seen: null,
  };
}

export const health = new Hono();

health.get('/health', async (c) => c.json(buildHealth(process.uptime(), await currentSignals())));
