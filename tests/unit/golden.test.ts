import { describe, expect, it } from 'vitest';
import { SEED_PRODUCTS } from '@/lib/db/catalog';
import { BUCKETS, GOLDEN_QUERIES, queriesInBucket } from '@/evals/search/golden';

const catalogSkus = new Set(SEED_PRODUCTS.map((p) => p.sku));

describe('golden query set', () => {
  it('has the 100 queries the spec asks for', () => {
    expect(GOLDEN_QUERIES).toHaveLength(100);
  });

  it('splits evenly into four buckets of 25', () => {
    for (const bucket of BUCKETS) {
      expect(queriesInBucket(bucket), bucket).toHaveLength(25);
    }
  });

  it('has unique query ids', () => {
    const ids = GOLDEN_QUERIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate query text', () => {
    const texts = GOLDEN_QUERIES.map((q) => q.query.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('labels every query with at least one relevant product', () => {
    for (const q of GOLDEN_QUERIES) {
      expect(q.relevant.length, q.id).toBeGreaterThan(0);
    }
  });

  it('only labels products that exist in the catalogue', () => {
    const unknown: string[] = [];
    for (const q of GOLDEN_QUERIES) {
      for (const sku of q.relevant) {
        if (!catalogSkus.has(sku)) unknown.push(`${q.id}: ${sku}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('never repeats a product within one query label', () => {
    for (const q of GOLDEN_QUERIES) {
      expect(new Set(q.relevant).size, q.id).toBe(q.relevant.length);
    }
  });

  it('gives every part-number query exactly one answer', () => {
    for (const q of queriesInBucket('part-number')) {
      expect(q.relevant.length, q.id).toBe(1);
    }
  });

  it('covers a broad slice of the catalogue rather than a handful of products', () => {
    const labelled = new Set(GOLDEN_QUERIES.flatMap((q) => q.relevant));
    expect(labelled.size).toBeGreaterThanOrEqual(45);
  });

  it('does not lean on one product for a large share of the labels', () => {
    const counts = new Map<string, number>();
    for (const q of GOLDEN_QUERIES) {
      for (const sku of q.relevant) counts.set(sku, (counts.get(sku) ?? 0) + 1);
    }
    const worst = Math.max(...counts.values());
    expect(worst).toBeLessThanOrEqual(10);
  });
});
