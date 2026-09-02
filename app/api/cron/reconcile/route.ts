import { NextResponse } from 'next/server';
import { isScheduler } from '@/lib/cron-auth';
import { getSubscriptionProvider } from '@/lib/sync/provider';
import { reconcile } from '@/lib/sync/reconcile';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Reconciliation walks every subscription; it is not a 10-second job at scale. */
export const maxDuration = 60;

/**
 * Nightly reconciliation, triggered by Vercel Cron.
 *
 * Authorisation is shared with the other scheduled routes in
 * `lib/cron-auth.ts` — three copies of a constant-time bearer check is three
 * places for one of them to be subtly wrong.
 */

export async function GET(request: Request): Promise<NextResponse> {
  if (!isScheduler(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const log = requestLogger(requestIdFrom(request.headers));
  const report = await reconcile(getSubscriptionProvider());

  // Logged at warn when anything drifted: this is the alert. A findings count
  // of zero is worth an info line too, because silence is indistinguishable
  // from a cron that stopped running.
  const summary = {
    provider: report.provider,
    checked: report.checked,
    findings: report.findings.length,
    tookMs: report.tookMs,
  };
  if (report.findings.length > 0) {
    log.warn({ ...summary, kinds: report.findings.map((f) => f.kind) }, 'reconciliation found drift');
  } else {
    log.info(summary, 'reconciliation clean');
  }

  return NextResponse.json({
    ranAt: report.ranAt.toISOString(),
    provider: report.provider,
    providerActive: report.providerActive,
    locallyActive: report.locallyActive,
    checked: report.checked,
    tookMs: report.tookMs,
    findings: report.findings,
  });
}
