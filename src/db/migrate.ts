import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../logger.js';
import { withClient } from './pool.js';

/**
 * A deliberately small forward-only migrator.
 *
 * The requirement (ARCHITECTURE.md §9 step 5) is a migration *file*, not an
 * ad-hoc `CREATE TABLE ... IF NOT EXISTS` at boot. What that buys is a schema
 * that exists as a reviewable artefact rather than as a side effect of a
 * successful deploy, and one that two instances booting at once cannot race on.
 *
 * No down-migrations: rolling a schema backwards on a live database is a
 * decision to make by hand with the data in front of you, and a `down.sql`
 * written months earlier is a rehearsed way to get it wrong.
 */

/** `migrations/` at the repo root — resolved from this file, not from cwd. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

const log = logger.child({ component: 'migrate' });

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/** Every `NNN_*.sql` in `migrations/`, in filename order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * Apply every migration not yet recorded, each in its own transaction.
 *
 * `pg_advisory_lock` around the whole run is what makes this safe to call from
 * more than one place at once (a deploy hook and a developer's terminal): the
 * second caller blocks until the first finishes and then finds nothing to do,
 * rather than both applying `001` and one of them failing on a duplicate table.
 */
export async function migrate(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const migrations = loadMigrations(dir);

  return withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // An arbitrary but fixed key: any two processes migrating this database
    // must pick the same one, and it must not collide with another product's.
    await client.query('SELECT pg_advisory_lock($1)', [4_021_985_001]);

    try {
      const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.name));
      const ran: string[] = [];

      for (const migration of migrations) {
        if (applied.has(migration.name)) continue;
        log.info({ migration: migration.name }, 'applying migration');
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        ran.push(migration.name);
      }

      return ran;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [4_021_985_001]);
    }
  });
}
