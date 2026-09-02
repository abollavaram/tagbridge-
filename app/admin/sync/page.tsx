import { requireAdmin } from '@/lib/auth/guards';
import { deadLetterQueue, eventThroughput, listSubscriptions } from '@/lib/sync/events';
import { getSubscriptionProvider } from '@/lib/sync/provider';
import { currentDrift, syncCounts } from '@/lib/sync/reconcile';
import { usingConfiguredWebhookSecret } from '@/lib/sync/secret';
import {
  breakSyncAction,
  drainRetriesAction,
  reconcileAction,
  replayAction,
  replayAllDeadLetteredAction,
  seedDemoAction,
} from './actions';

export const metadata = { title: 'Subscription sync' };
export const dynamic = 'force-dynamic';

function Stat({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'bad' | 'good';
  hint?: string;
}) {
  const toneClass =
    tone === 'bad'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'good'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-ink-900 dark:text-ink-50';
  return (
    <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
      <div className="text-xs font-medium uppercase tracking-widest text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-ink-500">{hint}</div> : null}
    </div>
  );
}

function Button({ children, name }: { children: React.ReactNode; name?: string }) {
  return (
    <button
      type="submit"
      name={name ? 'kind' : undefined}
      value={name}
      className="rounded border border-ink-300 px-3 py-1.5 text-sm font-medium hover:bg-ink-50 dark:border-ink-600 dark:hover:bg-ink-800"
    >
      {children}
    </button>
  );
}

function when(value: Date | null): string {
  return value ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : '—';
}

