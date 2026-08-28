import { cookies } from 'next/headers';
import {
  addLine,
  CART_COOKIE,
  CART_COOKIE_MAX_AGE,
  decodeCart,
  encodeCart,
  removeLine,
  setLineQty,
  type CartLineInput,
} from './cart-cookie';
import { priceCartLines, type Cart, EMPTY_CART } from './cart';

/**
 * The cart for the current request.
 *
 * Contents come from the cookie rather than from server memory, because a
 * deployment without a shared database restores its snapshot into each
 * instance separately — a cart written on one instance simply does not exist
 * on the next. Prices are still resolved from the database on every read.
 */

export async function readCartLines(): Promise<CartLineInput[]> {
  return decodeCart((await cookies()).get(CART_COOKIE)?.value);
}

export async function readCart(): Promise<Cart> {
  const lines = await readCartLines();
  if (lines.length === 0) return EMPTY_CART;
  return priceCartLines(lines);
}

/** Only callable from a server action or route handler. */
async function writeCartLines(lines: readonly CartLineInput[]): Promise<void> {
  const jar = await cookies();
  if (lines.length === 0) {
    jar.delete(CART_COOKIE);
    return;
  }
  jar.set(CART_COOKIE, encodeCart(lines), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CART_COOKIE_MAX_AGE,
  });
}

export async function addToCart(variantId: string, qty: number): Promise<void> {
  await writeCartLines(addLine(await readCartLines(), variantId, qty));
}

export async function setCartQty(variantId: string, qty: number): Promise<void> {
  await writeCartLines(setLineQty(await readCartLines(), variantId, qty));
}

export async function removeFromCart(variantId: string): Promise<void> {
  await writeCartLines(removeLine(await readCartLines(), variantId));
}

export async function emptyCurrentCart(): Promise<void> {
  await writeCartLines([]);
}
