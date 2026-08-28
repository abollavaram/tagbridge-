import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money } from '@/components/money';
import { getOrderByNumber } from '@/lib/commerce/orders';

export const metadata = { title: 'Order confirmed', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUS_COPY: Record<string, string> = {
  po_received:
    'Your purchase order is recorded. Nothing has been charged. Licences are issued once the PO is verified against your account.',
  pending_payment: 'This order is waiting on payment. Nothing has been charged yet.',
  paid: 'Payment received. Licence keys follow by email.',
  fulfilled: 'This order has been fulfilled.',
  cancelled: 'This order was cancelled.',
};

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const found = await getOrderByNumber((await params).number);
  if (!found) notFound();
  const { order, items } = found;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Order confirmed</h1>
        <p className="font-mono text-lg">{order.number}</p>
        <p className="text-ink-700 dark:text-ink-300">
          {STATUS_COPY[order.status] ?? 'This order has been recorded.'}
        </p>
      </header>

      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
          <dt className="text-sm text-ink-500">Status</dt>
          <dd className="mt-1 font-mono">{order.status}</dd>
        </div>
        <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
          <dt className="text-sm text-ink-500">Payment method</dt>
          <dd className="mt-1 font-mono">{order.paymentMethod}</dd>
        </div>
        {order.poNumber ? (
          <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
            <dt className="text-sm text-ink-500">PO number</dt>
            <dd className="mt-1 font-mono">{order.poNumber}</dd>
          </div>
        ) : null}
      </dl>

      <table className="w-full text-sm">
        <caption className="sr-only">Ordered items</caption>
        <thead>
          <tr className="text-left text-ink-500">
            <th scope="col" className="pb-2 font-medium">Item</th>
            <th scope="col" className="pb-2 font-medium">Qty</th>
            <th scope="col" className="pb-2 font-medium">Unit</th>
            <th scope="col" className="pb-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-ink-100 dark:border-ink-700">
              <td className="py-2">
                {item.productNameSnapshot}
                <span className="block font-mono text-xs text-ink-500">
                  {item.variantSkuSnapshot}
                </span>
              </td>
              <td className="py-2 tabular-nums">{item.qty}</td>
              <td className="py-2"><Money cents={item.unitPriceCents} /></td>
              <td className="py-2 text-right"><Money cents={item.lineTotalCents} /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-ink-300">
            <th scope="row" colSpan={3} className="py-2 text-right font-medium">
              Subtotal
            </th>
            <td className="py-2 text-right text-lg font-semibold">
              <Money cents={order.subtotalCents} />
            </td>
          </tr>
        </tfoot>
      </table>

      <p className="text-sm">
        <Link href="/products" className="underline">
          Back to the catalog
        </Link>
      </p>
    </div>
  );
}
