import { NextResponse } from 'next/server';
import { emptyCurrentCart } from '@/lib/commerce/cart-session';
import { siteOrigin } from '@/lib/ucp/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where Stripe sends the buyer back to.
 *
 * This exists to hold one side effect that has nowhere else to live. The cart
 * used to be emptied *before* the redirect to Stripe, so abandoning the
 * payment page, hitting back, or having a card decline all left the buyer with
 * an empty cart and an unpayable `pending_payment` order. It cannot move to
 * the webhook either — the cart is a cookie in this browser, and the webhook
 * is a server-to-server call with no browser attached.
 *
 * A route handler can set cookies where a rendered page cannot, so the buyer
 * returns here, the cart is cleared, and they continue to the confirmation.
 * Payment itself is confirmed by the webhook, not by this redirect: anyone can
 * type this URL, and nothing here marks anything paid.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const number = url.searchParams.get('number');
  const token = url.searchParams.get('t');

  if (!number || !token) {
    return NextResponse.redirect(new URL('/cart', siteOrigin(request.url)));
  }

  await emptyCurrentCart();

  const destination = new URL(
    `/checkout/confirmation/${encodeURIComponent(number)}`,
    siteOrigin(request.url),
  );
  destination.searchParams.set('t', token);
  return NextResponse.redirect(destination);
}
