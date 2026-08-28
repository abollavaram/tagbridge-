/**
 * Builds the database snapshot the app restores at runtime.
 *
 * Booting PGlite, applying migrations and seeding takes about ten seconds.
 * Doing that once at build time and restoring the result takes about one, so
 * the deployment pays a second on a cold start instead of ten — and the
 * snapshot is identical everywhere, because it is a build artifact rather than
 * something each instance reconstructs.
 */
import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as schema from '@/lib/db/schema';
import { seed } from '@/lib/db/seed';
import { SNAPSHOT_PATH } from '@/lib/db/snapshot-path';

async function main(): Promise<void> {
  const started = Date.now();
  const client = await PGlite.create({ extensions: { vector } });
  const db = drizzle(client, { schema });

  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'lib', 'db', 'migrations') });
  const result = await seed(db as never);

  const dump = await client.dumpDataDir('gzip');
  mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, Buffer.from(await dump.arrayBuffer()));
  await client.close();

  const bytes = statSync(SNAPSHOT_PATH).size;
  console.log(
    `snapshot written: ${(bytes / 1024 / 1024).toFixed(1)} MB in ${Date.now() - started} ms ` +
      `(${result.products} products, ${result.variants} variants, ${result.priceTiers} price tiers, ` +
      `${result.synonyms} synonyms, ${result.users} users)`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
