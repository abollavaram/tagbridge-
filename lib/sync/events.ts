import { and, asc, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { firstRow, toRows } from '@/lib/db/rows';
import {
  auditLog,
  productVariants,
  subscriptions,
  users,
  webhookEvents,
} from '@/lib/db/schema';
import { markOrderPaid, markOrderPaymentFailed } from '@/lib/commerce/orders';
import { writeAudit } from '@/lib/agent/audit';
import type { SubscriptionProvider } from './provider';

/**
 * Webhook ingest and processing.
 *
 * Split deliberately into two steps that fail independently:
 *
 *   record()  — durable, fast, and idempotent. Runs inside the request.
 *   process() — talks to the provider and the database. May fail and retry.
 *
 * The provider is entitled to a fast 2xx, and it retries anything slow. If
 * recording and processing were one step, a provider timeout during a slow
 * downstream call would produce a retry of an event we had already half
 * applied. Recording first means a retry finds the event already stored and
 * becomes a no-op, whatever happened to the processing.
 */

export const MAX_ATTEMPTS = 5;

/**
 * Order payment events.
 *
 * These were handled by nothing at all: the webhook's only branch was the
 * subscription one, and every other type fell through to `ignored`. So a card
 * payment was taken and the order sat at `pending_payment` forever, telling
 * the buyer "nothing has been charged yet". `markOrderPaid` existed, was
 * correct, and was referenced only by a test.
 */
const PAYMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

/** Event types that carry a subscription and are worth acting on. */
const SUBSCRIPTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
]);

export interface IncomingEvent {
  id: string;
  type: string;
  /** Provider-assigned event time in seconds, as Stripe sends it. */
  createdAt: Date;
  payload: unknown;
}

export type RecordOutcome = 'recorded' | 'duplicate';

/**
 * Stores an event exactly once.
 *
 * The uniqueness of `provider_event_id` is the idempotency guarantee — not a
 * prior SELECT, which two concurrent deliveries of the same event would both
 * pass before either inserted. `on conflict do nothing` pushes the decision
 * into the one place that can make it atomically, and the empty returning set
 * is how a duplicate announces itself.
 */
export async function recordEvent(event: IncomingEvent): Promise<RecordOutcome> {
  const db = await getDatabase();
  const inserted = await db
    .insert(webhookEvents)
    .values({
      providerEventId: event.id,
      type: event.type,
      payload: event.payload as object,
      occurredAt: event.createdAt,
    })
    .onConflictDoNothing({ target: webhookEvents.providerEventId })
    .returning({ id: webhookEvents.id });

  return inserted.length > 0 ? 'recorded' : 'duplicate';
}

export type ProcessOutcome =
  | { status: 'applied'; subscriptionId: string }
  | { status: 'superseded'; reason: string }
  | { status: 'ignored'; reason: string }
  | { status: 'retry'; attempts: number; error: string; nextAttemptInMs: number }
  | { status: 'dead_lettered'; attempts: number; error: string };

/** Exponential backoff with a fixed base, so a retry schedule is inspectable. */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 60_000);
}

function subscriptionIdFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const object = (payload as { data?: { object?: unknown } }).data?.object;
  if (!object || typeof object !== 'object') return null;
  const record = object as { id?: unknown; subscription?: unknown };
  // An invoice event carries the subscription id in `subscription`; a
  // subscription event carries it in `id`.
  if (typeof record.subscription === 'string') return record.subscription;
  if (typeof record.id === 'string') return record.id;
  return null;
}

/**
 * Applies one recorded event.
 *
 * The payload is used for exactly one thing: naming which subscription
 * changed. Everything else comes from re-reading the provider. That is what
 * makes a replayed, reordered, or partially-trusted payload harmless — the
 * worst a bad payload can do is make us re-read a subscription unnecessarily.
 */
