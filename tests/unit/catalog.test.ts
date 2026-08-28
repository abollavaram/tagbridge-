import { describe, expect, it } from 'vitest';
import { CATEGORIES, SEED_PRODUCTS } from '@/lib/db/catalog';

describe('seed catalog', () => {
  it('carries the 50 products the spec asks for', () => {
    expect(SEED_PRODUCTS).toHaveLength(50);
  });

  it('has unique product SKUs and slugs', () => {
    const skus = SEED_PRODUCTS.map((p) => p.sku);
    const slugs = SEED_PRODUCTS.map((p) => p.slug);
    expect(new Set(skus).size).toBe(skus.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has unique variant SKUs across the whole catalog', () => {
    const variantSkus = SEED_PRODUCTS.flatMap((p) => p.variants.map((v) => v.sku));
    expect(variantSkus.length).toBeGreaterThan(0);
    expect(new Set(variantSkus).size).toBe(variantSkus.length);
  });

  it('gives every product at least one variant and a real description', () => {
    for (const p of SEED_PRODUCTS) {
      expect(p.variants.length, p.sku).toBeGreaterThan(0);
      expect(p.description.length, p.sku).toBeGreaterThan(120);
      expect(p.protocols.length, p.sku).toBeGreaterThan(0);
    }
  });

  it('only uses declared categories, and uses all of them', () => {
    const used = new Set(SEED_PRODUCTS.map((p) => p.category));
    for (const c of used) expect(CATEGORIES).toContain(c);
    for (const c of CATEGORIES) expect(used.has(c), `${c} has no products`).toBe(true);
  });

  it('prices every variant above zero', () => {
    for (const p of SEED_PRODUCTS) {
      for (const v of p.variants) {
        expect(v.listPriceCents, v.sku).toBeGreaterThan(0);
        expect(Number.isInteger(v.listPriceCents), v.sku).toBe(true);
      }
    }
  });

  it('gives every subscription variant a billing interval, and every perpetual one none', () => {
    for (const p of SEED_PRODUCTS) {
      for (const v of p.variants) {
        if (p.licenseType === 'subscription') {
          expect(v.billingInterval, v.sku).not.toBe('none');
        } else {
          expect(v.billingInterval, v.sku).toBe('none');
        }
      }
    }
  });
});

describe('price tiers', () => {
  it('starts every ladder at quantity 1', () => {
    for (const p of SEED_PRODUCTS) {
      for (const v of p.variants) {
        expect(v.tiers[0]?.minQty, v.sku).toBe(1);
      }
    }
  });

  it('has strictly ascending break quantities', () => {
    for (const p of SEED_PRODUCTS) {
      for (const v of p.variants) {
        for (let i = 1; i < v.tiers.length; i += 1) {
          const prev = v.tiers[i - 1];
          const cur = v.tiers[i];
          expect(cur?.minQty, v.sku).toBeGreaterThan(prev?.minQty ?? -1);
        }
      }
    }
  });

  it('never charges more per unit at a higher quantity', () => {
    for (const p of SEED_PRODUCTS) {
      for (const v of p.variants) {
        for (let i = 1; i < v.tiers.length; i += 1) {
          const prev = v.tiers[i - 1];
          const cur = v.tiers[i];
          expect(cur?.unitPriceCents, v.sku).toBeLessThanOrEqual(prev?.unitPriceCents ?? 0);
        }
      }
    }
  });

  it('matches list price at quantity 1', () => {
    for (const p of SEED_PRODUCTS) {
      for (const v of p.variants) {
        expect(v.tiers[0]?.unitPriceCents, v.sku).toBe(v.listPriceCents);
      }
    }
  });
});
