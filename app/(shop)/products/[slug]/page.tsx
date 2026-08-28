import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BillingNote, Money } from '@/components/money';
import { addToCartAction } from '@/app/(shop)/actions';
import { allProductSlugs, getProductBySlug } from '@/lib/commerce/catalog';
import { resolveUnitPriceCents } from '@/lib/commerce/pricing';

/**
 * Statically rendered from `generateStaticParams`, revalidated hourly.
 *
 * Not just for speed: a dynamically rendered page with async `generateMetadata`
 * has its metadata streamed into the body and relocated by hydration, so the
 * description never reaches `<head>` for anything that does not run JavaScript.
 */
export const revalidate = 3600;
export const dynamicParams = true;

export async function generateStaticParams() {
  return (await allProductSlugs()).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const product = await getProductBySlug((await params).slug);
  if (!product) return { title: 'Product not found' };
  return {
    title: product.name,
    description: product.description.slice(0, 155),
    alternates: { canonical: `/products/${product.slug}` },
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const product = await getProductBySlug((await params).slug);
  if (!product) notFound();

  return (
    <div className="space-y-10">
      <nav aria-label="Breadcrumb" className="text-sm text-ink-500">
        <Link href="/products" className="hover:underline">
          Catalog
        </Link>
        <span aria-hidden="true"> / </span>
        <Link
          href={`/products?category=${encodeURIComponent(product.category)}`}
          className="hover:underline"
        >
          {product.category}
        </Link>
      </nav>

      <header className="space-y-3">
        <p className="font-mono text-sm text-ink-500">{product.sku}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">{product.name}</h1>
        <p className="max-w-3xl text-lg text-ink-700 dark:text-ink-300">
          {product.description}
        </p>
      </header>

      <section aria-labelledby="compat" className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <h2 id="compat" className="text-xs font-semibold uppercase tracking-widest text-ink-500">
            Protocols
          </h2>
          <ul className="flex flex-wrap gap-1.5 text-sm">
            {product.protocols.map((p) => (
              <li key={p} className="rounded border border-ink-100 px-2 py-0.5 dark:border-ink-700">
                <Link href={`/products?protocol=${encodeURIComponent(p)}`} className="hover:underline">
                  {p}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-500">
            Tested against
          </h2>
          <ul className="flex flex-wrap gap-1.5 text-sm">
            {product.vendorCompat.map((v) => (
              <li key={v} className="rounded border border-ink-100 px-2 py-0.5 dark:border-ink-700">
                <Link href={`/products?vendor=${encodeURIComponent(v)}`} className="hover:underline">
                  {v}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="variants" className="space-y-4">
        <h2 id="variants" className="text-xl font-semibold">
          Licences
        </h2>
        <p className="text-sm text-ink-500">
          Prices are per licence and fall at the quantity breaks shown. Every price on this
          page is computed on the server from the published ladder.
        </p>

        <ul className="space-y-4">
          {product.variants.map((variant) => (
            <li
              key={variant.id}
              className="rounded-lg border border-ink-100 p-4 dark:border-ink-700"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="text-lg font-medium">{variant.tier}</h3>
                  <p className="font-mono text-xs text-ink-500">{variant.sku}</p>
                </div>
                <p className="text-xl">
                  <Money cents={variant.listPriceCents} />
                  <BillingNote interval={variant.billingInterval} />
                </p>
              </div>

              {variant.tiers.length > 1 ? (
                <table className="mt-4 w-full text-sm">
                  <caption className="sr-only">
                    Quantity breaks for {product.name}, {variant.tier}
                  </caption>
                  <thead>
                    <tr className="text-left text-ink-500">
                      <th scope="col" className="pb-1 font-medium">
                        Quantity
                      </th>
                      <th scope="col" className="pb-1 font-medium">
                        Unit price
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {variant.tiers.map((tier, i) => {
                      const next = variant.tiers[i + 1];
                      const label = next
                        ? `${tier.minQty}–${next.minQty - 1}`
                        : `${tier.minQty}+`;
                      return (
                        <tr key={tier.minQty} className="border-t border-ink-100 dark:border-ink-700">
                          <td className="py-1 tabular-nums">{label}</td>
                          <td className="py-1">
                            <Money cents={tier.unitPriceCents} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}

              <form action={addToCartAction} className="mt-4 flex flex-wrap items-end gap-3">
                <input type="hidden" name="variantId" value={variant.id} />
                <div>
                  <label
                    htmlFor={`qty-${variant.id}`}
                    className="block text-sm font-medium"
                  >
                    Quantity
                  </label>
                  <input
                    id={`qty-${variant.id}`}
                    name="qty"
                    type="number"
                    min={1}
                    max={9999}
                    defaultValue={1}
                    className="mt-1 w-24 rounded border border-ink-300 px-3 py-2"
                  />
                </div>
                <button
                  type="submit"
                  className="rounded bg-signal-600 px-4 py-2 font-medium text-white"
                >
                  Add to cart
                </button>
                <p className="text-sm text-ink-500">
                  At 10: <Money cents={resolveUnitPriceCents(variant.tiers, 10)} /> each
                </p>
              </form>
            </li>
          ))}
        </ul>
      </section>

      {Object.keys(product.specs).length > 0 ? (
        <section aria-labelledby="specs" className="space-y-3">
          <h2 id="specs" className="text-xl font-semibold">
            Specifications
          </h2>
          <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
            {Object.entries(product.specs).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4 border-b border-ink-100 py-1 dark:border-ink-700">
                <dt className="text-ink-500">{humanise(key)}</dt>
                <dd className="text-right">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
