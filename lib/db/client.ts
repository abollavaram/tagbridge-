import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

let cached: { db: Database; close: () => Promise<void> } | null = null;

/**
 * Connect to the Postgres named by DATABASE_URL.
 *
 * Local development and CI run against PGlite instead (see `lib/db/pglite.ts`),
 * which speaks the same SQL and carries the same migrations, so nothing in the
 * app has to know which one it is talking to.
 */
export function getDb(): Database {
  if (cached) return cached.db;
  const url = getEnv().DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Set it to a Postgres connection string, or use the ' +
        'PGlite harness (lib/db/pglite.ts) for local development and tests.',
    );
  }
  const sql = postgres(url, { max: 5, prepare: false });
  cached = {
    db: drizzlePostgres(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
  return cached.db;
}

export async function closeDb(): Promise<void> {
  if (!cached) return;
  await cached.close();
  cached = null;
}

export { schema };