export async function processEvent(
  providerEventId: string,
  provider: SubscriptionProvider,
): Promise<ProcessOutcome> {
  const db = await getDatabase();

  const event = firstRow<{
    id: string;
    type: string;
    payload: unknown;
    occurred_at: Date;
    attempts: number;
  }>(
    await db.execute(sql`
      select id, type, payload, occurred_at, attempts
      from webhook_events where provider_event_id = ${providerEventId} limit 1
    `),
  );

  if (!event) return { status: 'ignored', reason: 'no such event' };

  const fail = async (message: string): Promise<ProcessOutcome> => {
    const attempts = event.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await db
      .update(webhookEvents)
      .set({
        attempts,
        status: dead ? 'dead_lettered' : 'failed',
        lastError: message.slice(0, 500),
      })
      .where(eq(webhookEvents.providerEventId, providerEventId));
    return dead
      ? { status: 'dead_lettered', attempts, error: message }
      : { status: 'retry', attempts, error: message, nextAttemptInMs: backoffMs(attempts) };
  };

  const settle = async (): Promise<void> => {
    await db
      .update(webhookEvents)
      .set({ status: 'processed', processedAt: new Date(), lastError: null })
      .where(eq(webhookEvents.providerEventId, providerEventId));
  };

  if (PAYMENT_EVENT_TYPES.has(event.type)) {
    const outcome = await applyPaymentEvent(event.type, event.payload, providerEventId);
    if (outcome.retry) return fail(outcome.detail);
    await settle();
    return outcome.applied
      ? { status: 'applied', subscriptionId: outcome.detail }
      : { status: 'ignored', reason: outcome.detail };
  }

  if (!SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
    // Not an error: providers send far more than any one consumer cares
    // about. Marking it processed keeps it out of the dead-letter queue.
    await settle();
    return { status: 'ignored', reason: `unhandled type ${event.type}` };
  }

  const providerSubscriptionId = subscriptionIdFrom(event.payload);
  if (!providerSubscriptionId) {
    await settle();
    return { status: 'ignored', reason: 'payload names no subscription' };
  }

  const occurredAt = new Date(event.occurred_at);

  const existing = firstRow<{ id: string; status: string; last_event_at: Date | null }>(
    await db.execute(sql`
      select id, status, last_event_at from subscriptions
      where provider_id = ${providerSubscriptionId} limit 1
    `),
  );

  // Ordering is decided before any provider call, on the event's own
  // timestamp. A late-arriving older event is acknowledged, not applied.
  if (existing?.last_event_at && new Date(existing.last_event_at) >= occurredAt) {
    await settle();
    return {
      status: 'superseded',
      reason: `event at ${occurredAt.toISOString()} is older than applied state`,
    };
  }

  let remote;
  try {
    remote = await provider.fetchSubscription(providerSubscriptionId);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (!remote) {
    // The provider does not have it. Not retryable — retrying cannot conjure
    // a subscription — so it is settled rather than dead-lettered.
    await settle();
    return { status: 'ignored', reason: `provider has no subscription ${providerSubscriptionId}` };
  }

  const variant = firstRow<{ id: string }>(
    await db.execute(sql`select id from product_variants where sku = ${remote.variantSku} limit 1`),
  );
  if (!variant) return fail(`no variant matches provider sku ${remote.variantSku}`);

  const user = firstRow<{ id: string }>(
    await db.execute(sql`select id from users where email = ${remote.customerEmail} limit 1`),
  );
  if (!user) return fail(`no user matches provider customer ${remote.customerEmail}`);

  const before = existing ? { status: existing.status } : null;

  await db
    .insert(subscriptions)
    .values({
      providerId: remote.id,
      userId: user.id,
      variantId: variant.id,
      status: remote.status,
      currentPeriodEnd: remote.currentPeriodEnd,
      updatedAt: new Date(),
      lastEventAt: occurredAt,
    })
    .onConflictDoUpdate({
      target: subscriptions.providerId,
      set: {
        userId: user.id,
        variantId: variant.id,
        status: remote.status,
        currentPeriodEnd: remote.currentPeriodEnd,
        updatedAt: new Date(),
        lastEventAt: occurredAt,
      },
    });

  await db.insert(auditLog).values({
    actor: `webhook:${event.type}`,
    action: 'subscription.sync',
    resource: `subscription:${remote.id}`,
    before,
    after: { status: remote.status, source: provider.name },
  });

  await settle();
  return { status: 'applied', subscriptionId: remote.id };
}

interface StripeCheckoutSession {
  id?: unknown;
  client_reference_id?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
}

function checkoutSessionFrom(payload: unknown): StripeCheckoutSession | null {
  if (!payload || typeof payload !== 'object') return null;
  const object = (payload as { data?: { object?: unknown } }).data?.object;
  if (!object || typeof object !== 'object') return null;
  return object as StripeCheckoutSession;
}

/**
 * Applies one payment event.
 *
 * The order is resolved from `client_reference_id`, which the checkout session
 * is created with, and the amount Stripe reports is checked against the order's
 * own subtotal before anything is marked paid. A mismatch is not settled
 * quietly: it is a fact somebody has to look at, so it goes to the audit log
 * and the event is left for an operator rather than being recorded as success.
 */
async function applyPaymentEvent(
  type: string,
  payload: unknown,
  providerEventId: string,
): Promise<{ applied: boolean; retry: boolean; detail: string }> {
  const session = checkoutSessionFrom(payload);
  const orderId = typeof session?.client_reference_id === 'string' ? session.client_reference_id : null;
  if (!orderId) {
    return { applied: false, retry: false, detail: 'payment event names no order' };
  }

  if (type === 'checkout.session.async_payment_failed' || type === 'checkout.session.expired') {
    const cancelled = await markOrderPaymentFailed(orderId);
    return {
      applied: cancelled,
      retry: false,
      detail: cancelled ? orderId : `order ${orderId} was not awaiting payment`,
    };
  }

  // Stripe reports `unpaid` on a completed session whose payment is still
  // processing. Acting on it would mark an order paid that is not.
  if (session?.payment_status !== 'paid') {
    return {
      applied: false,
      retry: false,
      detail: `payment_status is ${String(session?.payment_status)}, not paid`,
    };
  }

  const amount = typeof session.amount_total === 'number' ? session.amount_total : undefined;
  const sessionId = typeof session.id === 'string' ? session.id : providerEventId;
  const outcome = await markOrderPaid(orderId, sessionId, amount);

  switch (outcome.status) {
    case 'paid':
      return { applied: true, retry: false, detail: outcome.orderNumber };
    case 'already_paid':
      return { applied: false, retry: false, detail: `order ${outcome.orderNumber} was already paid` };
    case 'not_found':
      return { applied: false, retry: false, detail: `no order ${orderId}` };
    case 'not_payable':
      return { applied: false, retry: false, detail: `order is ${outcome.current}` };
    case 'amount_mismatch':
      await writeAudit({
        actor: 'system:stripe',
        action: 'order.payment_mismatch',
        resource: `order:${orderId}`,
        before: { expectedCents: outcome.expectedCents },
        after: { paidCents: outcome.paidCents, sessionId },
      });
      // Deliberately retryable so it lands in the dead-letter queue and an
      // operator sees it, rather than being settled as if it were fine.
      return {
        applied: false,
        retry: true,
        detail: `paid ${outcome.paidCents} but the order is ${outcome.expectedCents}`,
      };
  }
}

/** Events that failed but have attempts left, oldest first. */
export async function retryableEvents(limit = 25): Promise<
  { providerEventId: string; attempts: number; type: string }[]
> {
  const db = await getDatabase();
  const rows = await db
    .select({
      providerEventId: webhookEvents.providerEventId,
      attempts: webhookEvents.attempts,
      type: webhookEvents.type,
    })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.status, 'failed'), lt(webhookEvents.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(webhookEvents.occurredAt))
    .limit(limit);
  return rows;
}

