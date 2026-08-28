import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { firstRow } from '@/lib/db/rows';
import { products } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

async function catalogSummary(): Promise<{ products: number; categories: number }> {
  const db = await getDatabase();
  const result = await db.execute<{ products: number; categories: number }>(
    sql`select count(*)::int as products, count(distinct ${products.category})::int as categories from ${products} where ${products.active}`,
  );
  const row = firstRow<{ products: number; categories: number }>(result);
  return { products: row?.products ?? 0, categories: row?.categories ?? 0 };
}

export default async function HomePage() {
  const summary = await catalogSummary();

  return (
    <div className="space-y-12">
      <section className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Industrial buyers search by symptom. Catalog search built for consumer retail
          fails them.
        </h1>
        <p className="max-w-2xl text-lg text-ink-700 dark:text-ink-300">
          A maintenance engineer types <em>get tag data from a ControlLogix into SQL
          Server</em>, not a part number. TagBridge is a storefront for industrial
          connectivity software built around that fact — hybrid retrieval with a
          protocol and vendor synonym layer, a quote path because industrial buying is
          quote-shaped, and subscription sync that survives the failures real
          integrations hit.
        </p>
      </section>

      <section aria-labelledby="status" className="space-y-4">
        <h2 id="status" className="text-sm font-semibold uppercase tracking-widest text-ink-500">
          Build status
        </h2>
        <dl className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
            <dt className="text-sm text-ink-500">Catalog products seeded</dt>
            <dd className="mt-1 font-mono text-3xl">{summary.products}</dd>
          </div>
          <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
            <dt className="text-sm text-ink-500">Categories</dt>
            <dd className="mt-1 font-mono text-3xl">{summary.categories}</dd>
          </div>
          <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
            <dt className="text-sm text-ink-500">Phase</dt>
            <dd className="mt-1 font-mono text-3xl">0</dd>
          </div>
        </dl>
        <p className="text-sm text-ink-500">
          Phase 0 is the foundation: schema, migrations, seeded catalog, authentication
          and CI. Catalog browsing lands in phase 1 and the search pipeline — the part
          this project exists to demonstrate — in phase 2.
        </p>
      </section>
    </div>
  );
}
