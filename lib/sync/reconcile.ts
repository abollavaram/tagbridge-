import { eq, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import { auditLog, erpSyncRecords } from '@/lib/db/schema';
import { LIVE_PROVIDER_STATUSES } from './provider';
import type { ProviderSubscription, SubscriptionProvider } from './provider';

/**
 * Nightly reconciliation.
 *
 * Webhooks are lossy in ways that are invisible from inside the app: a
 * delivery is dropped, an endpoint is down for an hour, an event is
 * dead-lettered and never replayed, or someone changes a subscription
 * directly in the provider's dashboard. Each of those leaves the database
 * quietly wrong, and no amount of careful webhook handling detects it —
 * the missing signal is the problem.
 *
 * So the reconciler does not trust the event stream at all. It lists what
 * the provider currently considers live, lists what the ERP believes it has
 * synced, and reports every place the two disagree. It reads and flags; it
 * does not repair. An automatic repair against a provider that was itself
 * mid-incident is how one bad hour becomes a bad week, and the entitlement
 * a customer is billed for is not something to guess at unattended.
 */

export type DriftKind =
  | 'missing_in_erp'
  | 'stale_in_erp'
  | 'status_mismatch'
  | 'unknown_locally';

export interface DriftFinding {
  kind: DriftKind;
  providerId: string;
  detail: string;
  subscriptionId: string | null;
}

export interface ReconciliationReport {
  ranAt: Date;
  provider: string;
  providerActive: number;
  locallyActive: number;
  checked: number;
  findings: DriftFinding[];
  tookMs: number;
}

// The same set the provider filters on. Two definitions drifting apart is what
// made trialing and past-due subscriptions look like drift when they were fine.
const LIVE_STATUSES: ReadonlySet<string> = LIVE_PROVIDER_STATUSES;

interface LocalRow {
  subscription_id: string;
  provider_id: string;
  status: string;
  erp_id: string | null;
  erp_state: string | null;
  erp_ref: string | null;
  last_synced_at: Date | null;
}

/**
 * Whether the ERP has actually provisioned this subscription.
 *
 * Deliberately derived from push-time facts — the record exists, a push
 * succeeded, the push did not fail — and never from `state` or
 * `drift_detected`, which are this function's own outputs from the last run.
 *
 * Reading its own writes was a real bug: the first run marked a record
 * `drifted`, the second run no longer saw `state = 'synced'`, decided there
 * was nothing wrong, and cleared the flag. A standing problem healed itself on
 * the dashboard every night without anybody fixing it. Idempotence here is not
 * tidiness, it is the difference between an alert and a blindfold.
 */
function provisioned(row: LocalRow): boolean {
  return row.erp_id !== null && row.last_synced_at !== null && row.erp_state !== 'failed';
}

export async function reconcile(provider: SubscriptionProvider): Promise<ReconciliationReport> {
  const startedAt = Date.now();
  const db = await getDatabase();

  const remote: ProviderSubscription[] = await provider.listActiveSubscriptions();
  const remoteById = new Map(remote.map((s) => [s.id, s]));

  const local = toRows<LocalRow>(
    await db.execute(sql`
      select
        s.id as subscription_id,
        s.provider_id,
        s.status::text as status,
        e.id as erp_id,
        e.state::text as erp_state,
        e.erp_ref,
        e.last_synced_at
      from subscriptions s
      left join erp_sync_records e on e.subscription_id = s.id
    `),
  );
  const localById = new Map(local.map((row) => [row.provider_id, row]));

  const findings: DriftFinding[] = [];

  // Direction one: the provider is billing for something the ERP has not
  // recorded. This is the expensive kind — a customer is paying and the
  // entitlement never reached the system that grants it.
  for (const subscription of remote) {
    const row = localById.get(subscription.id);
    if (!row) {
      findings.push({
        kind: 'unknown_locally',
        providerId: subscription.id,
        subscriptionId: null,
        detail: `provider bills ${subscription.id} but it has no local subscription row`,
      });
      continue;
    }
    if (row.status !== subscription.status) {
      findings.push({
        kind: 'status_mismatch',
        providerId: subscription.id,
        subscriptionId: row.subscription_id,
        detail: `provider says ${subscription.status}, database says ${row.status}`,
      });
    }
    if (!provisioned(row)) {
      findings.push({
        kind: 'missing_in_erp',
        providerId: subscription.id,
        subscriptionId: row.subscription_id,
        detail: row.erp_id
          ? `ERP record exists but was never successfully pushed (state ${row.erp_state})`
          : 'no ERP record exists for an actively billed subscription',
      });
    }
  }

  // Direction two: the ERP is provisioning something the provider stopped
  // billing for. Cheaper to be wrong about, but it is revenue leaking.
  for (const row of local) {
    if (remoteById.has(row.provider_id)) continue;
    if (provisioned(row) && LIVE_STATUSES.has(row.status)) {
      findings.push({
        kind: 'stale_in_erp',
        providerId: row.provider_id,
        subscriptionId: row.subscription_id,
        detail: `ERP has it synced and the database says ${row.status}, but the provider no longer lists it as live`,
      });
    }
  }

  await flagDrift(findings, local);

  const report: ReconciliationReport = {
    ranAt: new Date(),
    provider: provider.name,
    providerActive: remote.length,
    locallyActive: local.filter((row) => LIVE_STATUSES.has(row.status)).length,
    checked: new Set([...remoteById.keys(), ...localById.keys()]).size,
    findings,
    tookMs: Date.now() - startedAt,
  };

  await db.insert(auditLog).values({
    actor: 'system:reconciliation',
    action: 'sync.reconcile',
    resource: 'subscriptions',
    before: null,
    after: {
      provider: report.provider,
      checked: report.checked,
      findings: report.findings.length,
      kinds: report.findings.map((f) => f.kind),
    },
  });

  return report;
}

/**
 * Writes the verdict back onto the ERP records.
 *
 * Clearing the flag matters as much as setting it: a drift that was fixed but
 * still shows red trains everyone to ignore the dashboard, which is worse than
 * not having one.
 */
async function flagDrift(findings: DriftFinding[], local: LocalRow[]): Promise<void> {
  const db = await getDatabase();
  const drifted = new Map<string, DriftFinding>();
  for (const finding of findings) {
    if (finding.subscriptionId && !drifted.has(finding.subscriptionId)) {
      drifted.set(finding.subscriptionId, finding);
    }
  }

  const now = new Date();
  for (const [subscriptionId, finding] of drifted) {
    await db
      .update(erpSyncRecords)
      .set({
        driftDetected: true,
        driftReason: `${finding.kind}: ${finding.detail}`,
        driftDetectedAt: now,
        state: 'drifted',
      })
      .where(eq(erpSyncRecords.subscriptionId, subscriptionId));
  }

  for (const row of local) {
    if (!row.erp_id || drifted.has(row.subscription_id)) continue;
    await db
      .update(erpSyncRecords)
      .set({
        driftDetected: false,
        driftReason: null,
        driftDetectedAt: null,
        state: row.erp_state === 'drifted' ? 'synced' : (row.erp_state as 'synced' | 'pending' | 'failed'),
      })
      .where(eq(erpSyncRecords.subscriptionId, row.subscription_id));
  }
}

export interface DriftRow {
  providerId: string;
  erpRef: string;
  state: string;
  driftReason: string | null;
  driftDetectedAt: Date | null;
  lastSyncedAt: Date | null;
}

export async function currentDrift(): Promise<DriftRow[]> {
  const db = await getDatabase();
  return toRows<DriftRow>(
    await db.execute(sql`
      select
        s.provider_id as "providerId",
        e.erp_ref as "erpRef",
        e.state::text as state,
        e.drift_reason as "driftReason",
        e.drift_detected_at as "driftDetectedAt",
        e.last_synced_at as "lastSyncedAt"
      from erp_sync_records e
      join subscriptions s on s.id = e.subscription_id
      where e.drift_detected
      order by e.drift_detected_at desc nulls last
    `),
  );
}

export async function syncCounts(): Promise<{ total: number; synced: number; drifted: number }> {
  const db = await getDatabase();
  const rows = toRows<{ state: string; count: number }>(
    await db.execute(
      sql`select state::text as state, count(*)::int as count from erp_sync_records group by state`,
    ),
  );
  const of = (state: string): number => rows.find((r) => r.state === state)?.count ?? 0;
  return {
    total: rows.reduce((sum, r) => sum + r.count, 0),
    synced: of('synced'),
    drifted: of('drifted'),
  };
}
