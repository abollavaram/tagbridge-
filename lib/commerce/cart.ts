import { and, eq, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { cartItems, carts } from '@/lib/db/schema';
import {
  laddersForVariants,
  variantSummaries,
  type VariantSummary,
} from './catalog';
import { MAX_LINE_QTY, priceLines, subtotalCents, type PricedLine } from './pricing';

/**
 * Cart data operations, addressed by cart id.
 *
 * Deliberately free of request context — no cookies, no session — so that the
 * whole of the cart's behaviour can be exercised directly. Working out which
 * cart a request owns is `cart-session.ts`.
 */

export interface CartLine extends PricedLine {
  variant: VariantSummary;
}

export interface Cart {
  id: string | null;
  lines: CartLine[];
  subtotalCents: number;
  itemCount: number;
}

export const EMPTY_CART: Cart = { id: null, lines: [], subtotalCents: 0, itemCount: 0 };

export async function createCart(
  owner: { userId: string } | { anonymousId: string },
): Promise<string> {
  const db = await getDatabase();
  const values = 'userId' in owner ? { userId: owner.userId } : { anonymousId: owner.anonymousId };
  const inserted = await db.insert(carts).values(values).returning();
  const row = inserted[0];
  if (!row) throw new Error('could not create cart');
  return row.id;
}

export async function findCartIdForUser(userId: string): Promise<string | null> {
  const db = await getDatabase();
  const rows = await db.select().from(carts).where(eq(carts.userId, userId)).limit(1);
  return rows[0]?.id ?? null;
}

export async function findCartIdForAnonymous(anonymousId: string): Promise<string | null> {
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(carts)
    .where(eq(carts.anonymousId, anonymousId))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function readCartById(cartId: string): Promise<Cart> {
  const db = await getDatabase();
  const rows = await db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
  if (rows.length === 0) return { id: cartId, lines: [], subtotalCents: 0, itemCount: 0 };

  const variantIds = rows.map((r) => r.variantId);
  const [ladders, summaries] = await Promise.all([
    laddersForVariants(variantIds),
    variantSummaries(variantIds),
  ]);

  // Prices are resolved on read, from the ladder in the database. The cart
  // stores quantities only, so there is nowhere for a stale price to hide.
  const priced = priceLines(
    rows.map((r) => ({ variantId: r.variantId, qty: r.qty })),
    ladders,
  );

  const lines: CartLine[] = priced.flatMap((line) => {
    const variant = summaries.get(line.variantId);
    return variant ? [{ ...line, variant }] : [];
  });

  return {
    id: cartId,
    lines,
    subtotalCents: subtotalCents(lines),
    itemCount: lines.reduce((n, l) => n + l.qty, 0),
  };
}

export async function addItem(cartId: string, variantId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
    throw new Error('invalid quantity');
  }
  const db = await getDatabase();
  await db
    .insert(cartItems)
    .values({ cartId, variantId, qty })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.variantId],
      set: { qty: sql`least(${cartItems.qty} + ${qty}, ${MAX_LINE_QTY})` },
    });
  await touchCart(cartId);
}

export async function setItemQty(
  cartId: string,
  variantId: string,
  qty: number,
): Promise<void> {
  if (qty <= 0) return removeItem(cartId, variantId);
  if (!Number.isInteger(qty) || qty > MAX_LINE_QTY) throw new Error('invalid quantity');
  const db = await getDatabase();
  await db
    .update(cartItems)
    .set({ qty })
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)));
  await touchCart(cartId);
}

export async function removeItem(cartId: string, variantId: string): Promise<void> {
  const db = await getDatabase();
  await db
    .delete(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)));
  await touchCart(cartId);
}

export async function clearCart(cartId: string): Promise<void> {
  const db = await getDatabase();
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
  await touchCart(cartId);
}

async function touchCart(cartId: string): Promise<void> {
  const db = await getDatabase();
  await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
}
