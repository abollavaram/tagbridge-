import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import type { RankedItem } from './fusion';

/**
 * The two retrieval legs.
 *
 * BM25 over the generated `tsvector` finds exact part numbers and protocol
 * strings, which embeddings fumble. Dense retrieval over pgvector finds
 * problem-shaped queries, where the buyer describes a symptom and never names
 * the product. Neither is good enough alone; that is the point of the hybrid.
 */

export interface RetrievedRow extends RankedItem {
  sku: string;
  name: string;
  slug: string;
}

/**
 * Lexical retrieval.
 *
 * Terms are OR-ed as separate `plainto_tsquery` calls rather than concatenated
 * into one string: a synonym expansion of twenty terms AND-ed together matches
 * nothing, and building the query text by hand invites injection. Ranking uses
 * `ts_rank_cd`, which accounts for term proximity, over the weighted vector —
 * so a part number in the name outranks the same string buried in prose.
 */
export async function bm25Search(
  terms: readonly string[],
  limit = 20,
): Promise<RetrievedRow[]> {
  const usable = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (usable.length === 0) return [];

  const db = await getDatabase();
  const queries = usable.map((term) => sql`plainto_tsquery('english', ${term})`);
  const combined = sql.join(queries, sql` || `);

  const result = await db.execute<{
    id: string;
    sku: string;
    name: string;
    slug: string;
    score: number;
  }>(sql`
    with q as (select ${combined} as query)
    select p.id, p.sku, p.name, p.slug,
           ts_rank_cd(p.search_vector, q.query)::float8 as score
    from products p, q
    where p.active and p.search_vector @@ q.query
    order by score desc, p.name asc
    limit ${limit}
  `);

  return toRows<{ id: string; sku: string; name: string; slug: string; score: number }>(
    result,
  ).map((r) => ({ ...r, score: Number(r.score) }));
}

/**
 * The naive baseline: unweighted full-text search over name and description
 * only, on the raw query.
 *
 * This is what a catalogue gets from a default full-text implementation — no
 * field weighting, no protocol or vendor fields, no spec values, no synonyms.
 * It is in the table because it is the honest description of the incumbent an
 * industrial buyer is actually failing to find things in, and because the gap
 * between it and the weighted baseline shows how much of the work is schema
 * design rather than retrieval cleverness.
 */
export async function naiveBm25Search(
  terms: readonly string[],
  limit = 20,
): Promise<RetrievedRow[]> {
  const usable = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (usable.length === 0) return [];

  const db = await getDatabase();
  const queries = usable.map((term) => sql`plainto_tsquery('english', ${term})`);
  const combined = sql.join(queries, sql` || `);

  const result = await db.execute<{
    id: string;
    sku: string;
    name: string;
    slug: string;
    score: number;
  }>(sql`
    with q as (select ${combined} as query)
    select p.id, p.sku, p.name, p.slug,
           ts_rank(to_tsvector('english', p.name || ' ' || p.description), q.query)::float8 as score
    from products p, q
    where p.active
      and to_tsvector('english', p.name || ' ' || p.description) @@ q.query
    order by score desc, p.name asc
    limit ${limit}
  `);

  return toRows<{ id: string; sku: string; name: string; slug: string; score: number }>(
    result,
  ).map((r) => ({ ...r, score: Number(r.score) }));
}

/**
 * Dense retrieval over pgvector, ordered by cosine distance.
 *
 * Score is reported as similarity (1 - distance) so that higher is better in
 * both legs, which keeps the fusion input consistent.
 */
export async function vectorSearch(
  embedding: readonly number[],
  limit = 20,
): Promise<RetrievedRow[]> {
  if (embedding.length === 0) return [];

  const db = await getDatabase();
  const literal = `[${embedding.join(',')}]`;

  const result = await db.execute<{
    id: string;
    sku: string;
    name: string;
    slug: string;
    score: number;
  }>(sql`
    select p.id, p.sku, p.name, p.slug,
           (1 - (e.embedding <=> ${literal}::vector))::float8 as score
    from product_embeddings e
    join products p on p.id = e.product_id
    where p.active
    order by e.embedding <=> ${literal}::vector
    limit ${limit}
  `);

  return toRows<{ id: string; sku: string; name: string; slug: string; score: number }>(
    result,
  ).map((r) => ({ ...r, score: Number(r.score) }));
}

/**
 * Exact and prefix matches on a part number.
 *
 * Full-text search stems and tokenises, which is right for prose and wrong for
 * a SKU a buyer copied off a quote. This runs alongside BM25 rather than
 * inside it, so an exact hit cannot be diluted by ranking.
 */
export async function partNumberSearch(
  partNumbers: readonly string[],
  limit = 10,
): Promise<RetrievedRow[]> {
  if (partNumbers.length === 0) return [];

  const db = await getDatabase();
  const upper = partNumbers.map((p) => p.toUpperCase());

  // Built as OR chains of bound parameters rather than an array parameter:
  // the driver binds a JS array as a single scalar, which Postgres then fails
  // to parse as text[].
  const exact = sql.join(
    upper.map((p) => sql`upper(p.sku) = ${p}`),
    sql` or `,
  );
  const prefixOnProduct = sql.join(
    upper.map((p) => sql`upper(p.sku) like ${`${p}%`}`),
    sql` or `,
  );
  const prefixOnVariant = sql.join(
    upper.map((p) => sql`upper(v.sku) like ${`${p}%`}`),
    sql` or `,
  );

  const result = await db.execute<{
    id: string;
    sku: string;
    name: string;
    slug: string;
    score: number;
  }>(sql`
    select p.id, p.sku, p.name, p.slug,
           case when (${exact}) then 1.0 else 0.8 end::float8 as score
    from products p
    where p.active and (
      (${prefixOnProduct})
      or exists (
        select 1 from product_variants v
        where v.product_id = p.id and (${prefixOnVariant})
      )
    )
    order by score desc, p.sku asc
    limit ${limit}
  `);

  return toRows<{ id: string; sku: string; name: string; slug: string; score: number }>(
    result,
  ).map((r) => ({ ...r, score: Number(r.score) }));
}
