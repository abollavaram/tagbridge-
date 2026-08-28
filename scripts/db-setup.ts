/**
 * Prepares a local database for development, e2e and a clean clone.
 *
 * With DATABASE_URL set it migrates and seeds that Postgres. Without it, it
 * creates the file-backed PGlite database the app falls back to.
 */
import 'dotenv/config';
import { seed } from '@/lib/db/seed';
import type { AppDatabase } from '@/lib/db/index';

async function main(): Promise<void> {
  let db: AppDatabase;
  let close: () => Promise<void> = async () => {};

  if (process.env.DATABASE_URL) {
    const { sql } = await import('drizzle-orm');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const postgres = (await import('postgres')).default;
    const schema = await import('@/lib/db/schema');
    const client = postgres(process.env.DATABASE_URL, { max: 1 });
    const pg = drizzle(client, { schema });
    await pg.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
    await migrate(pg, { migrationsFolder: 'lib/db/migrations' });
    db = pg as unknown as AppDatabase;
    close = async () => {
      await client.end();
    };
    console.log('target: DATABASE_URL');
  } else {
    const { createPgliteHarness } = await import('@/lib/db/pglite');
    const dir = process.env.PGLITE_DATA_DIR ?? '.pglite';
    const harness = await createPgliteHarness(dir);
    db = harness.db as unknown as AppDatabase;
    close = harness.close;
    console.log(`target: PGlite (${dir})`);
  }

  const result = await seed(db);
  console.log(
    `seeded ${result.products} products, ${result.variants} variants, ` +
      `${result.priceTiers} price tiers, ${result.synonyms} synonyms, ${result.users} users`,
  );
  await close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
