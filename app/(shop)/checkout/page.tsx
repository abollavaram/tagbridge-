import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Money } from '@/components/money';
import { currentViewer } from '@/lib/auth/guards';
import { readCart } from '@/lib/commerce/cart-session';
import { getPaymentProvider } from '@/lib/commerce/payments';
import {
  checkoutWithCardAction,
  checkoutWithPurchaseOrderAction,
} from './actions';

export const metadata = { title: 'Checkout' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  'invalid-po': 'A purchase order number and a valid email address are both required.',
  'invalid-details': 'A valid email address is required.',
  'card-unavailable': 'Card payment is not configured on this deployment. The purchase order path works.',
  'payment-failed': 'The payment provider could not start a session. Nothing was charged.',
  'order-failed': 'That order could not be created. Nothing was charged.',
};

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [cart, params, viewer] = await Promise.all([
    readCart(),
    searchParams,
    currentViewer(),
  ]);
  if (cart.lines.length === 0) redirect('/cart');

  const cardConfigured = getPaymentProvider().configured;
  const error = params.error ? ERRORS[params.error] : undefined;

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-semibold tracking-tight">Checkout</h1>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="summary" className="space-y-3">
        <h2 id="summary" className="text-xl font-semibold">
          Order summary
        </h2>
        <ul className="divide-y divide-ink-100 text-sm dark:divide-ink-700">
          {cart.lines.map((line) => (
            <li key={line.variantId} className="flex justify-between gap-4 py-2">
              <span>
                {line.variant.productName} — {line.variant.tier}
                <span className="text-ink-500"> × {line.qty}</span>
              </span>
              <Money cents={line.lineTotalCents} />
            </li>
          ))}
        </ul>
        <p className="flex justify-between border-t-2 border-ink-300 pt-2 text-lg font-semibold">
          <span>Subtotal</span>
          <Money cents={cart.subtotalCents} />
        </p>
      </section>

      <section aria-labelledby="po" className="space-y-4 rounded-lg border border-ink-100 p-5 dark:border-ink-700">
        <h2 id="po" className="text-xl font-semibold">
          Purchase order
        </h2>
        <p className="text-sm text-ink-700 dark:text-ink-300">
          Places the order against your PO with no payment taken. Licences are issued once
          the PO is verified against your account.
        </p>
        <form action={checkoutWithPurchaseOrderAction} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="po-email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="po-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              defaultValue={viewer?.email ?? ''}
              className="mt-1 w-full rounded border border-ink-300 px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="po-company" className="block text-sm font-medium">
              Company
            </label>
            <input
              id="po-company"
              name="companyName"
              type="text"
              autoComplete="organization"
              className="mt-1 w-full rounded border border-ink-300 px-3 py-2"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="po-number" className="block text-sm font-medium">
              Purchase order number
            </label>
            <input
              id="po-number"
              name="poNumber"
              type="text"
              required
              className="mt-1 w-full rounded border border-ink-300 px-3 py-2 font-mono"
            />
          </div>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded bg-signal-600 px-4 py-2 font-medium text-white"
            >
              Place order against PO
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="card" className="space-y-4 rounded-lg border border-ink-100 p-5 dark:border-ink-700">
        <h2 id="card" className="text-xl font-semibold">
          Pay by card
        </h2>
        {cardConfigured ? (
          <>
            <p className="text-sm text-ink-700 dark:text-ink-300">
              Card payment runs through Stripe in test mode. You will be redirected to
              Stripe and returned here.
            </p>
            <form action={checkoutWithCardAction} className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="card-email" className="block text-sm font-medium">
                  Email
                </label>
                <input
                  id="card-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  defaultValue={viewer?.email ?? ''}
                  className="mt-1 w-full rounded border border-ink-300 px-3 py-2"
                />
              </div>
              <div>
                <label htmlFor="card-company" className="block text-sm font-medium">
                  Company
                </label>
                <input
                  id="card-company"
                  name="companyName"
                  type="text"
                  autoComplete="organization"
                  className="mt-1 w-full rounded border border-ink-300 px-3 py-2"
                />
              </div>
              <div className="sm:col-span-2">
                <button
                  type="submit"
                  className="rounded border border-ink-300 px-4 py-2 font-medium"
                >
                  Continue to payment
                </button>
              </div>
            </form>
          </>
        ) : (
          <p className="text-sm text-ink-500">
            Card payment is not configured on this deployment — no{' '}
            <code className="font-mono">STRIPE_SECRET_KEY</code> is set. The purchase order
            path above is unaffected.
          </p>
        )}
      </section>

      <p className="text-sm">
        <Link href="/cart" className="underline">
          Back to cart
        </Link>
      </p>
    </div>
  );
}