export default async function SyncDashboard({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  await requireAdmin('/admin/sync');

  const [{ notice }, throughput, dlq, drift, counts, subs] = await Promise.all([
    searchParams,
    eventThroughput(),
    deadLetterQueue(),
    currentDrift(),
    syncCounts(),
    listSubscriptions(20),
  ]);
  const provider = getSubscriptionProvider();

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Subscription sync</h1>
        <p className="max-w-3xl text-ink-700 dark:text-ink-300">
          Webhooks are a trigger, never truth: every event causes a re-read of the
          subscription from <span className="font-mono text-sm">{provider.name}</span>, and
          that read is what gets written. Ordering is decided on the provider&rsquo;s event
          timestamp rather than arrival order, and idempotency is a unique constraint on
          the event id rather than a check-then-insert.
        </p>
        <p className="text-sm text-ink-500">
          Signing secret:{' '}
          {usingConfiguredWebhookSecret()
            ? 'configured from the environment'
            : 'derived per deployment — unsigned requests are still refused'}
          . Reconciliation runs nightly at 03:17 UTC.
        </p>
      </header>

      {notice ? (
        <p
          role="status"
          data-testid="sync-notice"
          className="rounded-lg border border-warn-600/30 bg-warn-100 px-4 py-3 text-sm text-warn-600 dark:bg-warn-600/10 dark:text-warn-400"
        >
          {notice}
        </p>
      ) : null}

      <section aria-labelledby="throughput" className="space-y-3">
        <h2 id="throughput" className="text-xl font-semibold">
          Event throughput
        </h2>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Processed" value={throughput.processed} tone="good" />
          <Stat label="Awaiting" value={throughput.received} />
          <Stat
            label="Failed"
            value={throughput.failed}
            tone={throughput.failed > 0 ? 'bad' : 'neutral'}
            hint="retryable"
          />
          <Stat
            label="DLQ depth"
            value={throughput.deadLettered}
            tone={throughput.deadLettered > 0 ? 'bad' : 'neutral'}
            hint="exhausted 5 attempts"
          />
          <Stat label="Last hour" value={throughput.lastHour} />
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={drainRetriesAction}>
            <Button>Drain retryable</Button>
          </form>
          <form action={replayAllDeadLetteredAction}>
            <Button>Replay the whole DLQ</Button>
          </form>
        </div>
      </section>

      <section aria-labelledby="drift" className="space-y-3">
        <h2 id="drift" className="text-xl font-semibold">
          Reconciliation and drift
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="ERP records" value={counts.total} />
          <Stat label="In sync" value={counts.synced} tone="good" />
          <Stat
            label="Drifted"
            value={counts.drifted}
            tone={counts.drifted > 0 ? 'bad' : 'neutral'}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={seedDemoAction}>
            <Button>Seed demo subscriptions</Button>
          </form>
          <form action={reconcileAction}>
            <Button>Run reconciliation now</Button>
          </form>
          <form action={breakSyncAction} className="flex flex-wrap gap-2">
            <Button name="cancelled_upstream">Break: cancelled upstream</Button>
            <Button name="status_changed">Break: status changed</Button>
            <Button name="billed_but_unknown">Break: billed but unknown</Button>
          </form>
        </div>
        <p className="text-xs text-ink-500">
          Breaking sync changes the provider&rsquo;s state without delivering the event —
          the same shape as a dropped webhook. Nothing writes a drift flag directly;
          reconciliation has to find it.
        </p>

        {drift.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="drift-empty">
            No drift detected.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Detected drift">
              <thead className="border-b border-ink-200 text-left dark:border-ink-700">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Subscription</th>
                  <th scope="col" className="py-2 pr-4 font-medium">ERP ref</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Why</th>
                  <th scope="col" className="py-2 font-medium">Detected</th>
                </tr>
              </thead>
              <tbody>
                {drift.map((row) => (
                  <tr key={row.providerId} className="border-b border-ink-100 dark:border-ink-800">
                    <td className="py-2 pr-4 font-mono text-xs">{row.providerId}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{row.erpRef}</td>
                    <td className="py-2 pr-4 text-red-600 dark:text-red-400">{row.driftReason}</td>
                    <td className="py-2 tabular-nums text-xs">{when(row.driftDetectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="dlq" className="space-y-3">
        <h2 id="dlq" className="text-xl font-semibold">
          Dead-letter queue
        </h2>
        {dlq.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="dlq-empty">
            Nothing dead-lettered.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Dead-lettered events">
              <thead className="border-b border-ink-200 text-left dark:border-ink-700">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Event</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Attempts</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Last error</th>
                  <th scope="col" className="py-2 font-medium">Replay</th>
                </tr>
              </thead>
              <tbody>
                {dlq.map((event) => (
                  <tr
                    key={event.providerEventId}
                    className="border-b border-ink-100 dark:border-ink-800"
                  >
                    <td className="py-2 pr-4 font-mono text-xs">{event.providerEventId}</td>
                    <td className="py-2 pr-4 text-xs">{event.type}</td>
                    <td className="py-2 pr-4 tabular-nums">{event.attempts}</td>
                    <td className="py-2 pr-4 text-xs text-red-600 dark:text-red-400">
                      {event.lastError}
                    </td>
                    <td className="py-2">
                      <form action={replayAction}>
                        <input
                          type="hidden"
                          name="providerEventId"
                          value={event.providerEventId}
                        />
                        <Button>Replay</Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="subscriptions" className="space-y-3">
        <h2 id="subscriptions" className="text-xl font-semibold">
          Subscriptions
        </h2>
        {subs.length === 0 ? (
          <p className="text-sm text-ink-500">
            None yet. Seed the demo subscriptions to populate this.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Subscriptions">
              <thead className="border-b border-ink-200 text-left dark:border-ink-700">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Provider id</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Customer</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Variant</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">Last event</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((row) => (
                  <tr key={row.providerId} className="border-b border-ink-100 dark:border-ink-800">
                    <td className="py-2 pr-4 font-mono text-xs">{row.providerId}</td>
                    <td className="py-2 pr-4">{row.email}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{row.variantSku}</td>
                    <td className="py-2 pr-4">{row.status}</td>
                    <td className="py-2 tabular-nums text-xs">{when(row.lastEventAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
