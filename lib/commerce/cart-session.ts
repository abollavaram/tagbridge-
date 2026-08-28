import { cookies } from 'next/headers';
import { currentViewer } from '@/lib/auth/guards';
import {
  addItem,
  clearCart,
  createCart,
  EMPTY_CART,
  findCartIdForAnonymous,
  findCartIdForUser,
  readCartById,
  removeItem,
  setItemQty,
  type Cart,
} from './cart';

/**
 * Works out which cart the current request owns.
 *
 * Signed in: the cart belongs to the user. Anonymous: it belongs to an opaque
 * id in an httpOnly cookie.
 */

const CART_COOKIE = 'tb_cart';
const CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** Never creates a cart: rendering a page must not leave a row behind. */
export async function currentCartId(): Promise<string | null> {
  const viewer = await currentViewer();
  if (viewer) {
    const owned = await findCartIdForUser(viewer.id);
    if (owned) return owned;
  }
  const anonymousId = (await cookies()).get(CART_COOKIE)?.value;
  if (!anonymousId) return null;
  return findCartIdForAnonymous(anonymousId);
}

/** Called only from server actions, which are permitted to set cookies. */
async function ensureCartId(): Promise<string> {
  const existing = await currentCartId();
  if (existing) return existing;

  const viewer = await currentViewer();
  if (viewer) return createCart({ userId: viewer.id });

  const jar = await cookies();
  const anonymousId = jar.get(CART_COOKIE)?.value ?? globalThis.crypto.randomUUID();
  jar.set(CART_COOKIE, anonymousId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CART_COOKIE_MAX_AGE,
  });
  return createCart({ anonymousId });
}

export async function readCart(): Promise<Cart> {
  const cartId = await currentCartId();
  if (!cartId) return EMPTY_CART;
  return readCartById(cartId);
}

export async function addToCart(variantId: string, qty: number): Promise<void> {
  await addItem(await ensureCartId(), variantId, qty);
}

export async function setCartQty(variantId: string, qty: number): Promise<void> {
  const cartId = await currentCartId();
  if (!cartId) return;
  await setItemQty(cartId, variantId, qty);
}

export async function removeFromCart(variantId: string): Promise<void> {
  const cartId = await currentCartId();
  if (!cartId) return;
  await removeItem(cartId, variantId);
}

export async function emptyCurrentCart(): Promise<void> {
  const cartId = await currentCartId();
  if (cartId) await clearCart(cartId);
}
