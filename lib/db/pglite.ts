import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import * as schema from './schema';

export type PgliteDb = PgliteDatabase<typeof schema>;

/**
 * Resolved from the working directory rather than from import.meta.url: the
 * bundler treats a URL relative to this module as a module specifier and fails
 * the build. The PGlite path only ever runs from the repo root (dev, tests,
 * e2e); a deployment sets DATABASE_URL and never reaches it.
 */
const MIGRATIONS_FOLDER = path.join(process.cwd(), 'lib', 'db', 'migrations');

export interface Harness {
  db: PgliteDb;
  client: PGlite;
  close: () => Promise<void>;
}

/**
 * Restores the build-time snapshot into a fresh in-process Postgres.
 *
 * This is what the app runs on when no DATABASE_URL is configured. The
 * database is real — real migrations, real pgvector, real constraints — but it
 * lives in memory, so writes are per-instance and do not outlive it. Setting
 * DATABASE_URL swaps in a durable Postgres and this path is never taken.
 */
export async function restoreFromSnapshot(): Promise<Harness> {
  const { readFileSync } = await import('node:fs');
  const { SNAPSHOT_PATH } = await import('./snapshot-path');
  const bytes = readFileSync(SNAPSHOT_PATH);
  const client = await PGlite.create({
    loadDataDir: new Blob([bytes]),
    extensions: { vector },
  });
  const db = drizzle(client, { schema });
  return {
    db,
    client,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * An in-process Postgres carrying the real migrations and the real pgvector
 * extension. Used by the test suite and by `pnpm db:seed` on a clean clone, so
 * that neither needs a provisioned database to run.
 */
export async function createPgliteHarness(dataDir?: string): Promise<Harness> {
  const client = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    extensions: { vector },
  });
  const db = drizzle(client, { schema });
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    client,
    close: async () => {
      await client.close();
    },
  };
}
