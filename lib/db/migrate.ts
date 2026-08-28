/**
 * Applies migrations to the database named by DATABASE_URL.
 * Without DATABASE_URL there is nothing to migrate — the PGlite harness applies
 * the same migrations itself on creation.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import * as schema from './schema';

const MIGRATIONS_FOLDER = path.join(process.cwd(), 'lib', 'db', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for pnpm db:migrate.');
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector;`);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await client.end();
  console.log('migrations applied');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
