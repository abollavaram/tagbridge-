import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Type-only, so it is erased and does not load the module before the
// DATABASE_URL deletion below takes effect.
import type { ProviderSubscription } from '@/lib/sync/provider';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { firstRow, toRows } = await import('@/lib/db/rows');
const { auditLog, erpSyncRecords, orderItems, orders, subscriptions, webhookEvents } =
  await import('@/lib/db/schema');
const {
  MAX_ATTEMPTS,
  deadLetterQueue,
  eventThroughput,
  processEvent,
  recordEvent,
  replayDeadLettered,
  retryableEvents,
} = await import('@/lib/sync/events');
const { pushToErp, erpRecordFor } = await import('@/lib/sync/erp');
const { SimulatedProvider, simulatedProvider } = await import('@/lib/sync/provider');
const { reconcile, currentDrift } = await import('@/lib/sync/reconcile');
const { breakSync, seedSyncDemo } = await import('@/lib/sync/demo');

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;
let variantSku: string;
let variantId: string;

/** A provider that always throws, for exercising the retry path. */
class FailingProvider extends SimulatedProvider {
  constructor(private readonly message = 'provider unreachable') {
    super();
  }
  override fetchSubscription(): Promise<ProviderSubscription | null> {
    return Promise.reject(new Error(this.message));
  }
}

function subscriptionEvent(
  id: string,
  subscriptionId: string,
  occurredAt: Date,
  type = 'customer.subscription.updated',
) {
  return {
    id,
    type,
    createdAt: occurredAt,
    payload: { id, type, data: { object: { id: subscriptionId } } },
  };
}

function provider(sku: string, overrides: Partial<ProviderSubscription> = {}) {
  const p = new SimulatedProvider();
  p.upsert({
    id: 'sub_test_1',
    status: 'active',
    currentPeriodEnd: new Date('2027-01-01T00:00:00Z'),
    variantSku: sku,
    customerEmail: 'buyer@example.com',
    updatedAt: new Date(),
    ...overrides,
  });
  return p;
}

beforeAll(async () => {
  db = await getDatabase();
  const row = firstRow<{ sku: string }>(
    await db.execute(sql`select sku from product_variants order by sku limit 1`),
  );
  variantSku = row?.sku ?? '';
  expect(variantSku).not.toBe('');
  variantId =
    firstRow<{ id: string }>(
      await db.execute(sql`select id from product_variants order by sku limit 1`),
    )?.id ?? '';
}, 180_000);

beforeEach(async () => {
  await db.delete(erpSyncRecords);
  await db.delete(subscriptions);
  await db.delete(webhookEvents);
  await db.delete(orderItems);
  await db.delete(orders);
  await db.delete(auditLog);
  simulatedProvider().clear();
});

describe('idempotency', () => {
  it('records the same event three times as exactly one row', async () => {
    const event = subscriptionEvent('evt_dup', 'sub_test_1', new Date());

    const outcomes = [
      await recordEvent(event),
      await recordEvent(event),
      await recordEvent(event),
    ];

    expect(outcomes).toEqual(['recorded', 'duplicate', 'duplicate']);
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, 'evt_dup'));
    expect(rows).toHaveLength(1);
  });

  it('holds even when the deliveries arrive concurrently', async () => {
    const event = subscriptionEvent('evt_race', 'sub_test_1', new Date());
    const outcomes = await Promise.all([
      recordEvent(event),
      recordEvent(event),
      recordEvent(event),
      recordEvent(event),
      recordEvent(event),
    ]);

    expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, 'evt_race'));
    expect(rows).toHaveLength(1);
  });

  it('applies a subscription once however many times the event is processed', async () => {
    const p = provider(variantSku);
    await recordEvent(subscriptionEvent('evt_a', 'sub_test_1', new Date()));

    await processEvent('evt_a', p);
    await processEvent('evt_a', p);

    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(1);
  });

  it('keeps distinct events distinct', async () => {
    await recordEvent(subscriptionEvent('evt_one', 'sub_test_1', new Date()));
    await recordEvent(subscriptionEvent('evt_two', 'sub_test_1', new Date()));
    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(2);
  });
});

