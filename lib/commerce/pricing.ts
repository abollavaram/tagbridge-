import { z } from 'zod';

/**
 * Pricing is computed here and nowhere else.
 *
 * Every path that produces a price — the cart, checkout, a quote, and from
 * phase 3 the agent — resolves it from the variant's price ladder on the
 * server. No caller supplies a price, and the schemas below reject one if a
 * caller tries.
 */

export interface Tier {
  minQty: number;
  unitPriceCents: number;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * The unit price for a quantity: the highest break whose minimum quantity the
 * order reaches. Ladders are not assumed to arrive sorted.
 */
export function resolveUnitPriceCents(tiers: readonly Tier[], qty: number): number {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new PricingError(`quantity must be a positive integer, got ${qty}`);
  }
  if (tiers.length === 0) {
    throw new PricingError('variant has no price ladder');
  }

  let best: Tier | undefined;
  for (const tier of tiers) {
    if (tier.minQty > qty) continue;
    if (!best || tier.minQty > best.minQty) best = tier;
  }

  if (!best) {
    throw new PricingError(
      `no price tier applies at quantity ${qty}; lowest break is ${Math.min(
        ...tiers.map((t) => t.minQty),
      )}`,
    );
  }
  return best.unitPriceCents;
}

export function lineTotalCents(tiers: readonly Tier[], qty: number): number {
  return resolveUnitPriceCents(tiers, qty) * qty;
}

export interface PricedLine {
  variantId: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export function priceLines(
  lines: readonly { variantId: string; qty: number }[],
  laddersByVariant: ReadonlyMap<string, readonly Tier[]>,
): PricedLine[] {
  return lines.map((line) => {
    const tiers = laddersByVariant.get(line.variantId);
    if (!tiers) throw new PricingError(`unknown variant ${line.variantId}`);
    const unitPriceCents = resolveUnitPriceCents(tiers, line.qty);
    return {
      variantId: line.variantId,
      qty: line.qty,
      unitPriceCents,
      lineTotalCents: unitPriceCents * line.qty,
    };
  });
}

export function subtotalCents(lines: readonly PricedLine[]): number {
  return lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
}

/** The saving against buying the same quantity at the quantity-1 price. */
export function savingsAgainstListCents(tiers: readonly Tier[], qty: number): number {
  const list = resolveUnitPriceCents(tiers, 1);
  return list * qty - lineTotalCents(tiers, qty);
}

export const MAX_LINE_QTY = 9999;

/**
 * A requested line item. Any `price`-shaped key is refused outright rather than
 * stripped, so a caller that tried to set one gets an error instead of silently
 * having it ignored — the distinction that matters when the caller is a model.
 */
export const lineItemRequestSchema = z
  .object({
    variantId: z.string().uuid(),
    qty: z.number().int().min(1).max(MAX_LINE_QTY),
  })
  .strict();

export const lineItemsRequestSchema = z.array(lineItemRequestSchema).min(1).max(50);

export type LineItemRequest = z.infer<typeof lineItemRequestSchema>;

const PRICE_KEYS = [
  'price',
  'unitprice',
  'unitpricecents',
  'linetotal',
  'linetotalcents',
  'total',
  'totalcents',
  'subtotal',
  'subtotalcents',
  'amount',
  'amountcents',
  'discount',
  'discountcents',
  'discountpercent',
];

/**
 * True when an object carries anything that looks like a caller-supplied price.
 * Used at the trust boundary in front of `lineItemsRequestSchema`, which gives
 * a clearer refusal than a bare "unrecognized key".
 */
export function containsPriceField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPriceField);
  if (value === null || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value)) {
    if (PRICE_KEYS.includes(key.toLowerCase().replace(/[_-]/g, ''))) return true;
    if (containsPriceField(nested)) return true;
  }
  return false;
}

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
