import Link from 'next/link';
import { Money } from '@/components/money';
import { catalogFacets, listProducts, PAGE_SIZE } from '@/lib/commerce/catalog';

export const metadata = {
  title: 'Catalog',
  description:
    'OPC servers, protocol gateways, historian connectors, MQTT and Sparkplug bridges, HMI middleware and redundancy modules.',
};
export const dynamic = 'force-dynamic';

interface SearchParams {
  category?: string;
  protocol?: string;
  vendor?: string;
  license?: string;
  page?: string;
}

function hrefWith(current: SearchParams, key: keyof SearchParams, value?: string): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    if (v && k !== 'page') params.set(k, v);
  }
  if (value === undefined) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return query ? `/products?${query}` : '/products';
}

function FacetGroup({
  title,
  paramKey,
  values,
  current,
  limit = 8,
}: {
  title: string;
  paramKey: keyof SearchParams;
  values: { value: string; count: number }[];
  current: SearchParams;
  limit?: number;
}) {
  const selected = current[paramKey];
  return (
    <section aria-labelledby={`facet-${paramKey}`} className="space-y-2">
      <h3
        id={`facet-${paramKey}`}
        className="text-xs font-semibold uppercase tracking-widest text-ink-500"
      >
        {title}
      </h3>
      <ul className="space-y-1 text-sm">
        {selected ? (
          <li>
            <Link href={hrefWith(current, paramKey, undefined)} className="underline">
              Clear {title.toLowerCase()}
            </Link>
          </li>
        ) : null}
        {values.slice(0, limit).map((v) => (
          <li key={v.value}>
            <Link
              href={hrefWith(current, paramKey, v.value)}
              aria-current={selected === v.value ? 'true' : undefined}
              className={
                selected === v.value ? 'font-semibold underline' : 'hover:underline'
              }
            >
              {v.value}{' '}
              <span className="text-ink-500 tabular-nums">({v.count})</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const license =
    params.license === 'perpetual' || params.license === 'subscription'
      ? params.license
      : undefined;

  const [page, facets] = await Promise.all([
    listProducts({
      category: params.category,
      protocol: params.protocol,
      vendor: params.vendor,
      licenseType: license,
      page: Number(params.page ?? '1') || 1,
    }),
    catalogFacets(),
  ]);

  const activeFilters = [params.category, params.protocol, params.vendor, params.license]
    .filter(Boolean)
    .length;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Catalog</h1>
        <p className="text-ink-700 dark:text-ink-300">
          {page.total} product{page.total === 1 ? '' : 's'}
          {activeFilters > 0 ? ' matching your filters' : ''}. Search that understands how
          engineers describe a problem arrives in phase 2; for now, browse by protocol,
          vendor or category.
        </p>
      </header>

      <div className="grid gap-10 md:grid-cols-[14rem_1fr]">
        <aside aria-labelledby="filters-heading" className="space-y-6">
          <h2 id="filters-heading" className="sr-only">
            Filters
          </h2>
          {activeFilters > 0 ? (
            <Link href="/products" className="text-sm underline">
              Clear all filters
            </Link>
          ) : null}
          <FacetGroup
            title="Category"
            paramKey="category"
            values={facets.categories}
            current={params}
          />
          <FacetGroup
            title="Protocol"
            paramKey="protocol"
            values={facets.protocols}
            current={params}
            limit={12}
          />
          <FacetGroup
            title="Vendor"
            paramKey="vendor"
            values={facets.vendors}
            current={params}
            limit={10}
          />
          <FacetGroup
            title="Licence"
            paramKey="license"
            values={facets.licenseTypes}
            current={params}
          />
        </aside>

        <div className="space-y-6">
          {page.items.length === 0 ? (
            <p className="rounded-lg border border-ink-100 p-6 dark:border-ink-700">
              Nothing matches that combination.{' '}
              <Link href="/products" className="underline">
                Clear the filters
              </Link>
              .
            </p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {page.items.map((product) => (
                <li
                  key={product.id}
                  className="rounded-lg border border-ink-100 p-4 dark:border-ink-700"
                >
                  <article className="flex h-full flex-col gap-2">
                    <p className="font-mono text-xs text-ink-500">{product.sku}</p>
                    <h2 className="text-lg font-semibold leading-snug">
                      <Link href={`/products/${product.slug}`} className="hover:underline">
                        {product.name}
                      </Link>
                    </h2>
                    <p className="line-clamp-3 text-sm text-ink-700 dark:text-ink-300">
                      {product.description}
                    </p>
                    <ul className="flex flex-wrap gap-1 text-xs text-ink-500">
                      {product.protocols.slice(0, 4).map((p) => (
                        <li key={p} className="rounded border border-ink-100 px-1.5 py-0.5 dark:border-ink-700">
                          {p}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-auto pt-2 text-sm">
                      From <Money cents={product.fromPriceCents} />
                      <span className="text-ink-500">
                        {product.licenseType === 'subscription' ? ' · subscription' : ' · perpetual'}
                      </span>
                    </p>
                  </article>
                </li>
              ))}
            </ul>
          )}

          {page.pageCount > 1 ? (
            <nav aria-label="Pagination" className="flex items-center gap-4 text-sm">
              {page.page > 1 ? (
                <Link
                  href={`${hrefWith(params, 'page', String(page.page - 1))}`}
                  className="underline"
                >
                  Previous
                </Link>
              ) : null}
              <span className="text-ink-500">
                Page {page.page} of {page.pageCount} · {PAGE_SIZE} per page
              </span>
              {page.page < page.pageCount ? (
                <Link
                  href={`${hrefWith(params, 'page', String(page.page + 1))}`}
                  className="underline"
                >
                  Next
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
