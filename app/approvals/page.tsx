import { sql } from 'drizzle-orm';
import { requireQuoteApprover } from '@/lib/auth/guards';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import { formatCents } from '@/lib/commerce/pricing';
import { approveAction, declineAction, returnToDraftAction } from './actions';

export const metadata = { title: 'Quote approval' };
export const dynamic = 'force-dynamic';

interface QuoteRow {
  id: string;
  number: string;
  status: string;
  subtotal_cents: number;
  agent_notes: string | null;
  created_at: Date;
  lines: number;
}

async function pendingQuotes(): Promise<QuoteRow[]> {
  const db = await getDatabase();
  return toRows<QuoteRow>(
    await db.execute(sql`
      select q.id, q.number, q.status::text as status, q.subtotal_cents,
             q.agent_notes, q.created_at,
             (select count(*) from quote_line_items l where l.quote_id = q.id)::int as lines
      from quotes q
      where q.status = 'pending_approval'
      order by q.created_at desc
      limit 50
    `),
  );
}

async function recentlyDecided(): Promise<QuoteRow[]> {
  const db = await getDatabase();
  return toRows<QuoteRow>(
    await db.execute(sql`
      select q.id, q.number, q.status::text as status, q.subtotal_cents,
             q.agent_notes, q.created_at,
             (select count(*) from quote_line_items l where l.quote_id = q.id)::int as lines
      from quotes q
      where q.status in ('sent', 'rejected', 'draft')
      order by q.updated_at desc
      limit 10
    `),
  );
}

function Button({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="submit"
      className="rounded border border-ink-300 px-3 py-1.5 text-sm font-medium hover:bg-ink-50 dark:border-ink-600 dark:hover:bg-ink-800"
    >
      {children}
    </button>
  );
}

export default async function QuoteApprovalPage() {
  await requireQuoteApprover('/approvals');
  const [pending, decided] = await Promise.all([pendingQuotes(), recentlyDecided()]);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Quote approval</h1>
        <p className="max-w-3xl text-ink-700 dark:text-ink-300">
          Every quote the assistant drafts lands here, whatever it is worth. That is
          deliberate: the point of a human in the loop is that the agent is not the one
          deciding whether a human is needed. Nothing leaves this page without someone
          with the sales or admin role choosing.
        </p>
      </header>

      <section aria-labelledby="pending" className="space-y-3">
        <h2 id="pending" className="text-xl font-semibold">
          Awaiting a decision
          <span className="ml-2 tabular-nums text-ink-500">{pending.length}</span>
        </h2>

        {pending.length === 0 ? (
          <p className="text-sm text-ink-500" data-testid="no-pending-quotes">
            Nothing is waiting for approval.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Quotes awaiting approval">
              <thead className="border-b border-ink-200 text-left dark:border-ink-700">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Quote</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Lines</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Subtotal</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Agent notes</th>
                  <th scope="col" className="py-2 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((quote) => (
                  <tr key={quote.id} className="border-b border-ink-100 dark:border-ink-800">
                    <td className="py-3 pr-4 font-mono text-xs">{quote.number}</td>
                    <td className="py-3 pr-4 tabular-nums">{quote.lines}</td>
                    <td className="py-3 pr-4 tabular-nums font-medium">
                      {formatCents(quote.subtotal_cents)}
                    </td>
                    <td className="py-3 pr-4 max-w-xs text-xs text-ink-600 dark:text-ink-400">
                      {quote.agent_notes ?? '—'}
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <form action={approveAction}>
                          <input type="hidden" name="quoteId" value={quote.id} />
                          <Button>Approve and send</Button>
                        </form>
                        <form action={returnToDraftAction}>
                          <input type="hidden" name="quoteId" value={quote.id} />
                          <Button>Return to draft</Button>
                        </form>
                        <form action={declineAction}>
                          <input type="hidden" name="quoteId" value={quote.id} />
                          <Button>Decline</Button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="decided" className="space-y-3">
        <h2 id="decided" className="text-xl font-semibold">
          Recently decided
        </h2>
        {decided.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing decided yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {decided.map((quote) => (
              <li key={quote.id}>
                <span className="font-mono text-xs">{quote.number}</span>
                <span className="text-ink-500"> — {quote.status}, </span>
                <span className="tabular-nums">{formatCents(quote.subtotal_cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
