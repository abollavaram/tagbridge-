import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import { recordEvent, processEvent } from './events';
import { pushToErp } from './erp';
import { simulatedProvider, type ProviderSubscription } from './provider';

/**
 * The demo harness.
 *
 * The spec asks for a "break sync" button — a way to put the system into the
 * exact state the reconciler is supposed to catch, and then watch it get
 * caught. That is worth building carefully rather than faking: nothing here
 * writes a drift flag directly. Breaking sync changes the *provider's* state
 * behind the app's back, which is precisely what a missed webhook does in
 * production, and then the ordinary reconciler finds it on its own.
 */

const DEMO_SUBSCRIPTIONS = [
  { suffix: '1001', email: 'buyer@example.com', status: 'active' as const },
  { suffix: '1002', email: 'buyer@example.com', status: 'active' as const },
  { suffix: '1003', email: 'sales@example.com', status: 'trialing' as const },
];

export interface SeedResult {
  subscriptions: number;
  erpRecords: number;
  eventsApplied: number;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/**
 * Puts the demo into a known-good state: provider, database and ERP agreeing.
 *
 * Subscriptions reach the database the same way a real one would — through a
 * recorded event and a provider re-read — so the seeded state is produced by
 * the code under test rather than written around it.
 */
export async function seedSyncDemo(): Promise<SeedResult> {
  const db = await getDatabase();
  const provider = simulatedProvider();
  provider.clear();

  const variants = toRows<{ sku: string }>(
    await db.execute(sql`
      select v.sku from product_variants v
      join products p on p.id = v.product_id
      where p.license_type = 'subscription'
      order by v.sku
      limit ${DEMO_SUBSCRIPTIONS.length}
    `),
  );
  if (variants.length === 0) return { subscriptions: 0, erpRecords: 0, eventsApplied: 0 };

  let applied = 0;
  let erpRecords = 0;

  for (const [index, demo] of DEMO_SUBSCRIPTIONS.entries()) {
    const variant = variants[index % variants.length];
    if (!variant) continue;

    const id = `sub_demo_${demo.suffix}`;
    const subscription: ProviderSubscription = {
      id,
      status: demo.status,
      currentPeriodEnd: daysFromNow(30),
      variantSku: variant.sku,
      customerEmail: demo.email,
      updatedAt: new Date(),
    };
    provider.upsert(subscription);

    const occurredAt = new Date(Date.now() - (DEMO_SUBSCRIPTIONS.length - index) * 60_000);
    await recordEvent({
      id: `evt_demo_${demo.suffix}`,
      type: 'customer.subscription.created',
      createdAt: occurredAt,
      payload: { data: { object: { id } } },
    });
    const outcome = await processEvent(`evt_demo_${demo.suffix}`, provider);
    if (outcome.status === 'applied') {
      applied += 1;
      const push = await pushToErp(id);
      if (push !== 'no_such_subscription') erpRecords += 1;
    }
  }

  return { subscriptions: provider.size(), erpRecords, eventsApplied: applied };
}

export type BreakKind = 'cancelled_upstream' | 'status_changed' | 'billed_but_unknown';

export interface BreakResult {
  kind: BreakKind;
  providerId: string;
  description: string;
}

/**
 * Breaks sync in one of the three ways it breaks in production.
 *
 * Each one simulates a webhook that never arrived, which is why none of them
 * touches the database: the app is left believing what it last heard, exactly
 * as it would be after a dropped delivery.
 */
export async function breakSync(kind: BreakKind): Promise<BreakResult | null> {
  const provider = simulatedProvider();
  const db = await getDatabase();

  const known = toRows<{ provider_id: string }>(
    await db.execute(sql`
      select s.provider_id from subscriptions s
      join erp_sync_records e on e.subscription_id = s.id
      where e.state = 'synced'
      order by s.provider_id
      limit 3
    `),
  );

  if (kind === 'billed_but_unknown') {
    // A subscription created directly in the provider's dashboard. The app
    // never saw an event for it and has no row at all.
    const id = `sub_demo_${Date.now().toString().slice(-4)}`;
    const variant = toRows<{ sku: string }>(
      await db.execute(sql`select sku from product_variants order by sku limit 1`),
    )[0];
    if (!variant) return null;
    provider.upsert({
      id,
      status: 'active',
      currentPeriodEnd: daysFromNow(30),
      variantSku: variant.sku,
      customerEmail: 'buyer@example.com',
      updatedAt: new Date(),
    });
    return {
      kind,
      providerId: id,
      description: 'created a subscription at the provider that no webhook announced',
    };
  }

  const target = known[0]?.provider_id;
  if (!target) return null;

  if (kind === 'cancelled_upstream') {
    provider.mutateSilently(target, { status: 'canceled' });
    return {
      kind,
      providerId: target,
      description: 'cancelled it at the provider without delivering the event',
    };
  }

  provider.mutateSilently(target, { status: 'past_due' });
  return {
    kind,
    providerId: target,
    description: 'moved it to past_due at the provider without delivering the event',
  };
}
