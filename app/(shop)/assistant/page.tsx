import Link from 'next/link';
import { Assistant } from '@/components/assistant';
import { currentViewer } from '@/lib/auth/guards';
import { llmAvailable } from '@/lib/agent/model';

export const metadata = {
  title: 'Assistant',
  description:
    'Describe what you are connecting and the assistant works out the bundle, checks real prices and drafts a quote — inside guardrails you can watch it hit.',
};
export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const viewer = await currentViewer();

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Tell it what you are connecting
        </h1>
        <p className="max-w-2xl text-ink-700 dark:text-ink-300">
          Name the equipment you have, where the data needs to end up, and roughly how many
          tags. The assistant resolves the bundle from a deterministic rule engine, gets every
          price from the server, and drafts a quote a human then approves.
        </p>
      </header>

      <Assistant signedIn={Boolean(viewer)} />

      <section
        aria-labelledby="how"
        className="surface-card space-y-3 p-5 text-sm text-ink-700 dark:text-ink-300"
      >
        <h2 id="how" className="text-sm font-semibold uppercase tracking-widest text-ink-500">
          What is running behind this
        </h2>
        <p>
          {llmAvailable()
            ? 'A tool-calling loop on Claude, with six tools and a hard cap of eight turns.'
            : 'No language-model key is configured on this deployment, so a deterministic planner runs instead — the same one the circuit breaker falls back to. It plans by reading the request rather than reasoning about it, which is a real ceiling and is reported as one.'}{' '}
          Either way the loop, the tools and every guardrail are identical, which is the point:
          a guardrail that only holds for one implementation holds by accident.
        </p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          <li>· The model never states a price</li>
          <li>· Tool input and output are both schema-checked</li>
          <li>· Permissions are re-derived inside every tool</li>
          <li>· Catalogue text can never grant a tool</li>
          <li>· Every quote it drafts waits for a human</li>
          <li>· Every tool call is written to an audit log</li>
        </ul>
        <p>
          Ten adversarial scenarios run against this on every change — a model that tries to set
          prices, grant discounts, call tools it does not have and approve its own quotes.{' '}
          <Link href="/graph" className="underline">
            The catalogue as a graph
          </Link>{' '}
          shows what it is reasoning over.
        </p>
      </section>
    </div>
  );
}
