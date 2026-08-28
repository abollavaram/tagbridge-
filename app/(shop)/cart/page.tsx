import Link from 'next/link';
import { BillingNote, Money } from '@/components/money';
import { removeFromCartAction, setQtyAction } from '@/app/(shop)/actions';
import { readCart } from '@/lib/commerce/cart-session';

export const metadata = { title: 'Cart' };
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  'invalid-selection': 'That selection was not valid, so nothing was added.',
  'invalid-quantity': 'That quantity was not valid, so nothing changed.',
  'invalid-item': 'That item was not valid, so nothing changed.',
};

export default async function CartPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [cart, params] = await Promise.all([readCart(), searchParams]);
  const error = params.error ? ERRORS[params.error] : undefined;

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-semibold tracking-tight">Cart</h1>

      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </p>
      ) : null}

      {cart.lines.length === 0 ? (
        <p>
          Your cart is empty.{' '}
          <Link href="/products" className="underline">
            Browse the catalog
          </Link>
          .
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <caption className="sr-only">Items in your cart</caption>
            <thead>
              <tr className="text-left text-ink-500">
                <th scope="col" className="pb-2 font-medium">Item</th>
                <th scope="col" className="pb-2 font-medium">Quantity</th>
                <th scope="col" className="pb-2 font-medium">Unit price</th>
                <th scope="col" className="pb-2 text-right font-medium">Line total</th>
                <th scope="col" className="pb-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {cart.lines.map((line) => (
                <tr key={line.variantId} className="border-t border-ink-100 align-top dark:border-ink-700">
                  <td className="py-3">
                    <Link href={`/products/${line.variant.productSlug}`} className="font-medium hover:underline">
                      {line.variant.productName}
                    </Link>
                    <p className="text-ink-500">{line.variant.tier}</p>
                    <p className="font-mono text-xs text-ink-500">{line.variant.sku}</p>
                  </td>
                  <td className="py-3">
                    <form action={setQtyAction} className="flex items-center gap-2">
                      <input type="hidden" name="variantId" value={line.variantId} />
                      <label htmlFor={`qty-${line.variantId}`} className="sr-only">
                        Quantity for {line.variant.productName}
                      </label>
                      <input
                        id={`qty-${line.variantId}`}
                        name="qty"
                        type="number"
                        min={0}
                        max={9999}
                        defaultValue={line.qty}
                        className="w-20 rounded border border-ink-300 px-2 py-1"
                      />
                      <button type="submit" className="rounded border border-ink-300 px-2 py-1">
                        Update
                      </button>
                    </form>
                  </td>
                  <td className="py-3">
                    <Money cents={line.unitPriceCents} />
                    <BillingNote interval={line.variant.billingInterval} />
                  </td>
                  <td className="py-3 text-right">
                    <Money cents={line.lineTotalCents} />
                  </td>
                  <td className="py-3 text-right">
                    <form action={removeFromCartAction}>
                      <input type="hidden" name="variantId" value={line.variantId} />
                      <button type="submit" className="text-ink-500 underline">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink-300">
                <th scope="row" colSpan={3} className="py-3 text-right font-medium">
                  Subtotal
                </th>
                <td className="py-3 text-right text-lg font-semibold">
                  <Money cents={cart.subtotalCents} />
                </td>
                <td />
              </tr>
            </tfoot>
          </table>

          <p className="text-sm text-ink-500">
            Tax and any applicable licence transfer fees are calculated at checkout.
            Subscription lines bill on their own interval.
          </p>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/checkout"
              className="rounded bg-signal-600 px-4 py-2 font-medium text-white"
            >
              Checkout
            </Link>
            <Link href="/products" className="rounded border border-ink-300 px-4 py-2">
              Keep browsing
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
