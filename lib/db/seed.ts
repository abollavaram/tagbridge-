/**
 * Seeds the catalog, the synonym graph and the demo users.
 *
 * Idempotent: re-running updates existing rows rather than duplicating them,
 * so it is safe to point at a deployed database more than once.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import type { AppDatabase } from './index';
import { firstRow } from './rows';
import { SEED_PRODUCTS } from './catalog';
import { SEED_SYNONYMS } from './synonyms';
import {
  priceTiers,
  productVariants,
  products,
  synonyms,
  users,
} from './schema';

export interface SeedResult {
  products: number;
  variants: number;
  priceTiers: number;
  synonyms: number;
  users: number;
}

const DEMO_USERS = [
  { email: 'buyer@example.com', name: 'Demo Buyer', role: 'buyer' as const, companyName: 'Northfield Processing' },
  { email: 'sales@example.com', name: 'Demo Sales', role: 'sales' as const, companyName: 'TagBridge' },
  { email: 'admin@example.com', name: 'Demo Admin', role: 'admin' as const, companyName: 'TagBridge' },
];

export async function seed(db: AppDatabase): Promise<SeedResult> {
  let variantCount = 0;
  let tierCount = 0;

  for (const p of SEED_PRODUCTS) {
    const [row] = await db
      .insert(products)
      .values({
        sku: p.sku,
        name: p.name,
        slug: p.slug,
        category: p.category,
        description: p.description,
        protocols: p.protocols,
        vendorCompat: p.vendorCompat,
        licenseType: p.licenseType,
        specs: p.specs,
        active: true,
      })
      .onConflictDoUpdate({
        target: products.sku,
        set: {
          name: p.name,
          slug: p.slug,
          category: p.category,
          description: p.description,
          protocols: p.protocols,
          vendorCompat: p.vendorCompat,
          licenseType: p.licenseType,
          specs: p.specs,
          updatedAt: new Date(),
        },
      })
      .returning({ id: products.id });

    if (!row) throw new Error(`failed to upsert product ${p.sku}`);

    for (const v of p.variants) {
      const [variantRow] = await db
        .insert(productVariants)
        .values({
          productId: row.id,
          sku: v.sku,
          tier: v.tier,
          tagCapacity: v.tagCapacity,
          listPriceCents: v.listPriceCents,
          billingInterval: v.billingInterval,
        })
        .onConflictDoUpdate({
          target: productVariants.sku,
          set: {
            productId: row.id,
            tier: v.tier,
            tagCapacity: v.tagCapacity,
            listPriceCents: v.listPriceCents,
            billingInterval: v.billingInterval,
          },
        })
        .returning({ id: productVariants.id });

      if (!variantRow) throw new Error(`failed to upsert variant ${v.sku}`);
      variantCount += 1;

      for (const t of v.tiers) {
        await db
          .insert(priceTiers)
          .values({
            variantId: variantRow.id,
            minQty: t.minQty,
            unitPriceCents: t.unitPriceCents,
          })
          .onConflictDoUpdate({
            target: [priceTiers.variantId, priceTiers.minQty],
            set: { unitPriceCents: t.unitPriceCents },
          });
        tierCount += 1;
      }
    }
  }

  for (const s of SEED_SYNONYMS) {
    await db
      .insert(synonyms)
      .values({ term: s.term, canonical: s.canonical, kind: s.kind })
      .onConflictDoUpdate({
        target: [synonyms.term, synonyms.canonical],
        set: { kind: s.kind },
      });
  }

  for (const u of DEMO_USERS) {
    await db
      .insert(users)
      .values({ email: u.email, name: u.name, role: u.role, companyName: u.companyName })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: u.name, role: u.role, companyName: u.companyName },
      });
  }

  return {
    products: SEED_PRODUCTS.length,
    variants: variantCount,
    priceTiers: tierCount,
    synonyms: SEED_SYNONYMS.length,
    users: DEMO_USERS.length,
  };
}

/** True when the catalog already carries the full seed. */
export async function isSeeded(db: AppDatabase): Promise<boolean> {
  const result = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from ${products}`,
  );
  return (firstRow<{ count: number }>(result)?.count ?? 0) >= SEED_PRODUCTS.length;
}

async function main(): Promise<void> {
  const { getDatabase } = await import('./index');
  const db = await getDatabase();
  const result = await seed(db);
  console.log(
    `seeded ${result.products} products, ${result.variants} variants, ` +
      `${result.priceTiers} price tiers, ${result.synonyms} synonyms, ${result.users} users`,
  );
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
