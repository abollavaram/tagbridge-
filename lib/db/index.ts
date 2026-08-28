import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

export type AppDatabase = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

let instance: Promise<AppDatabase> | null = null;

/**
 * The database the running app talks to.
 *
 * With DATABASE_URL set (Vercel, CI against Neon, any real deployment) this is
 * Postgres. Without it — a clean clone, `pnpm dev`, the e2e run — it is a
 * file-backed PGlite carrying the same migrations, so the storefront comes up
 * and the tests are meaningful without provisioning anything.
 */
export function getDatabase(): Promise<AppDatabase> {
  if (instance) return instance;
  instance = (async (): Promise<AppDatabase> => {
    // A serverless deployment has a read-only filesystem, so the PGlite
    // fallback cannot work there. Fail with the reason rather than with an
    // obscure write error on the first request.
    if (!getEnv().DATABASE_URL && process.env.VERCEL) {
      throw new Error(
        'DATABASE_URL is not set on this deployment. The local PGlite fallback ' +
          'needs a writable filesystem and cannot run on Vercel — set DATABASE_URL ' +
          'to a Postgres connection string in the project environment variables.',
      );
    }
    if (getEnv().DATABASE_URL) {
      const { getDb } = await import('./client');
      return getDb() as unknown as AppDatabase;
    }
    const { createPgliteHarness } = await import('./pglite');
    const { db } = await createPgliteHarness(process.env.PGLITE_DATA_DIR ?? '.pglite');
    return db as unknown as AppDatabase;
  })();
  return instance;
}

/** Test-only: forget the memoised connection. */
export function resetDatabase(): void {
  instance = null;
}

export { schema };
