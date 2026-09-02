import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { firstRow } from '@/lib/db/rows';
import { erpSyncRecords } from '@/lib/db/schema';

/**
 * The ERP side of the sync.
 *
 * A connectivity vendor's entitlements do not live in the billing provider —
 * they live in whatever system issues licences, and that system is usually old,
 * slow, and reachable only in batch. Modelling it as its own record with its
 * own state is the point: the interesting failures all happen in the gap
 * between "the customer was billed" and "the licence was issued", and a design
 * that treats those as one fact cannot represent that gap at all.
 */

/** Deterministic so a re-push is recognisably the same record, not a new one. */
export function erpReference(providerId: string): string {
  const digits = providerId.replace(/\D/g, '').slice(-6).padStart(6, '0');
  return `ERP-${digits}`;
}

export type PushOutcome = 'created' | 'updated' | 'no_such_subscription';

/** Records that a subscription has been pushed to the ERP and accepted. */
export async function pushToErp(providerId: string): Promise<PushOutcome> {
  const db = await getDatabase();
  const subscription = firstRow<{ id: string }>(
    await db.execute(sql`select id from subscriptions where provider_id = ${providerId} limit 1`),
  );
  if (!subscription) return 'no_such_subscription';

  const inserted = await db
    .insert(erpSyncRecords)
    .values({
      subscriptionId: subscription.id,
      erpRef: erpReference(providerId),
      lastSyncedAt: new Date(),
      state: 'synced',
      driftDetected: false,
      driftReason: null,
      driftDetectedAt: null,
    })
    .onConflictDoUpdate({
      target: erpSyncRecords.subscriptionId,
      set: {
        erpRef: erpReference(providerId),
        lastSyncedAt: new Date(),
        state: 'synced',
        driftDetected: false,
        driftReason: null,
        driftDetectedAt: null,
      },
    })
    .returning({ id: erpSyncRecords.id });

  return inserted.length > 0 ? 'created' : 'updated';
}

export async function erpRecordFor(providerId: string) {
  const db = await getDatabase();
  const subscription = firstRow<{ id: string }>(
    await db.execute(sql`select id from subscriptions where provider_id = ${providerId} limit 1`),
  );
  if (!subscription) return null;
  const rows = await db
    .select()
    .from(erpSyncRecords)
    .where(eq(erpSyncRecords.subscriptionId, subscription.id))
    .limit(1);
  return rows[0] ?? null;
}
