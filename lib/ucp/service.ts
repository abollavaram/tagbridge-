import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import { getProductBySlug } from '@/lib/commerce/catalog';
import { search } from '@/lib/search/pipeline';
import { UCP_VERSION } from './manifest';

/**
 * The UCP shopping service.
 *
 * Thin by design. It is a protocol-shaped view over the same search pipeline
 * and catalogue queries the storefront uses, not a parallel implementation —
 * a second code path would drift, and the version an agent sees would slowly
 * stop matching the one a human sees.
 *
 * Every response carries the `ucp` envelope so an agent can tell which
 * protocol version answered it without re-reading the profile.
 */

export const searchRequestSchema = z
  .object({
    query: z.string().min(1).max(200),
    pagination: z.object({ limit: z.number().int().min(1).max(25).optional() }).optional(),
  })
  .strict();

export interface UcpProduct {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string;
  protocols: string[];
  vendor_compatibility: string[];
  license_type: string;
  url: string;
  /** Why this product was returned. UCP has no field for it; agents deserve it. */
  match_reasons: string[];
  offers: {
    variant_id: string;
    sku: string;
    tier: string;
    tag_capacity: number | null;
    currency: string;
    unit_amount: number;
    billing_interval: string;
    volume_breaks: { min_quantity: number; unit_amount: number }[];
  }[];
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  protocols: string[];
  vendor_compat: string[];
  license_type: string;
}

interface VariantRow {
  product_id: string;
  id: string;
  sku: string;
  tier: string;
  tag_capacity: number | null;
  list_price_cents: number;
  billing_interval: string;
}

interface TierRow {
  variant_id: string;
  min_qty: number;
  unit_price_cents: number;
}

/** Envelope every UCP response carries. */
export function ucpEnvelope() {
  return { version: UCP_VERSION };
}

/**
 * Hydrates search hits into full UCP products.
 *
 * Three queries rather than one per hit: the storefront's product page can
 * afford a per-product read, an agent fetching a page of results cannot.
 */
async function hydrate(
  ids: readonly string[],
  origin: string,
  reasonsById: ReadonlyMap<string, string[]>,
): Promise<UcpProduct[]> {
  if (ids.length === 0) return [];
  const db = await getDatabase();
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const productRows = toRows<ProductRow>(
    await db.execute(sql`
      select id, sku, name, slug, category, description, protocols,
             vendor_compat, license_type::text as license_type
      from products where id in (${idList}) and active
    `),
  );
  const variantRows = toRows<VariantRow>(
    await db.execute(sql`
      select product_id, id, sku, tier, tag_capacity, list_price_cents,
             billing_interval::text as billing_interval
      from product_variants where product_id in (${idList}) and active
      order by list_price_cents asc
    `),
  );
  const tierRows =
    variantRows.length === 0
      ? []
      : toRows<TierRow>(
          await db.execute(sql`
            select variant_id, min_qty, unit_price_cents from price_tiers
            where variant_id in (${sql.join(
              variantRows.map((v) => sql`${v.id}::uuid`),
              sql`, `,
            )})
            order by min_qty asc
          `),
        );

  const byProduct = new Map(productRows.map((p) => [p.id, p]));

  // Preserve the ranking the search pipeline produced: an agent reading the
  // first result is reading the top-ranked one.
  return ids.flatMap((id) => {
    const product = byProduct.get(id);
    if (!product) return [];
    const variants = variantRows.filter((v) => v.product_id === id);
    return [
      {
        id: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        description: product.description,
        protocols: product.protocols,
        vendor_compatibility: product.vendor_compat,
        license_type: product.license_type,
        url: `${origin}/products/${product.slug}`,
        match_reasons: reasonsById.get(id) ?? [],
        offers: variants.map((v) => ({
          variant_id: v.id,
          sku: v.sku,
          tier: v.tier,
          tag_capacity: v.tag_capacity,
          currency: 'USD',
          unit_amount: v.list_price_cents,
          billing_interval: v.billing_interval,
          volume_breaks: tierRows
            .filter((t) => t.variant_id === v.id)
            .map((t) => ({ min_quantity: t.min_qty, unit_amount: t.unit_price_cents })),
        })),
      },
    ];
  });
}

export async function ucpCatalogSearch(
  query: string,
  limit: number,
  origin: string,
): Promise<{ ucp: { version: string }; products: UcpProduct[]; total: number }> {
  const result = await search(query, { limit });
  const reasons = new Map(result.hits.map((h) => [h.id, h.reasons]));
  const products = await hydrate(
    result.hits.map((h) => h.id),
    origin,
    reasons,
  );
  return { ucp: ucpEnvelope(), products, total: products.length };
}

export async function ucpCatalogLookup(
  identifier: string,
  origin: string,
): Promise<{ ucp: { version: string }; product: UcpProduct | null }> {
  // An agent may hold either a slug from a URL or a SKU from a quote.
  const db = await getDatabase();
  const bySlug = await getProductBySlug(identifier);
  const id =
    bySlug?.id ??
    toRows<{ id: string }>(
      await db.execute(
        sql`select id from products where upper(sku) = upper(${identifier}) and active limit 1`,
      ),
    )[0]?.id;

  if (!id) return { ucp: ucpEnvelope(), product: null };
  const [product] = await hydrate([id], origin, new Map());
  return { ucp: ucpEnvelope(), product: product ?? null };
}