export async function deadLetterQueue(limit = 50): Promise<
  {
    providerEventId: string;
    type: string;
    attempts: number;
    lastError: string | null;
    occurredAt: Date;
  }[]
> {
  const db = await getDatabase();
  return db
    .select({
      providerEventId: webhookEvents.providerEventId,
      type: webhookEvents.type,
      attempts: webhookEvents.attempts,
      lastError: webhookEvents.lastError,
      occurredAt: webhookEvents.occurredAt,
    })
    .from(webhookEvents)
    .where(eq(webhookEvents.status, 'dead_lettered'))
    .orderBy(desc(webhookEvents.occurredAt))
    .limit(limit);
}

/**
 * Replays a dead-lettered event.
 *
 * The attempt counter is reset, because a replay is a deliberate decision by
 * an operator who has usually fixed the reason it failed. Leaving the count
 * where it was would let one replay exhaust the budget immediately and
 * dead-letter it again without a real attempt.
 */
export async function replayDeadLettered(
  providerEventId: string,
  provider: SubscriptionProvider,
): Promise<ProcessOutcome> {
  const db = await getDatabase();
  const reset = await db
    .update(webhookEvents)
    .set({ status: 'received', attempts: 0, lastError: null })
    .where(
      and(
        eq(webhookEvents.providerEventId, providerEventId),
        eq(webhookEvents.status, 'dead_lettered'),
      ),
    )
    .returning({ id: webhookEvents.id });

  if (reset.length === 0) {
    return { status: 'ignored', reason: 'not in the dead-letter queue' };
  }
  return processEvent(providerEventId, provider);
}

export interface EventThroughput {
  received: number;
  processed: number;
  failed: number;
  deadLettered: number;
  lastHour: number;
  oldestUnprocessed: Date | null;
}

export async function eventThroughput(): Promise<EventThroughput> {
  const db = await getDatabase();
  const byStatus = toRows<{ status: string; count: number }>(
    await db.execute(sql`select status, count(*)::int as count from webhook_events group by status`),
  );
  const recent = firstRow<{ count: number }>(
    await db.execute(sql`
      select count(*)::int as count from webhook_events
      where received_at > now() - interval '1 hour'
    `),
  );
  const oldest = await db
    .select({ receivedAt: webhookEvents.receivedAt })
    .from(webhookEvents)
    .where(eq(webhookEvents.status, 'received'))
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(1);

  const count = (status: string): number =>
    byStatus.find((row) => row.status === status)?.count ?? 0;

  return {
    received: count('received'),
    processed: count('processed'),
    failed: count('failed'),
    deadLettered: count('dead_lettered'),
    lastHour: recent?.count ?? 0,
    oldestUnprocessed: oldest[0]?.receivedAt ?? null,
  };
}

/** Subscriptions with a resolvable owner, for the dashboard. */
export async function listSubscriptions(limit = 100) {
  const db = await getDatabase();
  return db
    .select({
      providerId: subscriptions.providerId,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      lastEventAt: subscriptions.lastEventAt,
      email: users.email,
      variantSku: productVariants.sku,
    })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .innerJoin(productVariants, eq(productVariants.id, subscriptions.variantId))
    .where(isNotNull(subscriptions.providerId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(limit);
}
