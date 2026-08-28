'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { addToCart, removeFromCart, setCartQty } from '@/lib/commerce/cart-session';
import { MAX_LINE_QTY } from '@/lib/commerce/pricing';

/**
 * Cart mutations.
 *
 * Each validates its input against a schema with no price field, and every
 * price is re-resolved from the database on the next read. A client chooses
 * what and how many; it never chooses what that costs.
 *
 * These are plain form actions returning nothing, so the pages work with
 * JavaScript disabled — which is also why they are cheap on the metrics the
 * phase-1 criteria are measured against.
 */

const addSchema = z.object({
  variantId: z.string().uuid(),
  qty: z.coerce.number().int().min(1).max(MAX_LINE_QTY),
});

const qtySchema = z.object({
  variantId: z.string().uuid(),
  qty: z.coerce.number().int().min(0).max(MAX_LINE_QTY),
});

const removeSchema = z.object({ variantId: z.string().uuid() });

export async function addToCartAction(formData: FormData): Promise<void> {
  const parsed = addSchema.safeParse({
    variantId: formData.get('variantId'),
    qty: formData.get('qty'),
  });
  if (!parsed.success) redirect('/cart?error=invalid-selection');

  await addToCart(parsed.data.variantId, parsed.data.qty);
  revalidatePath('/cart');
  redirect('/cart');
}

export async function setQtyAction(formData: FormData): Promise<void> {
  const parsed = qtySchema.safeParse({
    variantId: formData.get('variantId'),
    qty: formData.get('qty'),
  });
  if (!parsed.success) redirect('/cart?error=invalid-quantity');

  await setCartQty(parsed.data.variantId, parsed.data.qty);
  revalidatePath('/cart');
  redirect('/cart');
}

export async function removeFromCartAction(formData: FormData): Promise<void> {
  const parsed = removeSchema.safeParse({ variantId: formData.get('variantId') });
  if (!parsed.success) redirect('/cart?error=invalid-item');

  await removeFromCart(parsed.data.variantId);
  revalidatePath('/cart');
  redirect('/cart');
}
