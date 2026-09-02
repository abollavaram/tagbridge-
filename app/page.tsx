import Link from 'next/link';
import { MEASURED, PHASES_SHIPPED, PHASES_TOTAL } from '@/lib/build-status';
import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { firstRow } from '@/lib/db/rows';
import { products } from '@/lib/db/schema';

/**
 * Static metadata rather than inherited: Next resolves an inherited or async
 * title and description lazily on a dynamic page and streams them into the
 * body, where a crawler that does not run JavaScript never sees them.
 */
export const metadata = {
  title: 'TagBridge — industrial connectivity software',
  description:
    'A storefront for OPC servers, protocol gateways, historian connectors and MQTT bridges, where search understands how control engineers describe a problem.',
  alternates: { canonical: '/' },
};

/**
 * Prerendered and revalidated rather than dynamic. `force-dynamic` defers
 * metadata resolution, and Next then streams the title and description into
 * the body — where a crawler that does not run JavaScript never sees them.
 */
export const revalidate = 300;

async function catalogSummary(): Promise<{ products: number; categories: number }> {
  const db = await getDatabase();
  const result = await db.execute<{ products: number; categories: number }>(
    sql`select count(*)::int as products, count(distinct ${products.category})::int as categories from ${products} where ${products.active}`,
  );
  const row = firstRow<{ products: number; categories: number }>(result);
  return { products: row?.products ?? 0, categories: row?.categories ?? 0 };
}

