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
 * With DATABASE_URL set this is Postgres — Neon, or anything else that speaks
 * the protocol — and it is durable. Without it the app restores the build-time
 * snapshot into an in-process Postgres: same migrations, same pgvector, same
 * constraints, but held in memory, so writes last only as long as the instance.
 * That is what lets the storefront deploy and run with no configuration at all.
 */
export function getDatabase(): Promise<AppDatabase> {
  if (instance) return instance;
  instance = (async (): Promise<AppDatabase> => {
    if (getEnv().DATABASE_URL) {
      const { getDb } = await import('./client');
      return getDb() as unknown as AppDatabase;
    }
    const { createPgliteHarness, restoreFromSnapshot } = await import('./pglite');
    try {
      const { db } = await restoreFromSnapshot();
      return db as unknown as AppDatabase;
    } catch {
      // No snapshot yet — a clean clone running the tests or `pnpm dev` before
      // any build step. Construct the same database the long way rather than
      // failing, including the dense index: seeding alone leaves the vector
      // leg of search silently returning nothing, which is worse than an error
      // because everything still appears to work.
      const { db } = await createPgliteHarness();
      const built = db as unknown as AppDatabase;
      const { seed } = await import('./seed');
      await seed(built);
      const { buildProductIndex } = await import('@/lib/search/indexer');
      await buildProductIndex(built);
      const { buildKnowledgeGraph } = await import('@/lib/graph/build');
      await buildKnowledgeGraph(built);
      return built;
    }
  })();
  return instance;
}

/** Test-only: forget the memoised connection. */
export function resetDatabase(): void {
  instance = null;
}

export { schema };