describe('the webhook is a trigger, never truth', () => {
  it('writes the provider state, not the state the payload claimed', async () => {
    const p = provider(variantSku, { status: 'past_due' });
    // A payload asserting something entirely different from the provider.
    await recordEvent({
      id: 'evt_lie',
      type: 'customer.subscription.updated',
      createdAt: new Date(),
      payload: { data: { object: { id: 'sub_test_1', status: 'active' } } },
    });

    await processEvent('evt_lie', p);

    const row = firstRow<{ status: string }>(
      await db.execute(sql`select status::text as status from subscriptions limit 1`),
    );
    expect(row?.status).toBe('past_due');
  });

  it('ignores an event for a subscription the provider does not have', async () => {
    const p = new SimulatedProvider();
    await recordEvent(subscriptionEvent('evt_ghost', 'sub_missing', new Date()));

    const outcome = await processEvent('evt_ghost', p);

    expect(outcome.status).toBe('ignored');
    expect(await db.select().from(subscriptions)).toHaveLength(0);
  });

  it('settles an unhandled event type instead of dead-lettering it', async () => {
    await recordEvent({
      id: 'evt_unrelated',
      type: 'payment_intent.succeeded',
      createdAt: new Date(),
      payload: { data: { object: { id: 'pi_1' } } },
    });

    const outcome = await processEvent('evt_unrelated', new SimulatedProvider());

    expect(outcome).toMatchObject({ status: 'ignored' });
    const row = firstRow<{ status: string }>(
      await db.execute(
        sql`select status::text as status from webhook_events where provider_event_id = 'evt_unrelated'`,
      ),
    );
    expect(row?.status).toBe('processed');
  });
});

describe('out-of-order events', () => {
  it('resolves on the event timestamp rather than arrival order', async () => {
    const earlier = new Date('2026-03-01T10:00:00Z');
    const later = new Date('2026-03-01T11:00:00Z');

    const p = provider(variantSku, { status: 'active' });
    await recordEvent(subscriptionEvent('evt_later', 'sub_test_1', later));
    await processEvent('evt_later', p);

    // The older event now arrives, and the provider has since been cancelled.
    // Applying it would write `canceled` over the newer `active`.
    p.mutateSilently('sub_test_1', { status: 'canceled' });
    await recordEvent(subscriptionEvent('evt_earlier', 'sub_test_1', earlier));
    const outcome = await processEvent('evt_earlier', p);

    expect(outcome.status).toBe('superseded');
    const row = firstRow<{ status: string }>(
      await db.execute(sql`select status::text as status from subscriptions limit 1`),
    );
    expect(row?.status).toBe('active');
  });

  it('applies a newer event that arrives after an older one', async () => {
    const earlier = new Date('2026-03-01T10:00:00Z');
    const later = new Date('2026-03-01T11:00:00Z');
    const p = provider(variantSku, { status: 'active' });

    await recordEvent(subscriptionEvent('evt_1', 'sub_test_1', earlier));
    await processEvent('evt_1', p);

    p.mutateSilently('sub_test_1', { status: 'canceled' });
    await recordEvent(subscriptionEvent('evt_2', 'sub_test_1', later));
    const outcome = await processEvent('evt_2', p);

    expect(outcome.status).toBe('applied');
    const row = firstRow<{ status: string }>(
      await db.execute(sql`select status::text as status from subscriptions limit 1`),
    );
    expect(row?.status).toBe('canceled');
  });

  it('treats an event with the same timestamp as already applied', async () => {
    const at = new Date('2026-03-01T10:00:00Z');
    const p = provider(variantSku);
    await recordEvent(subscriptionEvent('evt_x', 'sub_test_1', at));
    await processEvent('evt_x', p);

    await recordEvent(subscriptionEvent('evt_y', 'sub_test_1', at));
    expect((await processEvent('evt_y', p)).status).toBe('superseded');
  });

  it('records the applied event time so ordering survives a restart', async () => {
    const at = new Date('2026-03-01T10:00:00Z');
    const p = provider(variantSku);
    await recordEvent(subscriptionEvent('evt_z', 'sub_test_1', at));
    await processEvent('evt_z', p);

    const row = (await db.select().from(subscriptions))[0];
    expect(row?.lastEventAt?.toISOString()).toBe(at.toISOString());
  });
});

