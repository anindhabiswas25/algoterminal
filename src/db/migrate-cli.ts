/**
 * `npm run migrate` — apply pending migrations, then exit.
 *
 * In `src/` rather than `scripts/` so that `npm run build` emits it into
 * `dist/`. Railway runs this as its pre-deploy command, in an image whose dev
 * dependencies have been pruned — `tsx` is not there, so a `scripts/*.ts`
 * entrypoint would fail the deploy at exactly the step that is supposed to make
 * schema changes safe. `migrations/` resolves relative to this module either
 * way, so `dist/db/` and `src/db/` find the same files.
 *
 * Kept out of the server's boot path on purpose (ARCHITECTURE.md §9 step 5):
 * a migration is a deploy step with its own success and its own rollback, and
 * folding it into `start` means a schema change and a code change succeed or
 * fail as one unreviewable unit. Railway runs it as a pre-deploy command.
 */
import { migrate } from './migrate.js';
import { closeDb } from './pool.js';

try {
  const ran = await migrate();
  process.stdout.write(
    ran.length === 0 ? 'No pending migrations.\n' : `Applied: ${ran.join(', ')}\n`,
  );
} catch (err) {
  process.stderr.write(`Migration failed: ${String(err)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
