import { NextResponse } from 'next/server';
import { isScheduler } from '@/lib/cron-auth';
import { processEvent, retryableEvents } from '@/lib/sync/events';
import { getSubscriptionProvider } from '@/lib/sync/provider';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Retries failed webhook events.
 *
 * The backoff schedule was computed, stored and tested, and nothing consumed
 * it: the only caller of `retryableEvents()` was a button on the admin
 * dashboard, so a failed event's next attempt was whenever somebody happened
 * to open the page. The button stays as a manual override; this is what
 * actually drives the queue.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isScheduler(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const log = requestLogger(requestIdFrom(request.headers));
  const provider = getSubscriptionProvider();
  const pending = await retryableEvents(50);

  const outcomes: Record<string, number> = {};
  for (const event of pending) {
    const outcome = await processEvent(event.providerEventId, provider);
    outcomes[outcome.status] = (outcomes[outcome.status] ?? 0) + 1;
  }

  if (pending.length > 0) {
    log.info({ attempted: pending.length, outcomes }, 'retry drain');
  }

  return NextResponse.json({ attempted: pending.length, outcomes });
}