describe('retries and the dead-letter queue', () => {
  it('retries a provider failure with a growing backoff', async () => {
    await recordEvent(subscriptionEvent('evt_fail', 'sub_test_1', new Date()));
    const p = new FailingProvider();

    const first = await processEvent('evt_fail', p);
    const second = await processEvent('evt_fail', p);

    expect(first).toMatchObject({ status: 'retry', attempts: 1 });
    expect(second).toMatchObject({ status: 'retry', attempts: 2 });
    if (first.status === 'retry' && second.status === 'retry') {
      expect(second.nextAttemptInMs).toBeGreaterThan(first.nextAttemptInMs);
    }
  });

  it('dead-letters after exactly five attempts', async () => {
    await recordEvent(subscriptionEvent('evt_dead', 'sub_test_1', new Date()));
    const p = new FailingProvider('upstream 503');

    const outcomes = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      outcomes.push(await processEvent('evt_dead', p));
    }

    expect(outcomes.slice(0, MAX_ATTEMPTS - 1).every((o) => o.status === 'retry')).toBe(true);
    expect(outcomes[MAX_ATTEMPTS - 1]).toMatchObject({
      status: 'dead_lettered',
      attempts: MAX_ATTEMPTS,
    });
  });

  it('keeps the failure reason so an operator can act on it', async () => {
    await recordEvent(subscriptionEvent('evt_why', 'sub_test_1', new Date()));
    await processEvent('evt_why', new FailingProvider('upstream 503'));

    const row = firstRow<{ last_error: string }>(
      await db.execute(
        sql`select last_error from webhook_events where provider_event_id = 'evt_why'`,
      ),
    );
    expect(row?.last_error).toContain('503');
  });

  it('lists a failed event as retryable until it is dead-lettered', async () => {
    await recordEvent(subscriptionEvent('evt_retryable', 'sub_test_1', new Date()));
    await processEvent('evt_retryable', new FailingProvider());

    const retryable = await retryableEvents();
    expect(retryable.map((e) => e.providerEventId)).toContain('evt_retryable');
  });

  it('stops listing it as retryable once dead-lettered', async () => {
    await recordEvent(subscriptionEvent('evt_gone', 'sub_test_1', new Date()));
    const p = new FailingProvider();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await processEvent('evt_gone', p);

    expect((await retryableEvents()).map((e) => e.providerEventId)).not.toContain('evt_gone');
    expect((await deadLetterQueue()).map((e) => e.providerEventId)).toContain('evt_gone');
  });

  it('replays a dead-lettered event successfully once the provider recovers', async () => {
    await recordEvent(subscriptionEvent('evt_replay', 'sub_test_1', new Date()));
    const broken = new FailingProvider();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await processEvent('evt_replay', broken);
    expect(await db.select().from(subscriptions)).toHaveLength(0);

    const outcome = await replayDeadLettered('evt_replay', provider(variantSku));

    expect(outcome).toMatchObject({ status: 'applied' });
    expect(await db.select().from(subscriptions)).toHaveLength(1);
    expect(await deadLetterQueue()).toHaveLength(0);
  });

  it('resets the attempt budget on replay, so one retry does not re-exhaust it', async () => {
    await recordEvent(subscriptionEvent('evt_budget', 'sub_test_1', new Date()));
    const broken = new FailingProvider();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await processEvent('evt_budget', broken);

    const outcome = await replayDeadLettered('evt_budget', broken);

    expect(outcome).toMatchObject({ status: 'retry', attempts: 1 });
  });

  it('refuses to replay an event that is not dead-lettered', async () => {
    await recordEvent(subscriptionEvent('evt_live', 'sub_test_1', new Date()));
    const outcome = await replayDeadLettered('evt_live', provider(variantSku));
    expect(outcome).toMatchObject({ status: 'ignored' });
  });

  it('counts the queue depth for the dashboard', async () => {
    await recordEvent(subscriptionEvent('evt_c1', 'sub_test_1', new Date()));
    const p = new FailingProvider();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await processEvent('evt_c1', p);

    const throughput = await eventThroughput();
    expect(throughput.deadLettered).toBe(1);
  });
});

