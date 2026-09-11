import { isApplicable, isKpiId } from '../standardize/kpis.js';
import { PROTOCOL_CLASSES } from '../standardize/types.js';
import { BASES, DEFAULT_BASIS } from '../standardize/types.js';
import { folksConnector } from './folks/index.js';
import { pactConnector } from './pact/index.js';
import { tinymanConnector } from './tinyman/index.js';
import type { Connector, ConnectorCapabilities } from './types.js';

/**
 * ARCHITECTURE.md §4.4 / CONNECTOR_GUIDE.md §Step 7 — the connector registry.
 *
 * `/catalog`, route validation, the refresher's hot set, `/health` and the
 * `/ask` router's capability matrix all read from this one Map. Registering a
 * protocol is one line here; none of those readers need editing.
 */

/** A connector id: lowercase slug. Appears in URLs, cache keys and `/catalog`. */
export const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The live set.
 *
 * Each connector arrives at its own build step, and registering one is a single
 * line here — which is the claim the build order exists to test. Tinyman
 * (step 4) needed exactly this line plus `src/connectors/tinyman/`; `/catalog`,
 * `/health` and route validation picked it up with no further edit.
 */
export const registry = new Map<string, Connector>([
  ['tinyman', tinymanConnector],
  ['pact', pactConnector],
  ['folks', folksConnector],
]);

export function getConnector(id: string): Connector | undefined {
  return registry.get(id);
}

export function hasProtocol(id: string): boolean {
  return registry.has(id);
}

/** Registered ids, sorted, so `/catalog` and error payloads are stable. */
export function listProtocolIds(source: ReadonlyMap<string, Connector> = registry): string[] {
  return [...source.keys()].sort();
}

/** Every registered connector, in `listProtocolIds` order. */
export function listConnectors(source: ReadonlyMap<string, Connector> = registry): Connector[] {
  return listProtocolIds(source).map((id) => source.get(id) as Connector);
}

// ---------------------------------------------------------------------------
// Boot-time coherence validation
// ---------------------------------------------------------------------------

/**
 * Thrown when a registered connector is incoherent. Fail-loud at boot, the same
 * principle as env validation (`src/config/env.ts`): a connector declaring
 * `utilization` on a `dex` is a bug that must never reach `/catalog`, and
 * discovering it at boot costs a restart while discovering it in production
 * costs a 404 on a route we advertised and charged for.
 */
export class ConnectorRegistryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid connector registry — refusing to start.\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
    this.name = 'ConnectorRegistryError';
  }
}

/**
 * Every way a connector's declared capabilities can be incoherent, as data.
 *
 * Returns problems rather than throwing on the first one, so a boot failure
 * names everything wrong at once instead of one thing per restart.
 *
 * `key` is the Map key the connector is registered under; it must equal
 * `capabilities().id`, because every other reader looks connectors up by key
 * while `/catalog` advertises the id — a mismatch advertises a protocol whose
 * `/metric/{protocol}` path 404s.
 */
