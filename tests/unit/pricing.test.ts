import { describe, expect, it } from 'vitest';
import {
  PricingError,
  containsPriceField,
  formatCents,
  lineItemsRequestSchema,
  lineTotalCents,
  priceLines,
  resolveUnitPriceCents,
  savingsAgainstListCents,
  subtotalCents,
  type Tier,
} from '@/lib/commerce/pricing';

const LADDER: Tier[] = [
  { minQty: 1, unitPriceCents: 100_000 },
  { minQty: 5, unitPriceCents: 90_000 },
  { minQty: 10, unitPriceCents: 82_000 },
  { minQty: 25, unitPriceCents: 75_000 },
];

describe('resolveUnitPriceCents', () => {
  it('uses the quantity-1 price below the first break', () => {
    expect(resolveUnitPriceCents(LADDER, 1)).toBe(100_000);
    expect(resolveUnitPriceCents(LADDER, 4)).toBe(100_000);
  });

  it('takes the new price exactly at a break, not one past it', () => {
    expect(resolveUnitPriceCents(LADDER, 5)).toBe(90_000);
    expect(resolveUnitPriceCents(LADDER, 10)).toBe(82_000);
    expect(resolveUnitPriceCents(LADDER, 25)).toBe(75_000);
  });

  it('holds the last break above the top of the ladder', () => {
    expect(resolveUnitPriceCents(LADDER, 26)).toBe(75_000);
    expect(resolveUnitPriceCents(LADDER, 5_000)).toBe(75_000);
  });

  it('does not depend on the ladder arriving sorted', () => {
    const shuffled = [LADDER[3], LADDER[0], LADDER[2], LADDER[1]] as Tier[];
    expect(resolveUnitPriceCents(shuffled, 12)).toBe(82_000);
  });

  it('refuses a non-positive or fractional quantity', () => {
    expect(() => resolveUnitPriceCents(LADDER, 0)).toThrow(PricingError);
    expect(() => resolveUnitPriceCents(LADDER, -3)).toThrow(PricingError);
    expect(() => resolveUnitPriceCents(LADDER, 1.5)).toThrow(PricingError);
  });

  it('refuses a variant with no ladder rather than inventing a price', () => {
    expect(() => resolveUnitPriceCents([], 1)).toThrow(/no price ladder/);
  });

  it('refuses a quantity below the lowest break rather than guessing', () => {
    const gapped: Tier[] = [{ minQty: 10, unitPriceCents: 5_000 }];
    expect(() => resolveUnitPriceCents(gapped, 3)).toThrow(/no price tier applies/);
  });
});

describe('line and cart totals', () => {
  it('multiplies the resolved unit price by the quantity', () => {
    expect(lineTotalCents(LADDER, 7)).toBe(90_000 * 7);
  });

  it('prices a set of lines independently and sums them', () => {
    const ladders = new Map<string, Tier[]>([
      ['a', LADDER],
      ['b', [{ minQty: 1, unitPriceCents: 25_000 }]],
    ]);
    const priced = priceLines(
      [
        { variantId: 'a', qty: 10 },
        { variantId: 'b', qty: 3 },
      ],
      ladders,
    );
    expect(priced[0]?.unitPriceCents).toBe(82_000);
    expect(priced[0]?.lineTotalCents).toBe(820_000);
    expect(priced[1]?.lineTotalCents).toBe(75_000);
    expect(subtotalCents(priced)).toBe(895_000);
  });

  it('refuses a line for a variant it has no ladder for', () => {
    expect(() => priceLines([{ variantId: 'ghost', qty: 1 }], new Map())).toThrow(
      /unknown variant/,
    );
  });

  it('reports the saving against the quantity-1 price', () => {
    expect(savingsAgainstListCents(LADDER, 10)).toBe(100_000 * 10 - 82_000 * 10);
    expect(savingsAgainstListCents(LADDER, 1)).toBe(0);
  });
});

describe('the request schema refuses a caller-supplied price', () => {
  it('accepts a bare variant and quantity', () => {
    const parsed = lineItemsRequestSchema.safeParse([
      { variantId: '11111111-1111-4111-8111-111111111111', qty: 2 },
    ]);
    expect(parsed.success).toBe(true);
  });

  it('rejects a line carrying a price', () => {
    const parsed = lineItemsRequestSchema.safeParse([
      { variantId: '11111111-1111-4111-8111-111111111111', qty: 2, unitPriceCents: 1 },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('rejects a quantity outside the accepted range', () => {
    for (const qty of [0, -1, 10_000, 2.5]) {
      expect(
        lineItemsRequestSchema.safeParse([
          { variantId: '11111111-1111-4111-8111-111111111111', qty },
        ]).success,
        `qty ${qty}`,
      ).toBe(false);
    }
  });

  it('rejects a malformed variant id', () => {
    expect(
      lineItemsRequestSchema.safeParse([{ variantId: 'not-a-uuid', qty: 1 }]).success,
    ).toBe(false);
  });
});

describe('containsPriceField', () => {
  it('spots a price however it is spelled', () => {
    for (const key of [
      'price',
      'unitPrice',
      'unit_price_cents',
      'lineTotal',
      'totalCents',
      'subtotal',
      'amount',
      'discount',
      'discountPercent',
    ]) {
      expect(containsPriceField({ [key]: 1 }), key).toBe(true);
    }
  });

  it('spots one nested inside an array of lines', () => {
    expect(containsPriceField([{ variantId: 'a', qty: 1 }, { qty: 2, price: 5 }])).toBe(true);
  });

  it('spots one nested several levels down', () => {
    expect(containsPriceField({ quote: { lines: [{ meta: { total: 9 } }] } })).toBe(true);
  });

  it('passes a clean request through', () => {
    expect(containsPriceField([{ variantId: 'a', qty: 1 }])).toBe(false);
    expect(containsPriceField({ note: 'customer asked about quantity' })).toBe(false);
  });
});

describe('formatCents', () => {
  it('renders whole and fractional amounts', () => {
    expect(formatCents(189_000)).toBe('$1,890.00');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(1)).toBe('$0.01');
  });
});
