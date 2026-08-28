import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { productEmbeddings, products } from '@/lib/db/schema';
import { getEmbedder, type Embedder } from './embedding';

/**
 * Builds the dense index.
 *
 * The text a product is embedded from is deliberately not just its
 * description: name, SKU, category, protocols and vendor compatibility all
 * carry retrieval signal, and the vendor list is where a query for "Rockwell"
 * has to land. Repeating the name once weights it above the prose without
 * needing a separate field-weighting mechanism on the vector side.
 */
export function embeddingSourceText(product: {
  name: string;
  sku: string;
  category: string;
  description: string;
  protocols: readonly string[];
  vendorCompat: readonly string[];
  specs?: unknown;
}): string {
  // Both keys and values: "ssoSupport" is worth little on its own, while
  // "SAML, OIDC" is exactly what a buyer asking about single sign-on types.
  const specText =
    product.specs && typeof product.specs === 'object'
      ? Object.entries(product.specs as Record<string, unknown>)
          .map(([key, value]) => `${key} ${String(value)}`)
          .join(' ')
      : '';

  return [
    product.name,
    product.name,
    product.sku,
    product.category,
    product.protocols.join(' '),
    product.vendorCompat.join(' '),
    product.description,
    specText,
  ]
    .filter((part) => part.length > 0)
    .join('. ');
}

export interface IndexResult {
  indexed: number;
  embedder: string;
  dimensions: number;
}

export async function buildProductIndex(
  db: AppDatabase,
  embedder?: Embedder,
): Promise<IndexResult> {
  const model = embedder ?? (await getEmbedder());

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      category: products.category,
      description: products.description,
      protocols: products.protocols,
      vendorCompat: products.vendorCompat,
      specs: products.specs,
    })
    .from(products)
    .where(eq(products.active, true));

  const sources = rows.map((row) => embeddingSourceText(row));
  const vectors = await model.embedBatch(sources);

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const embedding = vectors[i];
    const sourceText = sources[i];
    if (!row || !embedding || sourceText === undefined) continue;

    await db
      .insert(productEmbeddings)
      .values({ productId: row.id, embedding, sourceText })
      .onConflictDoUpdate({
        target: productEmbeddings.productId,
        set: { embedding, sourceText, updatedAt: new Date() },
      });
  }

  return { indexed: rows.length, embedder: model.name, dimensions: model.dimensions };
}
