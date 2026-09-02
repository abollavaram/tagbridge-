import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import { quoteEvents, quotes } from '@/lib/db/schema';
import { writeAudit } from '@/lib/agent/audit';
import { assertTransition, QuoteTransitionError, QUOTE_STATUSES } from './quote-state';

type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * Expiring quotes that have run out.
 *
 * Every quote is written with a 30-day expiry and the state machine has three
 * edges into `expired`, all requiring the system actor — and nothing ever
 * walked them. So the expiry date was decorative: a month-old quote was still
 * live, still acceptable, still holding prices that had moved. For a
 * quote-shaped business that is commercial exposure, not cosmetics.
 *
 * Driven through `assertTransition` like every other transition rather than a
 * bulk UPDATE, so the rules apply here too and each move writes its own event.
 */

export interface ExpiryReport {
  ranAt: Date;
  considered: number;
  expired: number;
  skipped: { quoteId: string; reason: string }[];
  tookMs: number;
}

/** Only these can expire; the rest are terminal or not yet out. */
const EXPIRABLE: readonly QuoteStatus[] = ['sent', 'viewed', 'accepted'];

export async function expireOverdueQuotes(now = new Date()): Promise<ExpiryReport> {
  const startedAt = Date.now();
  const db = await getDatabase();

  const due = toRows<{ id: string; status: QuoteStatus; number: string }>(
    await db.execute(sql`
      select id, status::text as status, number
      from quotes
      where expires_at is not null
        and expires_at < ${now}
        and status in ('sent', 'viewed', 'accepted')
      order by expires_at asc
      limit 500
    `),
  );

  const skipped: ExpiryReport['skipped'] = [];
  let expired = 0;

  for (const quote of due) {
    let transition;
    try {
      // The scheduler is the one caller entitled to be the system actor.
      transition = assertTransition(quote.status, 'expired', {
        isOwner: false,
        isApprover: false,
        isSystem: true,
      });
    } catch (error) {
      skipped.push({
        quoteId: quote.id,
        reason: error instanceof QuoteTransitionError ? error.message : 'unknown',
      });
      continue;
    }

    const moved = await db
      .update(quotes)
      .set({ status: 'expired', updatedAt: now })
      .where(sql`id = ${quote.id}::uuid and status = ${quote.status}`)
      .returning({ id: quotes.id });

    // Somebody accepted or withdrew it between the read and the write.
    if (moved.length === 0) {
      skipped.push({ quoteId: quote.id, reason: 'changed while expiring' });
      continue;
    }

    await db.insert(quoteEvents).values({
      quoteId: quote.id,
      type: transition.event,
      actor: 'system',
      payload: { from: quote.status, to: 'expired', number: quote.number },
    });
    expired += 1;
  }

  if (expired > 0 || skipped.length > 0) {
    await writeAudit({
      actor: 'system:expiry',
      action: 'quotes.expired',
      resource: 'quotes',
      before: null,
      after: { considered: due.length, expired, skipped: skipped.length },
    });
  }

  return {
    ranAt: now,
    considered: due.length,
    expired,
    skipped,
    tookMs: Date.now() - startedAt,
  };
}

export { EXPIRABLE };
