import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { logger } from '../logger.js';
import { isSuccessFact, safeParseKpiFact, type KpiFact } from '../standardize/schema.js';
import { paramsHash, type FactKey } from './keys.js';
import type { L2Store, SnapshotRow } from './types.js';

/**
 * L2 — Postgres `kpi_snapshots` (ARCHITECTURE.md §4.5).
 *
 * Unbounded, and last-known-good rather than fresh. It answers exactly one
 * question: *what is the most recent value we ever computed for this fact?*
 * That is the difference between a paid caller getting a number labelled
 * `stale: true` with `confidence` ≥ 0.4, and getting a 503.
 *
 * Like L1, nothing here throws at the read path. If Postgres is also down, the
 * fallback has no fallback and the caller gets an error fact — but that is a
 * decision the read path makes, not an exception this module raises.
 */

const log = logger.child({ component: 'l2' });

interface SnapshotDbRow {
  fact: unknown;
  as_of: Date;
}

class PostgresL2 implements L2Store {
  async latest(key: FactKey): Promise<SnapshotRow | null> {
    try {
      const { rows } = await query<SnapshotDbRow>(
        `SELECT fact, as_of
           FROM kpi_snapshots
          WHERE protocol = $1
            AND metric = $2
            AND params_hash = $3
            AND methodology_version = $4
          ORDER BY as_of DESC
          LIMIT 1`,
        [key.protocol, key.kpi, paramsHash(key.params), env.METHODOLOGY_VERSION],
      );

      const row = rows[0];
      if (row === undefined) return null;

      // Re-validated on the way out, not trusted because we wrote it. The row
      // may predate a schema change, and a fact that no longer parses must
      // read as "no snapshot" rather than escape into a paid response as a
      // shape the caller's client cannot handle.
      const parsed = safeParseKpiFact(row.fact);
      if (!parsed.success || !isSuccessFact(parsed.data)) {
        log.warn({ key: key.protocol + '/' + key.kpi }, 'L2 row failed validation; ignoring it');
        return null;
      }

      return { fact: parsed.data, asOf: row.as_of.toISOString() };
    } catch (err) {
      log.warn({ err, protocol: key.protocol, metric: key.kpi }, 'L2 read failed');
      return null;
    }
  }

  async write(entries: ReadonlyArray<{ key: FactKey; fact: KpiFact }>): Promise<number> {
    // Error facts are never snapshotted. L2's contract is "the last value we
    // knew"; storing a failure would let a later outage answer with a fact
    // whose value is null, which the §2 envelope permits only alongside an
    // error the caller would then read as a *fresh* failure.
    const rows = entries.filter((e) => isSuccessFact(e.fact));
    if (rows.length === 0) return 0;

    try {
      // One statement with UNNEST rather than a loop: the snapshotter writes
      // the entire hot set at once (~40 facts today, more per protocol added),
      // and a round trip per fact is 40 round trips on a job that should be a
      // single, boring insert.
      const result = await query(
        `INSERT INTO kpi_snapshots
           (protocol, metric, value, unit, confidence, methodology_version, as_of, fact, params_hash)
         SELECT * FROM UNNEST(
           $1::text[], $2::text[], $3::double precision[], $4::text[], $5::real[],
           $6::text[], $7::timestamptz[], $8::jsonb[], $9::text[]
         )
         ON CONFLICT (protocol, metric, params_hash, as_of) DO NOTHING`,
        [
          rows.map((e) => e.key.protocol),
          rows.map((e) => e.fact.metric),
          rows.map((e) => e.fact.value),
          rows.map((e) => e.fact.unit),
          rows.map((e) => e.fact.confidence),
          rows.map((e) => e.fact.methodology_version),
          rows.map((e) => e.fact.as_of ?? e.fact.timestamp),
          rows.map((e) => JSON.stringify(pristine(e.fact))),
          rows.map((e) => paramsHash(e.key.params)),
        ],
      );
      return result.rowCount ?? 0;
    } catch (err) {
      log.error({ err, count: rows.length }, 'L2 write failed');
      return 0;
    }
  }
}

/**
 * Strip serve-time labels before storing.
 *
 * A fact read from L1 carries `cache: 'hit'` and whatever notes the serve path
 * added; storing those would bake one request's cache outcome into a row that
 * every later request reads. The snapshot records what the number *was*, and
 * the read path re-labels it as an L2 serve on the way out.
 */
function pristine(fact: KpiFact): KpiFact {
  return {
    ...fact,
    cache: 'miss',
    stale: false,
    notes: (fact.notes ?? []).filter((note) => !note.startsWith(CACHE_NOTE_PREFIX)),
  };
}

/** Marks a note as added by the cache layer, so it can be stripped on store. */
export const CACHE_NOTE_PREFIX = 'Cache:';

export function createPostgresL2(): L2Store {
  return new PostgresL2();
}

let shared: L2Store | null = null;

/** The process-wide L2. Lazy — a test that never falls back opens no connection. */
export function l2(): L2Store {
  return (shared ??= createPostgresL2());
}