export default async function HomePage() {
  const summary = await catalogSummary();

  return (
    <div className="space-y-16">
      {/* ---------------------------------------------------------- hero */}
      <section className="space-y-6">
        <p className="inline-flex items-center gap-2 rounded-full border border-signal-300/50 bg-signal-100/60 px-3 py-1 text-xs font-medium text-signal-700 dark:border-signal-700/40 dark:bg-signal-700/15 dark:text-signal-300">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-signal-600" />
          Industrial connectivity software
        </p>

        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">
          Search by the problem you have, not the part number you do not know yet.
        </h1>

        <p className="max-w-2xl text-lg leading-relaxed text-ink-700 dark:text-ink-300">
          A maintenance engineer with a line down types{' '}
          <em>get tag data from a ControlLogix into SQL Server</em>. Catalog search built for
          consumer retail returns nothing for that, and the buyer leaves. This one is built
          around the way control engineers actually talk.
        </p>

        {/* A real search, in the hero. Nothing to read first. */}
        <form action="/search" method="get" className="max-w-2xl">
          <label htmlFor="hero-q" className="sr-only">
            Describe what you are connecting
          </label>
          <div className="surface-card flex items-center gap-2 p-1.5 focus-within:ring-2 focus-within:ring-signal-500">
            <input
              id="hero-q"
              name="q"
              type="search"
              defaultValue=""
              placeholder="ControlLogix into SQL Server"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-base outline-none placeholder:text-ink-500"
            />
            <button
              type="submit"
              className="shrink-0 rounded-md bg-signal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-signal-700"
            >
              Search
            </button>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-500">Or try:</span>
          {[
            'Rockwell',
            'historian drops tags overnight',
            'TB-OPCUA-4100',
            'does this work with Modbus RTU',
          ].map((example) => (
            <Link
              key={example}
              href={`/search?q=${encodeURIComponent(example)}`}
              className="rounded-full border border-ink-200 px-3 py-1 text-ink-700 transition-colors hover:border-signal-300 hover:text-signal-700 dark:border-ink-700 dark:text-ink-300"
            >
              {example}
            </Link>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------- the party trick */}
      <section aria-labelledby="trick" className="space-y-5">
        <h2 id="trick" className="text-xs font-semibold uppercase tracking-widest text-ink-500">
          Why that is harder than it looks
        </h2>

        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              query: '“Rockwell”',
              finds: 'Products labelled Allen-Bradley',
              why: 'Nobody wrote Rockwell on those products. A 148-edge synonym graph knows the two are the same company — the way a salesperson would.',
            },
            {
              query: '“historian drops tags overnight”',
              finds: 'Store-and-forward buffering',
              why: 'Not one of those words appears in the product. Dense retrieval matches the described symptom to the thing that fixes it.',
            },
            {
              query: '“TB-OPCUA-4100”',
              finds: 'That exact product, first',
              why: 'Part numbers survive normalisation intact, and lexical retrieval puts an exact match above everything a synonym reached.',
            },
          ].map((card) => (
            <article key={card.query} className="surface-card flex flex-col gap-2 p-5">
              <p className="font-mono text-sm text-signal-700 dark:text-signal-300">
                {card.query}
              </p>
              <p className="font-medium">{card.finds}</p>
              <p className="text-sm leading-relaxed text-ink-600 dark:text-ink-300">{card.why}</p>
            </article>
          ))}
        </div>

        <p className="text-sm text-ink-500">
          Every result on the{' '}
          <Link href="/search" className="underline">
            search page
          </Link>{' '}
          carries the reasons it was ranked where it was — so a wrong answer is debuggable
          rather than a shrug.
        </p>
      </section>

      {/* ------------------------------------------------------- measured */}
      <section aria-labelledby="measured" className="space-y-4">
        <h2
          id="measured"
          className="text-xs font-semibold uppercase tracking-widest text-ink-500"
        >
          Measured, not asserted
        </h2>

        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              label: 'Search precision@3',
              value: MEASURED.searchPrecisionAt3.toFixed(2),
              note: `right answer in the top three, over ${MEASURED.searchQueries} queries`,
            },
            {
              label: 'Guardrails held',
              value: '100%',
              note: `${MEASURED.agentScenarios} agent scenarios, ten of them attacks`,
            },
            {
              label: 'Automatic checks',
              value: String(MEASURED.tests),
              note: 'run on every change; a failure blocks the ship',
            },
            {
              label: 'Products in catalog',
              value: String(summary.products),
              note: `across ${summary.categories} categories, every word original`,
            },
          ].map((stat) => (
            <div key={stat.label} className="surface-card p-4">
              <dt className="text-xs font-medium uppercase tracking-wider text-ink-500">
                {stat.label}
              </dt>
              <dd className="mt-1.5 font-mono text-3xl font-semibold tracking-tight tabular-nums">
                {stat.value}
              </dd>
              <dd className="mt-1 text-xs leading-snug text-ink-500">{stat.note}</dd>
            </div>
          ))}
        </dl>

        <p className="max-w-3xl text-sm text-ink-500">
          One target was missed and is reported as missed: search beats a default full-text
          baseline by 37%, but a carefully tuned one by only 8% — under the 15% the plan asked
          for. The useful finding sits underneath it. Most of the gain came from schema and
          index design, not from hybrid retrieval, and quoting the flattering number would have
          buried that.
        </p>
      </section>

      {/* --------------------------------------------------- what is here */}
      <section aria-labelledby="built" className="space-y-4">
        <h2 id="built" className="text-xs font-semibold uppercase tracking-widest text-ink-500">
          {PHASES_SHIPPED} of {PHASES_TOTAL} phases shipped — go and look
        </h2>

        <ul className="grid gap-3 sm:grid-cols-2">
          {[
            {
              href: '/assistant',
              name: 'The assistant',
              blurb:
                'Describe a job and watch it work — including the guardrails refusing it a price.',
            },
            {
              href: '/search',
              name: 'Hybrid search',
              blurb: 'Three retrievers, fused, reranked, and explaining every result.',
            },
            {
              href: '/graph',
              name: 'Knowledge graph',
              blurb: '251 nodes and 599 edges of the catalogue, rendered server-side.',
            },
            {
              href: '/products',
              name: 'Catalog and quotes',
              blurb: 'Volume pricing, a quote path, and prices the client can never set.',
            },
            {
              href: '/admin/sync',
              name: 'Subscription drift',
              blurb:
                'Break sync on purpose and watch the nightly reconciliation catch it. Admin only.',
            },
            {
              href: '/.well-known/ucp',
              name: 'Agent-native layer',
              blurb: 'A UCP profile, an MCP server and ACP checkout, against pinned specs.',
            },
          ].map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="surface-card group flex h-full flex-col gap-1.5 p-4 transition-colors hover:border-signal-300 dark:hover:border-signal-700"
              >
                <span className="font-medium group-hover:text-signal-700 dark:group-hover:text-signal-300">
                  {item.name}
                </span>
                <span className="text-sm leading-relaxed text-ink-600 dark:text-ink-300">
                  {item.blurb}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
