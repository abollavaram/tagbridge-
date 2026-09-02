import Link from 'next/link';
import { search } from '@/lib/search/pipeline';

export const metadata = {
  title: 'Search',
  description:
    'Search the catalogue by part number, by protocol, or by describing the problem you have.',
};
export const dynamic = 'force-dynamic';

const EXAMPLES = [
  'get tag data from a ControlLogix into SQL Server',
  'Rockwell PLC connector',
  'TB-OPCUA-4100',
  'does this work with Modbus RTU over serial',
  'modbis gateway',
];

const INTENT_COPY: Record<string, string> = {
  'specific-product': 'You named a product, so exact matches rank first.',
  'compatibility-question':
    'This reads as a compatibility question. These are the products that speak what you asked about; the assistant can resolve a full bundle from your source system, destination and tag count.',
  browse: 'This reads as a description of a problem, so semantic matching is weighted higher.',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim();
  const result = query ? await search(query, { limit: 8 }) : null;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Search</h1>
        <p className="max-w-2xl text-ink-700 dark:text-ink-300">
          Search by part number, by protocol, or by describing the problem. Vendor and
          protocol synonyms are expanded automatically, so &ldquo;Rockwell&rdquo; finds
          Allen-Bradley products.
        </p>
      </header>

      <form action="/search" method="get" className="flex flex-wrap gap-2">
        <label htmlFor="q" className="sr-only">
          Search the catalogue
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="e.g. get tag data from a ControlLogix into SQL Server"
          className="min-w-0 flex-1 rounded border border-ink-300 px-3 py-2"
        />
        <button
          type="submit"
          className="rounded bg-signal-600 px-4 py-2 font-medium text-white"
        >
          Search
        </button>
      </form>

      {!result ? (
        <section aria-labelledby="examples" className="space-y-3">
          <h2 id="examples" className="text-sm font-semibold uppercase tracking-widest text-ink-500">
            Try one of these
          </h2>
          <ul className="space-y-2">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <Link
                  href={`/search?q=${encodeURIComponent(example)}`}
                  className="underline decoration-ink-300 underline-offset-4 hover:decoration-current"
                >
                  {example}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <section
            aria-labelledby="interpretation"
            className="space-y-2 rounded-lg border border-ink-100 p-4 text-sm dark:border-ink-700"
          >
            <h2
              id="interpretation"
              className="text-xs font-semibold uppercase tracking-widest text-ink-500"
            >
              How this query was read
            </h2>
            <p>
              <span className="font-mono">{result.intent.intent}</span>
              <span className="text-ink-500">
                {' '}
                (confidence {result.intent.confidence.toFixed(2)}) ·{' '}
                {result.tookMs.toFixed(0)} ms
              </span>
            </p>
            <p className="text-ink-700 dark:text-ink-300">
              {INTENT_COPY[result.intent.intent]}
            </p>
            {result.expandedTerms.length > result.normalized.tokens.length ? (
              <p className="text-ink-500">
                Expanded to{' '}
                <span className="font-mono">
                  {result.expandedTerms.slice(0, 12).join(', ')}
                  {result.expandedTerms.length > 12 ? ', …' : ''}
                </span>
              </p>
            ) : null}
          </section>

          {result.hits.length === 0 ? (
            <p>
              Nothing matched that.{' '}
              <Link href="/products" className="underline">
                Browse the catalogue
              </Link>{' '}
              instead.
            </p>
          ) : (
            <ol aria-label="Search results" className="space-y-4">
              {result.hits.map((hit, index) => (
                <li
                  key={hit.id}
                  className="rounded-lg border border-ink-100 p-4 dark:border-ink-700"
                >
                  <article className="space-y-2">
                    <div className="flex items-baseline justify-between gap-4">
                      <h2 className="text-lg font-semibold">
                        <span className="mr-2 font-mono text-sm text-ink-500">
                          {index + 1}
                        </span>
                        <Link href={`/products/${hit.slug}`} className="hover:underline">
                          {hit.name}
                        </Link>
                      </h2>
                      <span className="font-mono text-xs text-ink-500">{hit.sku}</span>
                    </div>
                    <p className="text-sm text-ink-500">{hit.category}</p>
                    {hit.reasons.length > 0 ? (
                      <ul className="flex flex-wrap gap-1.5 text-xs">
                        {hit.reasons.slice(0, 4).map((reason) => (
                          <li
                            key={reason}
                            className="rounded border border-ink-100 px-2 py-0.5 text-ink-700 dark:border-ink-700 dark:text-ink-300"
                          >
                            {reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
