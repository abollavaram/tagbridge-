import Link from 'next/link';
import { signOut } from '@/lib/auth';
import { requireViewer } from '@/lib/auth/guards';
import { formatCents } from '@/lib/commerce/pricing';
import { ordersForUser, quoteStatusCopy, quotesForUser } from '@/lib/commerce/account';

export const metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

function when(value: Date | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : '—';
}

export default async function AccountPage() {
  // Re-checked here, not only in middleware.
  const viewer = await requireViewer('/account');

  // Both queries filter on this viewer's id in SQL, so there is no list to
  // forget to filter later.
  const [quotes, orders] = await Promise.all([
    quotesForUser(viewer.id),
    ordersForUser(viewer.id),
  ]);

  return (
    <div className="space-y-10">
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Account</h1>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
            <dt className="text-sm text-ink-500">Signed in as</dt>
            <dd className="mt-1 font-mono">{viewer.email}</dd>
          </div>
          <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
            <dt className="text-sm text-ink-500">Role</dt>
            <dd className="mt-1 font-mono">{viewer.role}</dd>
          </div>
        </dl>
      </div>

      <section aria-labelledby="quotes" className="space-y-3">
        <h2 id="quotes" className="text-xl font-semibold">
          Your quotes
        </h2>

        {quotes.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="no-quotes">
            No quotes yet. Describe what you are connecting on the{' '}
            <Link href="/search" className="underline">
              search page
            </Link>{' '}
            and the assistant can draft one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Your quotes">
              <thead className="border-b border-ink-200 text-left dark:border-ink-700">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Quote</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Lines</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Subtotal</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((quote) => (
                  <tr key={quote.id} className="border-b border-ink-100 dark:border-ink-800">
                    <td className="py-2 pr-4 font-mono text-xs">{quote.number}</td>
                    <td className="py-2 pr-4 tabular-nums">{quote.lines}</td>
                    <td className="py-2 pr-4 tabular-nums font-medium">
                      {formatCents(quote.subtotalCents)}
                    </td>
                    <td className="py-2 pr-4">{quoteStatusCopy(quote.status)}</td>
                    <td className="py-2 tabular-nums text-xs">{when(quote.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="orders" className="space-y-3">
        <h2 id="orders" className="text-xl font-semibold">
          Your orders
        </h2>

        {orders.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="no-orders">
            No orders yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Your orders">
              <thead className="border-b border-ink-200 text-left dark:border-ink-700">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Order</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Lines</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Subtotal</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Paid by</th>
                  <th scope="col" className="py-2 font-medium">Placed</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-ink-100 dark:border-ink-800">
                    <td className="py-2 pr-4 font-mono text-xs">
                      <Link href={`/checkout/confirmation/${order.number}`} className="underline">
                        {order.number}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{order.lines}</td>
                    <td className="py-2 pr-4 tabular-nums font-medium">
                      {formatCents(order.subtotalCents)}
                    </td>
                    <td className="py-2 pr-4">
                      {order.paymentMethod === 'purchase_order'
                        ? `Purchase order${order.poNumber ? ` ${order.poNumber}` : ''}`
                        : 'Card'}
                    </td>
                    <td className="py-2 tabular-nums text-xs">{when(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/' });
        }}
      >
        <button type="submit" className="rounded border border-ink-300 px-4 py-2 text-sm">
          Sign out
        </button>
      </form>
    </div>
  );
}
