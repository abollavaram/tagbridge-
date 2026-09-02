'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/guards';
import { breakSync, seedSyncDemo, type BreakKind } from '@/lib/sync/demo';
import { deadLetterQueue, replayDeadLettered, retryableEvents, processEvent } from '@/lib/sync/events';
import { getSubscriptionProvider } from '@/lib/sync/provider';
import { reconcile } from '@/lib/sync/reconcile';

/**
 * Dashboard actions.
 *
 * Every one re-checks `requireAdmin` first. Middleware already gates the route
 * and the page already checked, but a server action is its own HTTP endpoint —
 * it is reachable with a crafted request that never rendered the page, so a
 * page-level check protects the view and nothing else.
 */

const BREAK_KINDS: ReadonlySet<string> = new Set([
  'cancelled_upstream',
  'status_changed',
  'billed_but_unknown',
]);

export async function seedDemoAction(): Promise<void> {
  await requireAdmin('/admin/sync');
  const result = await seedSyncDemo();
  revalidatePath('/admin/sync');
  if (result.eventsApplied === 0) {
    notice('Could not seed: no subscription-licensed variants are in the catalogue.');
  }
}

/** Failures reach the operator instead of re-rendering the page unchanged. */
function notice(message: string): never {
  redirect(`/admin/sync?notice=${encodeURIComponent(message)}`);
}

export async function breakSyncAction(formData: FormData): Promise<void> {
  await requireAdmin('/admin/sync');
  const raw = formData.get('kind');
  const kind = typeof raw === 'string' && BREAK_KINDS.has(raw) ? (raw as BreakKind) : null;
  // Used to `return` here: nothing happened and nothing said so.
  if (!kind) notice('That is not a break I know how to simulate.');
  const broken = await breakSync(kind);
  if (!broken) notice('Nothing to break yet — seed the demo subscriptions first.');
  revalidatePath('/admin/sync');
}

export async function reconcileAction(): Promise<void> {
  await requireAdmin('/admin/sync');
  await reconcile(getSubscriptionProvider());
  revalidatePath('/admin/sync');
}

export async function replayAction(formData: FormData): Promise<void> {
  await requireAdmin('/admin/sync');
  const id = formData.get('providerEventId');
  if (typeof id !== 'string' || id.length === 0) notice('No event was named to replay.');
  const outcome = await replayDeadLettered(id, getSubscriptionProvider());
  revalidatePath('/admin/sync');
  if (outcome.status === 'ignored') notice(`Nothing replayed: ${outcome.reason}.`);
}

/** Drains everything still retryable, which is what a backoff worker would do. */
export async function drainRetriesAction(): Promise<void> {
  await requireAdmin('/admin/sync');
  const provider = getSubscriptionProvider();
  for (const event of await retryableEvents()) {
    await processEvent(event.providerEventId, provider);
  }
  revalidatePath('/admin/sync');
}

export async function replayAllDeadLetteredAction(): Promise<void> {
  await requireAdmin('/admin/sync');
  const provider = getSubscriptionProvider();
  for (const event of await deadLetterQueue()) {
    await replayDeadLettered(event.providerEventId, provider);
  }
  revalidatePath('/admin/sync');
}
