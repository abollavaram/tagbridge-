import type { CartLineInput } from './cart-cookie';
import {
  laddersForVariants,
  variantSummaries,
  type VariantSummary,
} from './catalog';
import { priceLines, subtotalCents, type PricedLine } from './pricing';

/**
 * Pricing a cart.
 *
 * The cart itself is just a list of variant ids and quantities — it carries no
 * prices at all. Everything monetary is computed here, on read, from the
 * ladder in `price_tiers`. That is why a cart cannot hold a stale price, and
 * why the storage medium (cookie today, a shared database when one is
 * configured) does not affect what anything costs.
 */

export interface CartLine extends PricedLine {
  variant: VariantSummary;
}

export interface Cart {
  lines: CartLine[];
  subtotalCents: number;
  itemCount: number;
}

export const EMPTY_CART: Cart = { lines: [], subtotalCents: 0, itemCount: 0 };

export async function priceCartLines(
  input: readonly CartLineInput[],
): Promise<Cart> {
  if (input.length === 0) return EMPTY_CART;

  const variantIds = input.map((l) => l.variantId);
  const [ladders, summaries] = await Promise.all([
    laddersForVariants(variantIds),
    variantSummaries(variantIds),
  ]);

  // A variant that has since been withdrawn from the catalogue is dropped
  // rather than priced: the buyer sees it disappear, which is recoverable,
  // instead of an error, which is not.
  const known = input.filter((l) => ladders.has(l.variantId) && summaries.has(l.variantId));
  if (known.length === 0) return EMPTY_CART;

  const priced = priceLines(known, ladders);

  const lines: CartLine[] = priced.flatMap((line) => {
    const variant = summaries.get(line.variantId);
    return variant ? [{ ...line, variant }] : [];
  });

  return {
    lines,
    subtotalCents: subtotalCents(lines),
    itemCount: lines.reduce((n, l) => n + l.qty, 0),
  };
}
