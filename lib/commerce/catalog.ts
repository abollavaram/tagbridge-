import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { firstRow, toRows } from '@/lib/db/rows';
import { priceTiers, productVariants, products } from '@/lib/db/schema';
import type { Tier } from './pricing';

export interface CatalogFilters {
  category?: string | undefined;
  protocol?: string | undefined;
  vendor?: string | undefined;
  licenseType?: 'perpetual' | 'subscription' | undefined;
  page?: number | undefined;
}

export const PAGE_SIZE = 12;

export interface CatalogCard {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  protocols: string[];
  licenseType: 'perpetual' | 'subscription';
  fromPriceCents: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface CatalogFacets {
  categories: FacetValue[];
  protocols: FacetValue[];
  vendors: FacetValue[];
  licenseTypes: FacetValue[];
}

function filterConditions(filters: CatalogFilters) {
  const conditions = [eq(products.active, true)];
  if (filters.category) conditions.push(eq(products.category, filters.category));
  if (filters.licenseType) conditions.push(eq(products.licenseType, filters.licenseType));
  if (filters.protocol) {
    conditions.push(sql`${filters.protocol} = ANY(${products.protocols})`);
  }
  if (filters.vendor) {
    conditions.push(sql`${filters.vendor} = ANY(${products.vendorCompat})`);
  }
  return and(...conditions);
}

export interface CatalogPage {
  items: CatalogCard[];
  total: number;
  page: number;
  pageCount: number;
}

export async function listProducts(filters: CatalogFilters = {}): Promise<CatalogPage> {
  const db = await getDatabase();
  const page = Math.max(1, filters.page ?? 1);
  const where = filterConditions(filters);

  const totalResult = await db.select({ value: count() }).from(products).where(where);
  const total = totalResult[0]?.value ?? 0;

  // Cheapest variant per product, so the card can say "from $x" honestly.
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      slug: products.slug,
      category: products.category,
      description: products.description,
      protocols: products.protocols,
      licenseType: products.licenseType,
      fromPriceCents: sql<number>`min(${productVariants.listPriceCents})::int`,
    })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .where(where)
    .groupBy(products.id)
    .orderBy(asc(products.name))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  return {
    items: rows as CatalogCard[],
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/**
 * Facet counts are computed against the active catalog rather than against the
 * current filter, so a count never disappears to zero as filters are applied
 * and a buyer can always see what else is there.
 */
export async function catalogFacets(): Promise<CatalogFacets> {
  const db = await getDatabase();

  const categories = await db
    .select({ value: products.category, count: count() })
    .from(products)
    .where(eq(products.active, true))
    .groupBy(products.category)
    .orderBy(asc(products.category));

  const protocolRows = await db.execute<{ value: string; count: number }>(sql`
    select unnest(protocols) as value, count(*)::int as count
    from products where active
    group by 1 order by 2 desc, 1 asc
  `);

  const vendorRows = await db.execute<{ value: string; count: number }>(sql`
    select unnest(vendor_compat) as value, count(*)::int as count
    from products where active
    group by 1 order by 2 desc, 1 asc
  `);

  const licenseTypes = await db
    .select({ value: products.licenseType, count: count() })
    .from(products)
    .where(eq(products.active, true))
    .groupBy(products.licenseType);

  return {
    categories: categories.map((r) => ({ value: r.value, count: r.count })),
    protocols: toRows<{ value: string; count: number }>(protocolRows),
    vendors: toRows<{ value: string; count: number }>(vendorRows),
    licenseTypes: licenseTypes.map((r) => ({ value: r.value, count: r.count })),
  };
}

export interface VariantWithLadder {
  id: string;
  sku: string;
  tier: string;
  tagCapacity: number | null;
  listPriceCents: number;
  billingInterval: 'none' | 'monthly' | 'annual';
  tiers: Tier[];
}

export interface ProductDetail {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  protocols: string[];
  vendorCompat: string[];
  licenseType: 'perpetual' | 'subscription';
  specs: Record<string, unknown>;
  variants: VariantWithLadder[];
}

export async function getProductBySlug(slug: string): Promise<ProductDetail | null> {
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.active, true)))
    .limit(1);
  const product = rows[0];
  if (!product) return null;

  const variantRows = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.productId, product.id), eq(productVariants.active, true)))
    .orderBy(asc(productVariants.listPriceCents));

  const ladders = variantRows.length
    ? await db
        .select()
        .from(priceTiers)
        .where(
          inArray(
            priceTiers.variantId,
            variantRows.map((v) => v.id),
          ),
        )
        .orderBy(asc(priceTiers.minQty))
    : [];

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    category: product.category,
    description: product.description,
    protocols: product.protocols,
    vendorCompat: product.vendorCompat,
    licenseType: product.licenseType,
    specs: (product.specs ?? {}) as Record<string, unknown>,
    variants: variantRows.map((v) => ({
      id: v.id,
      sku: v.sku,
      tier: v.tier,
      tagCapacity: v.tagCapacity,
      listPriceCents: v.listPriceCents,
      billingInterval: v.billingInterval,
      tiers: ladders
        .filter((t) => t.variantId === v.id)
        .map((t) => ({ minQty: t.minQty, unitPriceCents: t.unitPriceCents })),
    })),
  };
}

export async function allProductSlugs(): Promise<string[]> {
  const db = await getDatabase();
  const rows = await db
    .select({ slug: products.slug })
    .from(products)
    .where(eq(products.active, true));
  return rows.map((r) => r.slug);
}

/**
 * Price ladders for a set of variants, keyed for the pricing engine. Every
 * price the app quotes is resolved through this, from the database.
 */
export async function laddersForVariants(
  variantIds: readonly string[],
): Promise<Map<string, Tier[]>> {
  const map = new Map<string, Tier[]>();
  if (variantIds.length === 0) return map;
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(priceTiers)
    .where(inArray(priceTiers.variantId, [...variantIds]))
    .orderBy(asc(priceTiers.minQty));
  for (const row of rows) {
    const list = map.get(row.variantId) ?? [];
    list.push({ minQty: row.minQty, unitPriceCents: row.unitPriceCents });
    map.set(row.variantId, list);
  }
  return map;
}

export interface VariantSummary {
  id: string;
  sku: string;
  tier: string;
  billingInterval: 'none' | 'monthly' | 'annual';
  productName: string;
  productSlug: string;
}

export async function variantSummaries(
  variantIds: readonly string[],
): Promise<Map<string, VariantSummary>> {
  const map = new Map<string, VariantSummary>();
  if (variantIds.length === 0) return map;
  const db = await getDatabase();
  const rows = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      tier: productVariants.tier,
      billingInterval: productVariants.billingInterval,
      productName: products.name,
      productSlug: products.slug,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, [...variantIds]));
  for (const row of rows) map.set(row.id, row);
  return map;
}

/** Used by the phase-2 search work and by the catalog search box. */
export async function findProductsByText(term: string, limit = 10): Promise<CatalogCard[]> {
  const db = await getDatabase();
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      slug: products.slug,
      category: products.category,
      description: products.description,
      protocols: products.protocols,
      licenseType: products.licenseType,
      fromPriceCents: sql<number>`min(${productVariants.listPriceCents})::int`,
    })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(products.active, true),
        or(ilike(products.name, `%${term}%`), ilike(products.sku, `%${term}%`)),
      ),
    )
    .groupBy(products.id)
    .limit(limit);
  return rows as CatalogCard[];
}

export async function productCount(): Promise<number> {
  const db = await getDatabase();
  const result = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from ${products} where ${products.active}`,
  );
  return firstRow<{ count: number }>(result)?.count ?? 0;
}