describe('reconciliation detects drift', () => {
  async function inSync() {
    const p = provider(variantSku);
    await recordEvent(subscriptionEvent('evt_sync', 'sub_test_1', new Date()));
    await processEvent('evt_sync', p);
    await pushToErp('sub_test_1');
    return p;
  }

  it('reports nothing when the provider, database and ERP agree', async () => {
    const p = await inSync();
    const report = await reconcile(p);
    expect(report.findings).toEqual([]);
  });

  it('finds a subscription the provider bills but the ERP never received', async () => {
    const p = provider(variantSku);
    await recordEvent(subscriptionEvent('evt_noerp', 'sub_test_1', new Date()));
    await processEvent('evt_noerp', p);
    // Deliberately no pushToErp.

    const report = await reconcile(p);

    expect(report.findings.map((f) => f.kind)).toContain('missing_in_erp');
  });

  it('finds a status the provider changed without delivering an event', async () => {
    const p = await inSync();
    p.mutateSilently('sub_test_1', { status: 'past_due' });

    const report = await reconcile(p);

    const mismatch = report.findings.find((f) => f.kind === 'status_mismatch');
    expect(mismatch?.detail).toContain('past_due');
  });

  it('finds an entitlement the ERP still provisions after the provider stopped billing', async () => {
    const p = await inSync();
    p.mutateSilently('sub_test_1', { status: 'canceled' });

    const report = await reconcile(p);

    expect(report.findings.map((f) => f.kind)).toContain('stale_in_erp');
  });

  it('finds a subscription created at the provider that the app never heard about', async () => {
    const p = await inSync();
    p.upsert({
      id: 'sub_dashboard_made',
      status: 'active',
      currentPeriodEnd: new Date('2027-01-01T00:00:00Z'),
      variantSku,
      customerEmail: 'buyer@example.com',
      updatedAt: new Date(),
    });

    const report = await reconcile(p);

    expect(report.findings.map((f) => f.kind)).toContain('unknown_locally');
  });

  it('writes the drift onto the ERP record with a reason', async () => {
    const p = await inSync();
    p.mutateSilently('sub_test_1', { status: 'canceled' });

    await reconcile(p);

    const record = await erpRecordFor('sub_test_1');
    expect(record?.driftDetected).toBe(true);
    expect(record?.state).toBe('drifted');
    expect(record?.driftReason).toBeTruthy();
  });

  it('clears the flag once the drift is resolved, so red always means red', async () => {
    const p = await inSync();
    p.mutateSilently('sub_test_1', { status: 'canceled' });
    await reconcile(p);
    expect(await currentDrift()).toHaveLength(1);

    // The operator fixes it: the provider is live again and the ERP re-pushed.
    p.mutateSilently('sub_test_1', { status: 'active' });
    await pushToErp('sub_test_1');
    await reconcile(p);

    expect(await currentDrift()).toEqual([]);
  });

  it('is safe to run twice without inventing new findings', async () => {
    const p = await inSync();
    p.mutateSilently('sub_test_1', { status: 'canceled' });

    const first = await reconcile(p);
    const second = await reconcile(p);

    expect(second.findings).toHaveLength(first.findings.length);
    expect(await currentDrift()).toHaveLength(1);
  });

  it('reports how much it checked, so an empty run is distinguishable from a broken one', async () => {
    const p = await inSync();
    const report = await reconcile(p);
    expect(report.checked).toBeGreaterThan(0);
    expect(report.provider).toBe('simulated');
  });
});

