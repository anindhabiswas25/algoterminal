import { Hono } from 'hono';

import { buildOpenApiDocument } from '../openapi/document.js';

/**
 * `GET /openapi.json` — API_SPEC.md §4. Free (§1: machine-readable spec).
 *
 * Built per request rather than at module load. The document is a few hundred
 * milliseconds of JSON-schema rendering at most, and it reads from the live
 * connector registry and the validated env — so a document served from a
 * process-lifetime constant would be a snapshot of the configuration at import
 * time, which is exactly the class of staleness this route exists to avoid.
 * If it ever shows up in a profile, memoize on the registry's identity, not on
 * first call.
 */
export const openapi = new Hono();

openapi.get('/openapi.json', (c) => c.json(buildOpenApiDocument()));