export function validateCapabilities(key: string, caps: ConnectorCapabilities): string[] {
  const problems: string[] = [];
  const at = (msg: string) => problems.push(`${key}: ${msg}`);

  if (caps.id !== key) {
    at(`registered under "${key}" but capabilities().id is "${caps.id}" — they must match`);
  }
  if (!SLUG_RE.test(caps.id)) {
    at(`id "${caps.id}" is not a lowercase slug (${String(SLUG_RE)})`);
  }
  if (caps.name.trim().length === 0) {
    at('name is empty');
  }
  if (!(PROTOCOL_CLASSES as readonly string[]).includes(caps.class)) {
    at(`class "${caps.class}" is not one of ${PROTOCOL_CLASSES.join(', ')} (DATA_SCHEMA.md §2.2)`);
  }

  if (caps.kpis.length === 0) {
    at('declares no KPIs — a connector that produces nothing should not be registered');
  }
  const seen = new Set<string>();
  for (const kpi of caps.kpis) {
    if (seen.has(kpi)) at(`declares KPI "${kpi}" more than once`);
    seen.add(kpi);

    // Typed `KpiId[]`, so TypeScript already rejects this — the runtime check
    // is for the untyped boundary (a JS connector, a plugin loaded at runtime).
    if (!isKpiId(kpi)) {
      at(`declares KPI "${kpi}", which is not in the DATA_SCHEMA.md §4 registry`);
      continue;
    }
    if (!isApplicable(kpi, caps.class)) {
      at(
        `declares KPI "${kpi}", which is not applicable to class "${caps.class}" (DATA_SCHEMA.md §4) — ` +
          'advertising it would promise a value the API answers with KPI_NOT_APPLICABLE',
      );
    }
  }

  // DATA_SCHEMA.md §4.1: active_users_24h is computed by filtering indexer
  // transactions on the protocol's app ids. A connector that cannot enumerate
  // them declines the KPI; it does not approximate it.
  if (caps.kpis.includes('active_users_24h')) {
    if (caps.appIds === undefined || caps.appIds.length === 0) {
      at(
        'declares active_users_24h but no appIds — §4.1 computes it from indexer transactions ' +
          'filtered by application id, so without them the KPI must be declined, not approximated',
      );
    } else if (!caps.appIds.every((n) => Number.isInteger(n) && n >= 0)) {
      at('appIds must all be non-negative integers');
    }
  }

  // A deliberate decline (§Step 3) must be coherent: a KPI cannot be both
  // published and declined, a reason a buyer reads must not be blank, and
  // declining a KPI that is not applicable to the class at all is noise — the
  // class check already answers that case with a better message.
  for (const [kpi, reason] of Object.entries(caps.declined ?? {})) {
    if (!isKpiId(kpi)) {
      at(`declines KPI "${kpi}", which is not in the DATA_SCHEMA.md §4 registry`);
      continue;
    }
    if (caps.kpis.includes(kpi)) {
      at(`declares KPI "${kpi}" and also declines it — it must be one or the other`);
    }
    if (!isApplicable(kpi, caps.class)) {
      at(
        `declines KPI "${kpi}", which is not applicable to class "${caps.class}" anyway — ` +
          'the class check already explains that case; an explicit decline here only obscures it',
      );
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      at(`declines KPI "${kpi}" with an empty reason — the reason is what makes it a loud decline (§1.5)`);
    }
  }

  if (caps.sourceHosts.length === 0) {
    at('declares no sourceHosts — every number must be reproducible (DATA_SCHEMA.md §1.4)');
  }

  if (caps.supportsBasis.length === 0) {
    at('declares no supportsBasis');
  }
  for (const basis of caps.supportsBasis) {
    if (!(BASES as readonly string[]).includes(basis)) {
      at(`declares unknown basis "${basis}" (DATA_SCHEMA.md §3.6)`);
    }
  }
  if (caps.supportsBasis.length > 0 && !caps.supportsBasis.includes(DEFAULT_BASIS)) {
    at(
      `does not support the default basis "${DEFAULT_BASIS}" — a request that omits ?basis= ` +
        'would have no valid handler',
    );
  }

  return problems;
}

/** Coherence problems across a whole registry, empty when it is sound. */
export function validateRegistry(
  source: ReadonlyMap<string, Connector> = registry,
): string[] {
  const problems: string[] = [];
  for (const [key, connector] of source) {
    problems.push(...validateCapabilities(key, connector.capabilities()));
  }
  return problems;
}

/** Throws {@link ConnectorRegistryError} if anything is incoherent. */
export function assertRegistryValid(source: ReadonlyMap<string, Connector> = registry): void {
  const problems = validateRegistry(source);
  if (problems.length > 0) throw new ConnectorRegistryError(problems);
}

/**
 * Boot gate. Mirrors `loadOrExit` in `src/config/env.ts`: refuse to start
 * rather than serve a `/catalog` we cannot honour.
 */
export function validateRegistryOrExit(source: ReadonlyMap<string, Connector> = registry): void {
  try {
    assertRegistryValid(source);
  } catch (err) {
    if (!(err instanceof ConnectorRegistryError)) throw err;
    process.stderr.write(
      `${err.message}\nSee docs/CONNECTOR_GUIDE.md §Step 3 and §Step 7.\n`,
    );
    process.exit(1);
  }
}
