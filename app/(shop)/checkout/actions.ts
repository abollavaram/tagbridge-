'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { currentViewer } from '@/lib/auth/guards';
import { emptyCurrentCart, readCart, readCartLines } from '@/lib/commerce/cart-session';
import { getPaymentProvider, PaymentNotConfiguredError } from '@/lib/commerce/payments';
import { OrderError, placeOrder } from '@/lib/commerce/orders';
import { logger } from '@/lib/telemetry/logger';

const baseSchema = z.object({
  email: z.string().email(),
  companyName: z.string().trim().max(200).optional(),
});

const poSchema = baseSchema.extend({
  poNumber: z.string().trim().min(1).max(64),
});

function origin(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
}

/**
 * Purchase-order checkout: creates an order with no payment taken.
 *
 * This is the path industrial buyers actually use. The order is real, the
 * prices are server-computed, and nothing touches a payment provider.
 */
/**
 * Where a buyer is sent after ordering.
 *
 * The token rides in the query string rather than the path so the readable
 * order number stays the thing people quote to each other, and so a shared
 * screenshot of the number alone leaks nothing.
 */
function confirmationPath(number: string, accessToken: string): string {
  return `/checkout/confirmation/${number}?t=${encodeURIComponent(accessToken)}`;
}

export async function checkoutWithPurchaseOrderAction(formData: FormData): Promise<void> {
  const parsed = poSchema.safeParse({
    email: formData.get('email'),
    companyName: formData.get('companyName') || undefined,
    poNumber: formData.get('poNumber'),
  });
  if (!parsed.success) redirect('/checkout?error=invalid-po');

  const lines = await readCartLines();
  if (lines.length === 0) redirect('/cart');

  const viewer = await currentViewer();
  let confirmation: string;
  try {
    const order = await placeOrder({
      lines,
      email: parsed.data.email,
      companyName: parsed.data.companyName,
      userId: viewer?.id,
      paymentMethod: 'purchase_order',
      poNumber: parsed.data.poNumber,
    });
    // The token, not the number, is what authorises reading this back — a
    // guest has no session to be recognised by.
    confirmation = confirmationPath(order.number, order.accessToken);
  } catch (error) {
    if (error instanceof OrderError) redirect('/checkout?error=order-failed');
    throw error;
  }

  // Safe here and only here: the PO order is already complete, so there is
  // nothing left for the buyer to come back to the cart for.
  await emptyCurrentCart();
  redirect(confirmation);
}

/**
 * Card checkout: creates the order first, then hands Stripe a line list built
 * from the order's own server-computed prices.
 */
export async function checkoutWithCardAction(formData: FormData): Promise<void> {
  const parsed = baseSchema.safeParse({
    email: formData.get('email'),
    companyName: formData.get('companyName') || undefined,
  });
  if (!parsed.success) redirect('/checkout?error=invalid-details');

  const provider = getPaymentProvider();
  if (!provider.configured) redirect('/checkout?error=card-unavailable');

  const cart = await readCart();
  const lines = await readCartLines();
  if (lines.length === 0) redirect('/cart');

  const viewer = await currentViewer();
  const order = await placeOrder({
    lines,
    email: parsed.data.email,
    companyName: parsed.data.companyName,
    userId: viewer?.id,
    paymentMethod: 'card',
  });

  let url: string;
  try {
    const session = await provider.createCheckoutSession({
      orderId: order.id,
      orderNumber: order.number,
      email: parsed.data.email,
      lines: cart.lines.map((line) => ({
        name: `${line.variant.productName} — ${line.variant.tier}`,
        sku: line.variant.sku,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
      })),
      // Via /checkout/complete, which clears the cart on the way through —
      // the one place that can, and the earliest point at which it is right to.
      successUrl:
        `${origin()}/checkout/complete` +
        `?number=${encodeURIComponent(order.number)}` +
        `&t=${encodeURIComponent(order.accessToken)}`,
      cancelUrl: `${origin()}/cart`,
    });
    url = session.url;
  } catch (error) {
    if (error instanceof PaymentNotConfiguredError) {
      redirect('/checkout?error=card-unavailable');
    }
    logger.error({ err: String(error), orderNumber: order.number }, 'checkout session failed');
    redirect('/checkout?error=payment-failed');
  }

  // Deliberately NOT emptying the cart here. The buyer has not paid yet, and
  // clearing it before the redirect means abandoning the payment page, hitting
  // back, or having a card decline all land them on an empty cart with an
  // unpayable pending_payment order. The cart is cleared when the payment is
  // confirmed, in the Stripe webhook.
  redirect(url);
}
