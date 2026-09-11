import { Hono } from 'hono';

import { env } from '../config/env.js';
import {
  KPI_FACT_SCHEMA_PATH,
  buildKpiFactJsonSchema,
} from '../standardize/jsonschema.js';

/**
 * `GET /schema/kpi-fact.json` — the `KpiFact` envelope as JSON Schema. Free.
 *
 * Free for the same reason `/catalog` and `/openapi.json` are (PRD.md §7.5):
 * an agent must be able to evaluate us completely without paying, and the
 * envelope is the thing it most needs to evaluate. Charging for the contract
 * would also be self-defeating — a schema nobody has read is a schema nobody
 * validates against.
 *
 * `Content-Type: application/schema+json` per the JSON Schema media-type
 * registration, with `application/json` acceptable to anything that does not
 * know it. Tooling that content-negotiates gets the specific type; curl and
 * every HTTP client still parse it as JSON.
 *
 * Built per request, like `/openapi.json`, so the document reflects the live
 * `METHODOLOGY_VERSION` rather than the value at import time.
 */
export const schema = new Hono();

schema.get(KPI_FACT_SCHEMA_PATH, (c) => {
  c.header('Content-Type', 'application/schema+json; charset=utf-8');
  c.header('X-AlgoTerminal-Methodology', env.METHODOLOGY_VERSION);
  // A contract artefact a buyer is expected to vendor and cache. It changes
  // only on a methodology bump, and §7's notice period is measured in weeks,
  // so an hour of caching costs a buyer nothing and saves us the request.
  c.header('Cache-Control', 'public, max-age=3600');
  return c.body(JSON.stringify(buildKpiFactJsonSchema(), null, 2));
});
