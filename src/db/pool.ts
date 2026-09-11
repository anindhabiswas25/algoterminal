import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import { env } from '../config/env.js';
import { logger } from '../logger.js';

/**
 * The shared Postgres pool — L2 (`kpi_snapshots`) today, the payment ledger at
 * step 11.
 *
 * Built lazily and memoised for the same reason `connectorContext()` is: a
 * connection pool is a resource with a size, and a second one silently doubles
 * the connection count Railway's Postgres plan is sized for. Lazily, because
 * `DATABASE_URL` being present must not mean a test process that never touches
 * L2 opens a socket to it.
 */
let pool: Pool | null = null;

const log = logger.child({ component: 'postgres' });

export function db(): Pool {
  if (pool !== null) return pool;

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    // L2 is a fallback path, not the hot path: it is read only when Redis and
    // the upstream have both failed, and written once every 15 minutes by the
    // snapshotter. A large pool here would reserve connections that spend
    // their lives idle.
    max: 5,
    // A connection acquire that blocks longer than this is a stalled request
    // on a path whose entire purpose is to answer fast when other things are
    // broken. Failing is better than hanging: the caller degrades to an error
    // fact, which is labelled, rather than to a timeout, which is not.
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  });

  // An idle client erroring (a server restart, a dropped TCP connection) emits
  // on the pool. Unhandled, that is an uncaught exception that takes the
  // process down — a Postgres blip must degrade L2, not kill the API.
  pool.on('error', (err) => log.error({ err }, 'idle postgres client error'));

  return pool;
}

/** Query helper that keeps `db()` lazy at every call site. */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  return db().query<R>(text, params as unknown[]);
}

/** Run `fn` with one dedicated client, always released. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Close the pool. Called on shutdown and between test suites. */
export async function closeDb(): Promise<void> {
  if (pool === null) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

/** Cheap liveness probe for `/health`. Never throws. */
export async function pingDb(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    log.warn({ err }, 'postgres ping failed');
    return false;
  }
}