describe('the demo harness', () => {
  it('seeds a state where everything agrees', async () => {
    const result = await seedSyncDemo();
    expect(result.eventsApplied).toBeGreaterThan(0);

    const report = await reconcile(simulatedProvider());
    expect(report.findings).toEqual([]);
  });

  it('seeds through the real code path, leaving processed events behind', async () => {
    await seedSyncDemo();
    const rows = toRows<{ status: string }>(
      await db.execute(sql`select status::text as status from webhook_events`),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'processed')).toBe(true);
  });

  it('breaks sync without touching the database, and reconciliation catches it', async () => {
    await seedSyncDemo();
    const before = await db.select().from(subscriptions);

    const broken = await breakSync('cancelled_upstream');
    expect(broken).not.toBeNull();

    // Nothing local changed — that is the point of the simulation.
    const after = await db.select().from(subscriptions);
    expect(after.map((s) => s.status)).toEqual(before.map((s) => s.status));

    const report = await reconcile(simulatedProvider());
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('catches a silent status change', async () => {
    await seedSyncDemo();
    await breakSync('status_changed');
    const report = await reconcile(simulatedProvider());
    expect(report.findings.map((f) => f.kind)).toContain('status_mismatch');
  });

  it('catches a subscription created behind the app’s back', async () => {
    await seedSyncDemo();
    await breakSync('billed_but_unknown');
    const report = await reconcile(simulatedProvider());
    expect(report.findings.map((f) => f.kind)).toContain('unknown_locally');
  });
});

describe('card payments flow through the webhook (F-03)', () => {
  async function pendingOrder() {
    const { placeOrder } = await import('@/lib/commerce/orders');
    return placeOrder({
      lines: [{ variantId, qty: 2 }],
      email: 'buyer@example.com',
      paymentMethod: 'card',
    });
  }

  function paymentEvent(
    id: string,
    orderId: string,
    overrides: Record<string, unknown> = {},
    type = 'checkout.session.completed',
  ) {
    return {
      id,
      type,
      createdAt: new Date(),
      payload: {
        data: {
          object: {
            id: 'cs_live_1',
            client_reference_id: orderId,
            payment_status: 'paid',
            ...overrides,
          },
        },
      },
    };
  }

  it('marks the order paid', async () => {
    const order = await pendingOrder();
    await recordEvent(
      paymentEvent('evt_pay_1', order.id, { amount_total: order.subtotalCents }),
    );

    const outcome = await processEvent('evt_pay_1', new SimulatedProvider());

    expect(outcome.status).toBe('applied');
    const row = firstRow<{ status: string }>(
      await db.execute(
        sql`select status::text as status from orders where id = ${order.id}::uuid`,
      ),
    );
    expect(row?.status).toBe('paid');
  });

  it('was silently ignored before — the type is handled now', async () => {
    const order = await pendingOrder();
    await recordEvent(
      paymentEvent('evt_pay_2', order.id, { amount_total: order.subtotalCents }),
    );
    const outcome = await processEvent('evt_pay_2', new SimulatedProvider());
    // Used to be `ignored: unhandled type checkout.session.completed`.
    expect(outcome.status).not.toBe('ignored');
  });

  it('refuses a payment for the wrong amount and leaves it for an operator', async () => {
    const order = await pendingOrder();
    await recordEvent(paymentEvent('evt_pay_3', order.id, { amount_total: 100 }));

    const outcome = await processEvent('evt_pay_3', new SimulatedProvider());

    // Retryable on purpose: this lands in the dead-letter queue where someone
    // sees it, rather than being settled as though it were fine.
    expect(outcome.status).toBe('retry');
    const row = firstRow<{ status: string }>(
      await db.execute(
        sql`select status::text as status from orders where id = ${order.id}::uuid`,
      ),
    );
    expect(row?.status).toBe('pending_payment');
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'order.payment_mismatch')).toBe(true);
  });

  it('does not pay an order whose payment is still processing', async () => {
    const order = await pendingOrder();
    await recordEvent(
      paymentEvent('evt_pay_4', order.id, {
        payment_status: 'unpaid',
        amount_total: order.subtotalCents,
      }),
    );
    const outcome = await processEvent('evt_pay_4', new SimulatedProvider());
    expect(outcome.status).toBe('ignored');
  });

  it('cancels an order whose payment failed', async () => {
    const order = await pendingOrder();
    await recordEvent(
      paymentEvent('evt_pay_5', order.id, {}, 'checkout.session.async_payment_failed'),
    );
    await processEvent('evt_pay_5', new SimulatedProvider());

    const row = firstRow<{ status: string }>(
      await db.execute(
        sql`select status::text as status from orders where id = ${order.id}::uuid`,
      ),
    );
    expect(row?.status).toBe('cancelled');
  });
});
