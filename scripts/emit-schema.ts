/**
 * Write `docs/kpi-fact.schema.json` from the zod in `src/standardize/schema.ts`.
 *
 *     npm run schema:emit
 *
 * The checked-in file is the artefact `test/standardize/jsonschema.test.ts`
 * diffs against, so this script is how you accept an intentional envelope
 * change: edit the zod, run this, and the diff in the commit IS the change to
 * the published contract. That is the point — a change to the envelope should
 * be impossible to make without it showing up as a reviewable diff in a file
 * whose whole job is to be the contract, rather than as an invisible shift in
 * a document generated at request time.
 *
 * `SCHEMA_ARTEFACT_BASE_URL` is pinned rather than read from the environment,
 * so the file does not change when a developer's `PUBLIC_BASE_URL` does. The
 * served document at `/schema/kpi-fact.json` always carries the real base URL
 * of the deployment serving it; only this snapshot is fixed.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTEFACT_PATH,
  SCHEMA_ARTEFACT_BASE_URL,
  buildKpiFactJsonSchema,
} from '../src/standardize/jsonschema.js';
import { env } from '../src/config/env.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repoRoot, ARTEFACT_PATH);

const document = buildKpiFactJsonSchema(SCHEMA_ARTEFACT_BASE_URL, env.METHODOLOGY_VERSION);
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

console.log(`wrote ${ARTEFACT_PATH} (methodology ${env.METHODOLOGY_VERSION})`);
