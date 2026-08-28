/**
 * Prepares the database the app will read.
 *
 * With DATABASE_URL set, migrates and seeds that Postgres. Without one, builds
 * the snapshot the app restores in-process — which is what makes a clean clone,
 * the e2e run and a zero-configuration deployment all work.
 */
import 'dotenv/config';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('target: build-time snapshot (no DATABASE_URL set)');
    await import('./build-db-snapshot');
    return;
  }

  const { sql } = await import('drizzle-orm');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const postgres = (await import('postgres')).default;
  const schema = await import('@/lib/db/schema');
  const { seed } = await import('@/lib/db/seed');
  const { buildProductIndex } = await import('@/lib/search/indexer');

  console.log('target: DATABASE_URL');
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
  await migrate(db, { migrationsFolder: 'lib/db/migrations' });
  const result = await seed(db as never);
  const index = await buildProductIndex(db as never);
  await client.end();
  console.log(
    `seeded ${result.products} products, ${result.variants} variants, ` +
      `${result.priceTiers} price tiers, ${result.synonyms} synonyms, ${result.users} users, ` +
      `${index.indexed} embeddings via ${index.embedder}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
