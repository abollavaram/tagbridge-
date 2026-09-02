'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireQuoteApprover } from '@/lib/auth/guards';
import { canApproveQuotes } from '@/lib/auth/roles';
import { getDatabase } from '@/lib/db';
import { firstRow } from '@/lib/db/rows';
import { quoteEvents, quotes } from '@/lib/db/schema';
import { writeAudit } from '@/lib/agent/audit';
import {
  assertTransition,
  QUOTE_STATUSES,
  QuoteTransitionError,
} from '@/lib/commerce/quote-state';

/**
 * Quote approval.
 *
 * This is the other half of the human-in-the-loop guardrail. The agent puts
 * quotes into `pending_approval` and cannot move them out; these actions are
 * how they leave, and they are the only way.
 *
 * Every one re-checks the approver role. A server action is its own HTTP
 * endpoint — reachable with a crafted request that never rendered the page —
 * so the page's own check protects the view and nothing more.
 */

const decisionSchema = z.object({
  quoteId: z.string().uuid(),
  to: z.enum(QUOTE_STATUSES),
  reason: z.string().max(500).optional(),
});

/**
 * How a failed decision reaches the operator.
 *
 * A server action can return state, but only a client component can read it,
 * and this page deliberately ships no client JavaScript. Redirecting with the
 * message keeps that property and still means a lost race is visible — which
 * is the whole point: silently reporting success for a transition that did not
 * happen is the bug being fixed.
 */
function fail(message: string): never {
  redirect(`/approvals?notice=${encodeURIComponent(message)}`);
}

async function decide(formData: FormData): Promise<void> {
  const viewer = await requireQuoteApprover('/approvals');

  const parsed = decisionSchema.safeParse({
    quoteId: formData.get('quoteId'),
    to: formData.get('to'),
    reason: formData.get('reason') || undefined,
  });
  if (!parsed.success) fail('That decision was not understood.');

  const db = await getDatabase();
  const existing = firstRow<{ status: string; user_id: string }>(
    await db.execute(sql`
      select status::text as status, user_id from quotes where id = ${parsed.data.quoteId}::uuid limit 1
    `),
  );
  if (!existing) fail('That quote no longer exists.');

  // Throws on an illegal edge. The UI only offers legal ones, but the action
  // does not trust the UI it rendered.
  let transition;
  try {
    transition = assertTransition(
    existing.status as (typeof QUOTE_STATUSES)[number],
    parsed.data.to,
      {
        isOwner: existing.user_id === viewer.id,
        isApprover: canApproveQuotes(viewer.role),
        isSystem: false,
      },
    );
  } catch (error) {
    if (error instanceof QuoteTransitionError) fail(error.message);
    throw error;
  }

  const moved = await db
    .update(quotes)
    .set({ status: parsed.data.to, updatedAt: new Date() })
    .where(
      and(
        eq(quotes.id, parsed.data.quoteId),
        // Optimistic: if someone else moved it since the page rendered, this
        // updates nothing rather than overwriting their decision.
        eq(quotes.status, existing.status as (typeof QUOTE_STATUSES)[number]),
      ),
    )
    .returning({ id: quotes.id });

  // ...and if it updated nothing, say so. This used to fall straight through
  // to the event and audit writes: the page said approved, the audit log said
  // approved, and the quote was still pending because a colleague had declined
  // it two seconds earlier.
  if (moved.length === 0) {
    revalidatePath('/approvals');
    fail('That quote was changed by someone else. Nothing was applied.');
  }

  await db.insert(quoteEvents).values({
    quoteId: parsed.data.quoteId,
    type: transition.event,
    actor: 'user',
    payload: { by: viewer.role, from: existing.status, to: parsed.data.to, reason: parsed.data.reason },
  });

  await writeAudit({
    actor: `user:${viewer.id}`,
    action: 'quote.transition',
    resource: `quote:${parsed.data.quoteId}`,
    before: { status: existing.status },
    after: { status: parsed.data.to, event: transition.event },
  });

  revalidatePath('/approvals');
}

export async function approveAction(formData: FormData): Promise<void> {
  formData.set('to', 'sent');
  await decide(formData);
}

export async function declineAction(formData: FormData): Promise<void> {
  formData.set('to', 'rejected');
  await decide(formData);
}

export async function returnToDraftAction(formData: FormData): Promise<void> {
  formData.set('to', 'draft');
  await decide(formData);
}
