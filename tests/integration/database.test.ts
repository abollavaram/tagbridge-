import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgliteHarness, type Harness } from '@/lib/db/pglite';
import { SEED_PRODUCTS } from '@/lib/db/catalog';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';
import { seed } from '@/lib/db/seed';
import type { AppDatabase } from '@/lib/db';
import { firstRow, toRows } from '@/lib/db/rows';
import {
  priceTiers,
  productEmbeddings,
  productVariants,
  products,
  synonyms,
  users,
  webhookEvents,
} from '@/lib/db/schema';

let harness: Harness;
let db: AppDatabase;

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ value: number }>(query);
  return firstRow<{ value: number }>(result)?.value ?? 0;
}

beforeAll(async () => {
  harness = await createPgliteHarness();
  db = harness.db as unknown as AppDatabase;
  await seed(db);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('migrations', () => {
  it('installs pgvector', async () => {
    const count = await scalar(
      sql`select count(*)::int as value from pg_extension where extname = 'vector'`,
    );
    expect(count).toBe(1);
  });

  it('creates the GIN index the BM25 leg needs', async () => {
    const count = await scalar(
      sql`select count(*)::int as value from pg_indexes where indexname = 'products_fts_idx'`,
    );
    expect(count).toBe(1);
  });

  it('creates the HNSW index the vector leg needs', async () => {
    const count = await scalar(
      sql`select count(*)::int as value from pg_indexes where indexname = 'product_embeddings_hnsw_idx'`,
    );
    expect(count).toBe(1);
  });

  it('makes webhook event ids unique, which is the idempotency guarantee', async () => {
    const count = await scalar(sql`
      select count(*)::int as value
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'webhook_events' and c.contype = 'u'
    `);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('seed', () => {
  it('loads 50 products', async () => {
    const rows = await db.select({ id: products.id }).from(products);
    expect(rows).toHaveLength(50);
    expect(rows).toHaveLength(SEED_PRODUCTS.length);
  });

  it('loads every variant and its price ladder', async () => {
    const expectedVariants = SEED_PRODUCTS.reduce((n, p) => n + p.variants.length, 0);
    const expectedTiers = SEED_PRODUCTS.reduce(
      (n, p) => n + p.variants.reduce((m, v) => m + v.tiers.length, 0),
      0,
    );
    expect(await db.select({ id: productVariants.id }).from(productVariants)).toHaveLength(
      expectedVariants,
    );
    expect(await db.select({ id: priceTiers.id }).from(priceTiers)).toHaveLength(expectedTiers);
  });

  it('loads the synonym graph and the demo users', async () => {
    expect(await db.select({ id: synonyms.id }).from(synonyms)).toHaveLength(
      SEED_SYNONYMS.length,
    );
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(3);
  });

  it('is idempotent — running it again does not duplicate anything', async () => {
    await seed(db);
    expect(await db.select({ id: products.id }).from(products)).toHaveLength(50);
    expect(await db.select({ id: synonyms.id }).from(synonyms)).toHaveLength(
      SEED_SYNONYMS.length,
    );
  });
});

describe('generated search vector', () => {
  it('is populated for every product', async () => {
    const empty = await scalar(sql`
      select count(*)::int as value from products
      where search_vector is null or search_vector = ''::tsvector
    `);
    expect(empty).toBe(0);
  });

  it('matches an exact part number', async () => {
    const count = await scalar(sql`
      select count(*)::int as value from products
      where search_vector @@ plainto_tsquery('english', 'TB-OPCUA-4100')
    `);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('matches a vendor name that only appears in vendor_compat', async () => {
    const count = await scalar(sql`
      select count(*)::int as value from products
      where search_vector @@ plainto_tsquery('english', 'CompactLogix')
    `);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('weights a name match above a mention buried in prose', async () => {
    const result = await db.execute<{ sku: string; name: string; rank: number }>(sql`
      select sku, name, ts_rank(search_vector, plainto_tsquery('english', 'sparkplug')) as rank
      from products
      where search_vector @@ plainto_tsquery('english', 'sparkplug')
      order by rank desc
    `);
    const rows = toRows<{ sku: string; name: string; rank: number }>(result);
    expect(rows.length).toBeGreaterThan(2);

    const inName = rows.filter((r) => r.name.toLowerCase().includes('sparkplug'));
    const notInName = rows.filter((r) => !r.name.toLowerCase().includes('sparkplug'));
    expect(inName.length).toBeGreaterThan(0);
    expect(notInName.length).toBeGreaterThan(0);

    const worstNamed = Math.min(...inName.map((r) => Number(r.rank)));
    const bestUnnamed = Math.max(...notInName.map((r) => Number(r.rank)));
    expect(worstNamed).toBeGreaterThan(bestUnnamed);
  });

  it('follows an update to the row', async () => {
    await db.execute(sql`
      update products set description = description || ' Includes a bespoke widget.'
      where sku = 'TB-DIAG-9700'
    `);
    const count = await scalar(sql`
      select count(*)::int as value from products
      where sku = 'TB-DIAG-9700' and search_vector @@ plainto_tsquery('english', 'bespoke widget')
    `);
    expect(count).toBe(1);
  });
});

describe('constraints', () => {
  it('refuses a duplicate provider event id', async () => {
    const payload = { id: 'evt_dup', object: 'event' };
    const row = {
      providerEventId: 'evt_dup',
      type: 'customer.subscription.updated',
      payload,
      occurredAt: new Date(),
    };
    await db.insert(webhookEvents).values(row);
    await expect(db.insert(webhookEvents).values(row)).rejects.toThrow();
  });

  it('refuses a duplicate product SKU', async () => {
    await expect(
      db.insert(products).values({
        sku: 'TB-OPCUA-4100',
        name: 'Duplicate',
        slug: 'duplicate-sku-probe',
        category: 'OPC Servers',
        description: 'x',
        licenseType: 'perpetual',
      }),
    ).rejects.toThrow();
  });

  it('stores and reads back a 1536-dimension embedding', async () => {
    const rows = await db.select({ id: products.id }).from(products).limit(1);
    const productId = rows[0]?.id;
    expect(productId).toBeTruthy();
    const embedding = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
    await db.insert(productEmbeddings).values({
      productId: productId as string,
      embedding,
      sourceText: 'probe',
    });
    const stored = await db
      .select({ embedding: productEmbeddings.embedding })
      .from(productEmbeddings);
    expect(stored[0]?.embedding).toHaveLength(1536);
  });

  it('refuses an embedding of the wrong dimension', async () => {
    const rows = await db.select({ id: products.id }).from(products).limit(2);
    const productId = rows[1]?.id;
    await expect(
      db.insert(productEmbeddings).values({
        productId: productId as string,
        embedding: [0.1, 0.2, 0.3],
        sourceText: 'probe',
      }),
    ).rejects.toThrow();
  });
});
