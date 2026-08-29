import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
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
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set
 * on the project. The check is constant-time and, when no secret is
 * configured, the endpoint is refused outright rather than left open — an
 * unprotected endpoint that walks the whole subscription table is a free
 * amplification primitive for anyone who finds the URL.
 *
 * The one exception is a non-production build, where there is no secret to
 * configure and the e2e suite needs to call it.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';

  const header = request.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const presented = Buffer.from(header);
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
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
